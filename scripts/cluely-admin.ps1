# =============================================================================
#  cluely-admin.ps1 -- packaged one-click root mode for OpenCluely on Windows
#
#  What it is: the FRIEND-facing launcher that ships INSIDE the installer,
#  next to screen-reader-util.exe. Double-click "OpenCluely (Admin)" in the
#  Start Menu and it: seeds the root profile, copies your DeepSeek key from
#  the normal profile, hardens the trust boundary, and starts the app
#  elevated (Administrator token, High integrity) with ONE UAC click.
#
#  Usage (via the cluely-admin.cmd shim, never the .ps1 directly):
#    OpenCluely (Admin).cmd          # start root mode
#    OpenCluely (Admin).cmd stop     # stop the elevated instance
#
#  This file is the packaged subset of scripts/cluely.ps1. The developer
#  keeps the full doctor/status tooling in the repo; this copy has no
#  .depthengine or dev-path lookups and resolves everything relative to
#  the install directory. Reviewed logic (root seeding, key copy, icacls
#  two-step hardening, WMI-creation-time process ownership, marker-gated
#  boot evidence) is carried over verbatim.
# =============================================================================

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'help')]
  [string]$Command = 'start',
  [switch]$FromElevated
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Install layout: <install>\resources\launcher\cluely-admin.ps1 and
# <install>\screen-reader-util.exe -- so the install root is two levels up.
$InstallRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ExePath = Join-Path $InstallRoot 'screen-reader-util.exe'

# Paths (identical to scripts/cluely.ps1 so `cluely status` interoperates).
$RootData = 'C:\ProgramData\CluelyRoot'
$RootProfile = Join-Path $RootData 'userdata'
$PidFile = Join-Path $env:TEMP 'cluely-root.pid'
$BootLog = Join-Path $env:TEMP 'cluely-root-boot.log'
$BootErr = Join-Path $env:TEMP 'cluely-root-boot.err'
$NormalProfile = Join-Path $env:APPDATA 'screen-reader-util'
$NormalEnv = Join-Path $NormalProfile '.env'
$AppLog = Join-Path $env:USERPROFILE ('.screen-reader-util\logs\application-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')

function Write-Ok([string]$Msg)   { Write-Host ("[OK]   " + $Msg) }
function Write-Warn([string]$Msg) { Write-Host ("[WARN] " + $Msg) -ForegroundColor Yellow }
function Write-Fail([string]$Msg) { Write-Host ("[FAIL] " + $Msg) -ForegroundColor Red }
function Write-Info([string]$Msg) { Write-Host ("       " + $Msg) }

function Test-IsAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PidFileValue {
  if (-not (Test-Path $PidFile)) { return 0 }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw -match 'PID=(\d+)') { $raw = $Matches[1] }
  $n = 0
  if ([int]::TryParse($raw, [ref]$n)) { return $n }
  return 0
}

function Get-PidFileCreated {
  if (-not (Test-Path $PidFile)) { return '' }
  $line = Select-String -Path $PidFile -Pattern '^CREATED=(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value }
  return ''
}

function Get-PidFileStamp {
  if (-not (Test-Path $PidFile)) { return '' }
  $line = Select-String -Path $PidFile -Pattern '^STAMP=(cluely-root-[A-Za-z0-9-]+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value }
  return ''
}

function Get-ProcessCreatedWmi([int]$ProcessId) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
  if (-not $p) { return '' }
  $created = $p.CreationDate
  if ($created -is [datetime]) { return $created.ToUniversalTime().Ticks.ToString() }
  try {
    return ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created)).ToUniversalTime().Ticks.ToString()
  } catch {
    return ''
  }
}

# Exact ownership proof: process name match AND immutable WMI creation time.
function Test-PidFileOwnsProcess([int]$ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne 'screen-reader-util') { return $false }
  $created = Get-PidFileCreated
  if ($created -eq '') { return $false }
  $wmi = Get-ProcessCreatedWmi $ProcessId
  if ($wmi -eq '') { return $false }
  return $wmi -eq $created
}

function Get-RootStamp([int]$ProcessId) {
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
  if (-not $proc) { return '' }
  if ($proc.CommandLine -match '--cluely-root-run=([^\s"]+)') { return $Matches[1] }
  return ''
}

function Test-RootInstanceAlive {
  $pidValue = Get-PidFileValue
  if ($pidValue -le 0) { return $false }
  if (-not (Test-PidFileOwnsProcess $pidValue)) { return $false }
  if ((Get-RootStamp $pidValue) -ne '') { return $true }
  return @((Get-RootProcesses) | Where-Object {
    $parent = $_.PSObject.Properties['ParentProcessId']
    $parent -and $parent.Value -eq $pidValue
  }).Count -gt 0
}

function Get-RootProcesses {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue)
  $expectedProfile = 'C:\ProgramData\CluelyRoot\userdata'
  $profilePattern = '(?i)(?:^|\s)--user-data-dir=(?:"' + [regex]::Escape($expectedProfile) + '"|' + [regex]::Escape($expectedProfile) + ')(?=\s|$)'
  return @($all | Where-Object {
    $_.CommandLine -and ($_.CommandLine.Replace('\"', '"') -match $profilePattern)
  } | Sort-Object ProcessId -Unique)
}

function Read-AppLogTailFrom([long]$Offset) {
  if (-not (Test-Path $AppLog)) { return '' }
  $fs = [System.IO.File]::Open($AppLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $len = $fs.Length
    if ($len -le $Offset) { return '' }
    $fs.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buf = New-Object byte[] ($len - $Offset)
    $read = $fs.Read($buf, 0, $buf.Length)
    return [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
  } finally {
    $fs.Close()
  }
}

function Test-Marker([string]$Marker, [long]$AppLogOffset) {
  if ((Test-Path $BootLog) -and (Select-String -Path $BootLog -Pattern $Marker -Quiet -ErrorAction SilentlyContinue)) { return $true }
  $tail = Read-AppLogTailFrom $AppLogOffset
  if ($tail -match [regex]::Escape($Marker)) { return $true }
  return $false
}

function Clear-RootSingletonLocks {
  foreach ($name in @('SingletonLock', 'SingletonCookie', 'SingletonSocket')) {
    Remove-Item (Join-Path $RootProfile $name) -Force -ErrorAction SilentlyContinue
  }
}

function Write-Plan {
  Write-Host ''
  Write-Host 'You are up. Now:'
  Write-Info '1. Open your exam browser (Cluely is already first -- correct order).'
  Write-Info '2. On a question, press Ctrl+Shift+S (or the camera button in the chat header).'
  Write-Info '3. The answer lands in the Cluely chat.'
  Write-Info 'When done, close the app from its chat, or run "OpenCluely (Admin)" again and choose stop.'
  Write-Host ''
}

function Invoke-Start {
  $isAdmin = Test-IsAdmin

  if (-not (Test-Path $ExePath)) {
    Write-Fail ('Installed app not found: ' + $ExePath)
    Write-Info 'Reinstall OpenCluely and try again.'
    exit 1
  }

  if (Test-RootInstanceAlive) {
    $pidValue = Get-PidFileValue
    Write-Ok ('Cluely is already running elevated (PID ' + $pidValue + ') -- nothing to start.')
    Write-Host ''
    Write-Plan
    exit 0
  }
  $strays = @(Get-RootProcesses)
  if ($strays.Count -gt 0) {
    Write-Ok ('Cluely is already running elevated (' + $strays.Count + ' processes; pidfile missing).')
    exit 0
  }

  if (Test-Path $PidFile) {
    Write-Warn 'Stale pidfile found -- clearing it before launch.'
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  if (-not $isAdmin -and -not $FromElevated) {
    Write-Host ''
    Write-Info 'Requesting elevation (one UAC prompt -- click Yes) ...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), 'start', '-FromElevated')
    try {
      $elevated = Start-Process powershell -Verb RunAs -ArgumentList $argList -PassThru
    } catch {
      Write-Fail 'Elevation was canceled or failed (the UAC prompt was not accepted).'
      exit 1
    }
    $deadline = (Get-Date).AddSeconds(150)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      if (Get-Process -Id $elevated.Id -ErrorAction SilentlyContinue) { continue }
      $bootOk = (Test-Path $BootLog) -and (Select-String -Path $BootLog -Pattern 'Application initialized successfully' -Quiet -ErrorAction SilentlyContinue)
      $rootOk = (Test-Path $BootLog) -and (Select-String -Path $BootLog -Pattern 'Root exam mode active' -Quiet -ErrorAction SilentlyContinue)
      if ($bootOk -and $rootOk) { exit 0 }
      Write-Fail 'The elevated launch did not complete. Last log lines:'
      Get-Content $BootLog -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
      exit 1
    }
    Write-Fail 'Elevation timed out (150s) -- the UAC prompt was not answered or the launch stalled.'
    exit 1
  }

  if (-not $isAdmin) {
    Write-Fail 'Elevation was declined or failed -- Cluely cannot run root mode unelevated.'
    exit 1
  }

  # Elevated from here on.

  # Seed the root profile so the elevated instance starts with the operator's
  # current config. The API key travels in the process environment, never
  # into a machine-readable file.
  New-Item -ItemType Directory -Force -Path $RootProfile | Out-Null
  $rootEnv = Join-Path $RootProfile '.env'
  if (-not (Test-Path $rootEnv)) {
    @('AI_MODE=direct', 'LLM_PROVIDER=deepseek', 'SPEECH_PROVIDER=whisper', 'WHISPER_COMMAND=whisper', 'WHISPER_CAPTURE_MODE=manual', 'WHISPER_RESPONSE_TARGET=chat') |
      Set-Content -Path $rootEnv -Encoding ASCII
  }
  $env:CLUELY_ROOT_EXAM = '1'
  $env:AI_MODE = 'direct'
  $env:LLM_PROVIDER = 'deepseek'
  $env:SPEECH_PROVIDER = 'whisper'
  $env:WHISPER_COMMAND = 'whisper'
  $env:WHISPER_CAPTURE_MODE = 'manual'
  $env:WHISPER_RESPONSE_TARGET = 'chat'
  if (Test-Path $NormalEnv) {
    $keyLine = Select-String -Path $NormalEnv -Pattern '^\s*DEEPSEEK_API_KEY\s*=' | Select-Object -First 1
    if ($keyLine) {
      $value = ($keyLine.Line -split '=', 2)[1].Trim().Trim("'").Trim('"')
      if ($value.Length -gt 0) { $env:DEEPSEEK_API_KEY = $value }
    }
  } else {
    Write-Warn ('No DeepSeek key found in ' + $NormalEnv + ' -- paste your key in the app''s Settings first (one time), or answers will fail.')
  }

  Clear-RootSingletonLocks

  # Harden the root DATA dir (Administrators + SYSTEM only). The install
  # directory is deliberately NOT hardened: per-user installs must stay
  # writable so uninstall and future updates work without elevation.
  # (scripts/cluely.ps1 keeps its stronger install-dir hardening for the
  # developer machine's exam-integrity contract.)
  foreach ($target in @($RootData)) {
    cmd.exe /c ('icacls "' + $target + '" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" /T /C /Q >nul 2>&1') | Out-Null
    cmd.exe /c ('icacls "' + $target + '" /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q >nul 2>&1') | Out-Null
  }

  # Boot markers are byte-offset-gated on today's app log: only log bytes
  # appended after this launch can satisfy verification.
  $appLogOffset = 0L
  if (Test-Path $AppLog) { $appLogOffset = (Get-Item $AppLog).Length }

  Remove-Item $BootLog -Force -ErrorAction SilentlyContinue
  Remove-Item $BootErr -Force -ErrorAction SilentlyContinue

  $stamp = 'cluely-root-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Write-Info ('Launching Cluely elevated (stamp ' + $stamp + ') ...')
  try {
    $proc = Start-Process -FilePath $ExePath `
      -ArgumentList @(('--user-data-dir="' + $RootProfile + '"'), ('--cluely-root-run=' + $stamp)) `
      -WorkingDirectory $InstallRoot `
      -RedirectStandardOutput $BootLog -RedirectStandardError $BootErr -PassThru
  } catch {
    Write-Fail ('Launch failed: ' + $_.Exception.Message)
    Get-Content $BootErr -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
    exit 1
  }
  if (-not $proc) {
    Write-Fail 'Launch returned no process handle -- see ' + $BootErr
    exit 1
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  $created = Get-ProcessCreatedWmi $proc.Id
  # Explicit $() strings: @('PID=' + ..., ...) collapses into ONE
  # space-joined line in PowerShell, which silently breaks the
  # line-anchored ownership regexes.
  Set-Content -Path $PidFile -Encoding ASCII -Value @(
    "PID=$($proc.Id)"
    "CREATED=$created"
    "STAMP=$stamp"
  )

  Write-Info 'Waiting for Cluely to finish booting ...'
  $deadline = (Get-Date).AddSeconds(45)
  $bootOk = $false
  $rootOk = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
      Write-Fail 'Cluely exited during startup. Last log lines:'
      Get-Content $BootLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
      Get-Content $BootErr -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
      exit 1
    }
    $bootOk = Test-Marker 'Application initialized successfully' $appLogOffset
    $rootOk = Test-Marker 'Root exam mode active' $appLogOffset
    if ($bootOk -and $rootOk) { break }
  }

  if (-not $bootOk) {
    Write-Fail 'Timed out after 45s -- Cluely is alive but the boot marker never appeared. Last log lines:'
    Get-Content $BootLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
    exit 1
  }
  if (-not $rootOk) {
    Write-Fail 'Boot marker found but the root-mode marker did not -- this build predates Windows root-mode support. Reinstall the app.'
    exit 1
  }

  $markerLine = Select-String -Path $AppLog -Pattern 'Root exam mode active' -ErrorAction SilentlyContinue | Select-Object -Last 1
  Write-Ok ('Cluely booted elevated (PID ' + $proc.Id + ')')
  $main = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $proc.Id) -ErrorAction SilentlyContinue
  if ($main -and $main.CommandLine -match 'CluelyRoot') {
    Write-Ok 'Main process carries the root profile marker (C:\ProgramData\CluelyRoot)'
  }
  if ($markerLine) { Write-Ok ('Self-reported: ' + $markerLine.Line.Trim()) }
  if ($main) {
    Set-Content -Path (Join-Path $env:TEMP 'cluely-root-state.txt') -Encoding UTF8 -Value @(
      "PID=$($main.ProcessId)"
      "CREATED=$(Get-ProcessCreatedWmi $main.ProcessId)"
      "CMDLINE=$($main.CommandLine)"
    )
  }
  Write-Plan
  exit 0
}

function Invoke-Stop {
  $pidValue = Get-PidFileValue
  $maybeRunning = $false
  if ($pidValue -gt 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { $maybeRunning = $true }
  $visible = @(Get-RootProcesses)
  if (-not $maybeRunning -and $visible.Count -eq 0) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP 'cluely-root-state.txt') -Force -ErrorAction SilentlyContinue
    Remove-Item $BootLog -Force -ErrorAction SilentlyContinue
    Remove-Item $BootErr -Force -ErrorAction SilentlyContinue
    Write-Ok 'Root Cluely not running -- nothing to kill'
    exit 0
  }

  if (-not (Test-IsAdmin) -and -not $FromElevated) {
    Write-Info 'Requesting elevation (one UAC prompt -- click Yes) ...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), 'stop', '-FromElevated')
    try {
      $elevated = Start-Process powershell -Verb RunAs -ArgumentList $argList -PassThru
    } catch {
      Write-Fail 'Elevation was canceled or failed (the UAC prompt was not accepted).'
      exit 1
    }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      if (Get-Process -Id $elevated.Id -ErrorAction SilentlyContinue) { continue }
      $survivors = @(Get-RootProcesses)
      if ($survivors.Count -eq 0) { exit 0 }
      Write-Fail 'The elevated stop did not complete -- processes still carry the root marker.'
      exit 1
    }
    Write-Fail 'Elevation timed out (60s) -- the UAC prompt was not answered or the stop stalled.'
    exit 1
  }

  $found = $false
  $pidValue = Get-PidFileValue
  if ($pidValue -gt 0) {
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    $recordedStamp = Get-PidFileStamp
    if ($proc -and (Test-PidFileOwnsProcess $pidValue) -and $recordedStamp -and
        (Get-RootStamp $pidValue) -eq $recordedStamp) {
      $found = $true
      Write-Info ('Stopping elevated Cluely (PID ' + $pidValue + ') ...')
      cmd.exe /c ("taskkill /PID " + $pidValue + " >nul 2>&1") | Out-Null
      $grace = 0
      while ((Get-Process -Id $pidValue -ErrorAction SilentlyContinue) -and $grace -lt 5) {
        Start-Sleep -Seconds 1
        $grace++
      }
      # ALWAYS force the tree: if the main exits during the grace period
      # (before this line), /T would otherwise never fire and Chromium
      # children would survive as orphaned elevated processes.
      cmd.exe /c ("taskkill /T /F /PID " + $pidValue + " >nul 2>&1") | Out-Null
    }
  }

  # Precise orphan sweep (friend-facing divergence from scripts/cluely.ps1,
  # which leaves survivors for operator inspection): kill ONLY processes
  # whose command line carries the root-profile marker AND whose immutable
  # WMI creation time is at/after the pidfile main's recorded creation time.
  # An unrelated process can carry neither, so the sweep cannot overreach.
  $mainCreated = Get-PidFileCreated
  $swept = 0
  foreach ($s in @(Get-RootProcesses)) {
    $sCreated = Get-ProcessCreatedWmi $s.ProcessId
    if ($mainCreated -ne '' -and $sCreated -ne '' -and ([long]$sCreated -ge [long]$mainCreated)) {
      Write-Info ('Sweeping root-profile survivor PID ' + $s.ProcessId + ' ...')
      cmd.exe /c ("taskkill /T /F /PID " + $s.ProcessId + " >nul 2>&1") | Out-Null
      $swept++
    }
  }

  # Drain: force-killed Chromium children can take a few seconds to fully
  # exit; a single 1s wait once skipped the cleanup block on a slow child.
  $survivors = @()
  $drain = 0
  while ($drain -lt 20) {
    Start-Sleep -Seconds 5
    $survivors = @(Get-RootProcesses)
    if ($survivors.Count -eq 0) { break }
    $drain += 5
  }
  if ($survivors.Count -gt 0) {
    Write-Warn ('Root-profile processes still require manual inspection: ' + (($survivors | ForEach-Object { $_.ProcessId }) -join ', '))
    exit 1
  }
  if ($found) {
    Write-Ok 'Root Cluely stopped'
  } elseif ($swept -gt 0) {
    Write-Ok ('Root Cluely stopped (' + $swept + ' swept processes)')
  } else {
    Write-Ok 'Root Cluely not running -- nothing to kill'
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $RootData 'cluely-root.pid') -Force -ErrorAction SilentlyContinue  # legacy pidfile location
  Remove-Item (Join-Path $env:TEMP 'cluely-root-state.txt') -Force -ErrorAction SilentlyContinue
  Remove-Item $BootLog -Force -ErrorAction SilentlyContinue
  Remove-Item $BootErr -Force -ErrorAction SilentlyContinue
  Clear-RootSingletonLocks
  Write-Ok 'Cleanup done -- the normal (non-exam) launch works again'
  exit 0
}

function Show-Help {
  Write-Host ''
  Write-Host 'OpenCluely (Admin) launcher'
  Write-Host '  (no command)   start Cluely in root mode (one UAC click)'
  Write-Host '  stop           stop the elevated instance (one UAC click)'
  Write-Host '  help           this text'
  Write-Host ''
  exit 0
}

switch ($Command) {
  'start' { Invoke-Start }
  'stop'  { Invoke-Stop }
  'help'  { Show-Help }
}
