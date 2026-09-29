# =============================================================================
#  cluely.ps1 -- one-command root exam mode for OpenCluely on Windows
#
#  Launches the packaged app with a SYSTEM token, confirms the root-mode boot
#  markers AND that a visible window reached your desktop. It does not prove
#  the UI will stay above a secure-desktop app -- that is the summon hotkey's
#  job (Ctrl+Shift+V re-fronts the shared topmost band).
#
#  Usage:
#    cluely              # doctor + start (idempotent -- safe to re-run)
#    cluely start        # same as above
#    cluely system       # SYSTEM-integrity exam mode (one UAC prompt)
#    cluely stop         # kill the elevated Cluely and clean up
#    cluely status       # is it running? elevation + boot-log tail
#    cluely doctor       # prerequisite checks only
#    cluely help
#
#  Install (one time, from this repo, in a normal PowerShell):
#    setx PATH "%PATH%;<repo>\scripts"     # then restart the terminal
#    or run it as:  <repo>\scripts\cluely.cmd
#
#  `cluely system` runs Cluely at SYSTEM integrity: elevated apps can no
#  longer demote, hide, or message-close the exam UI (UIPI), and the summon
#  hotkeys re-front it in the shared topmost band.
#
#  Rules that stay true:
#    * Start the app before measuring behavior in a practice environment.
#    * The macOS cluely-shield helper does not exist on Windows -- elevated
#      Cluely replaces it entirely.
#    * `cluely start` requests ONE UAC elevation; `cluely stop` requests one
#      more (a lower-privilege process cannot kill a higher one by design).
# =============================================================================

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'doctor', 'help', 'system')]
  [string]$Command = 'start',
  [switch]$FromElevated,
  [string]$Exe = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$Repo = Split-Path -Parent $ScriptDir

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

$RootData = 'C:\ProgramData\CluelyRoot'
$RootProfile = Join-Path $RootData 'userdata'
# The pidfile lives in the per-user TEMP dir so an unelevated `cluely status`
# can read it; the hardened root data dir is Administrators/SYSTEM-only.
$PidFile = Join-Path $env:TEMP 'cluely-root.pid'
$BootLog = Join-Path $env:TEMP 'cluely-root-boot.log'
$BootErr = Join-Path $env:TEMP 'cluely-root-boot.err'
$RunLock = Join-Path $env:TEMP 'cluely-run.lock'
$NormalProfile = Join-Path $env:APPDATA 'screen-reader-util'
$NormalEnv = Join-Path $NormalProfile '.env'
$AppLog = Join-Path $env:USERPROFILE ('.screen-reader-util\logs\application-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
$ModelsDir = if ($env:CLUELY_MODELS) { $env:CLUELY_MODELS } else { (Join-Path $env:USERPROFILE 'Documents\DepthEngine\evidence\nocatch-bundled-speech-20260924\real-model-qa\models') }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Ok([string]$Msg)   { Write-Host ("[OK]   " + $Msg) }
function Write-Warn([string]$Msg) { Write-Host ("[WARN] " + $Msg) -ForegroundColor Yellow }
function Write-Fail([string]$Msg) { Write-Host ("[FAIL] " + $Msg) -ForegroundColor Red }
function Write-Info([string]$Msg) { Write-Host ("       " + $Msg) }

function Test-IsAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-IntegrityLabel {
  $raw = (& whoami.exe /groups | Out-String)
  if ($raw -match 'S-1-16-16384') { return 'system' }
  if ($raw -match 'S-1-16-12288') { return 'high' }
  if ($raw -match 'S-1-16-8448')  { return 'medium-plus' }
  if ($raw -match 'S-1-16-8192')  { return 'medium' }
  if ($raw -match 'S-1-16-4096')  { return 'low' }
  return 'unknown'
}

function Get-SessionId {
  return [System.Diagnostics.Process]::GetCurrentProcess().SessionId
}

function Resolve-Exe {
  if ($Exe) { return $Exe }
  # A normal local Windows package is the first choice in this worktree.
  $localBuild = Join-Path $Repo 'dist\win-unpacked\screen-reader-util.exe'
  if (Test-Path $localBuild) { return $localBuild }
  $found = @()
  # Depth 1: .depthengine\<name>\win-unpacked[*]\screen-reader-util.exe
  foreach ($d in (Get-ChildItem -Path (Join-Path $Repo '.depthengine') -Directory -ErrorAction SilentlyContinue)) {
    foreach ($u in (Get-ChildItem -Path $d.FullName -Directory -Filter 'win-unpacked*' -ErrorAction SilentlyContinue)) {
      $candidate = Join-Path $u.FullName 'screen-reader-util.exe'
      if (Test-Path $candidate) { $found += Get-Item $candidate }
    }
    # Depth 2: .depthengine\<group>\<name>\win-unpacked[*]\screen-reader-util.exe
    foreach ($sub in (Get-ChildItem -Path $d.FullName -Directory -ErrorAction SilentlyContinue)) {
      foreach ($u in (Get-ChildItem -Path $sub.FullName -Directory -Filter 'win-unpacked*' -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $u.FullName 'screen-reader-util.exe'
        if (Test-Path $candidate) { $found += Get-Item $candidate }
      }
    }
  }
  if ($found.Count -gt 0) { return (($found | Sort-Object LastWriteTime -Descending)[0]).FullName }
  return ''
}

function Get-RootStamp([int]$ProcessId) {
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
  if (-not $proc) { return '' }
  if ($proc.CommandLine -match '--cluely-root-run=([^\s"]+)') { return $Matches[1] }
  return ''
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
  # Get-CimInstance returns a DateTime on current Windows PowerShell, while
  # older WMI callers may return a DMTF string. Preserve subsecond precision
  # so a quickly reused PID cannot inherit a previous launch's identity.
  $created = $p.CreationDate
  if ($created -is [datetime]) { return $created.ToUniversalTime().Ticks.ToString() }
  try {
    return ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created)).ToUniversalTime().Ticks.ToString()
  } catch {
    return ''
  }
}

# Exact ownership proof (independent review finding 2, 2026-09-25): a reused
# pidfile PID must never pass. Ownership = process name match AND the
# recorded WMI creation time (immutable per process) matches the pidfile.
function Test-PidFileOwnsProcess([int]$ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne 'screen-reader-util') { return $false }
  $created = Get-PidFileCreated
  if ($created -eq '') { return $false }  # legacy bare-number pidfile proves nothing
  $wmi = Get-ProcessCreatedWmi $ProcessId
  if ($wmi -eq '') { return $false }       # cannot prove ownership -> not ours
  return $wmi -eq $created
}

function Test-RootInstanceAlive {
  $pidValue = Get-PidFileValue
  if ($pidValue -le 0) { return $false }
  if (-not (Test-PidFileOwnsProcess $pidValue)) { return $false }
  # The readable launch stamp proves the main process. An unelevated shell
  # cannot read that command line, so accept only a direct child carrying the
  # exact root-profile marker; another instance cannot prove this PID's owner.
  if ((Get-RootStamp $pidValue) -ne '') { return $true }
  return @((Get-RootProcesses) | Where-Object {
    $parent = $_.PSObject.Properties['ParentProcessId']
    $parent -and $parent.Value -eq $pidValue
  }).Count -gt 0
}

function Get-RootProcesses {
  # Elevated-instance identification is exact: only processes whose command
  # line carries the root profile marker (--user-data-dir=<root profile>).
  # Chromium children always keep it, and the normal app never uses that
  # profile. The elevated main is owned via the pidfile with creation-time
  # verification -- never by pattern alone, so an unrelated process with an
  # unreadable command line can never be swept.
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

function Test-VisibleWindow([int]$ProcessId) {
  # Fail-fast UI proof for `cluely system`: markers in a log are not the same
  # as a window on the user's desktop (the token dance can land the app on the
  # wrong session/desktop and still boot cleanly).
  if (-not ('CluelyWinProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CluelyWinProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static int VisibleWindowsOf(int pid) {
    int n = 0;
    EnumWindows((h, p) => { uint wpid; GetWindowThreadProcessId(h, out wpid); if (wpid == (uint)pid && IsWindowVisible(h)) n++; return true; }, IntPtr.Zero);
    return n;
  }
}
'@
  }
  return ([CluelyWinProbe]::VisibleWindowsOf($ProcessId) -gt 0)
}

function Clear-RootSingletonLocks {
  foreach ($name in @('SingletonLock', 'SingletonCookie', 'SingletonSocket')) {
    Remove-Item (Join-Path $RootProfile $name) -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------------------
# doctor -- everything the root launch depends on (P18 step 1: report the
# ACTUAL token state; a missing implementation reports unavailable, never a
# synthetic root: true)
# ---------------------------------------------------------------------------

function Invoke-Doctor {
  $problems = 0

  Write-Host ''
  Write-Host 'Privilege report (actual token, not a guess):'
  if (Test-IsAdmin) {
    Write-Ok ('Elevated Administrator token (integrity ' + (Get-IntegrityLabel) + ', session ' + (Get-SessionId) + ')')
  } else {
    Write-Warn ('NOT elevated (integrity ' + (Get-IntegrityLabel) + ', session ' + (Get-SessionId) + ') -- `cluely start` will request one UAC elevation')
  }

  $exePath = Resolve-Exe
  if (-not $exePath) {
    Write-Fail 'No packaged Windows build found. Run npm run build:win -- --dir, or pass -Exe.'
    $problems++
  } elseif (-not (Test-Path $exePath)) {
    Write-Fail ('Configured executable not found: ' + $exePath)
    $problems++
  } else {
    $vi = (Get-Item $exePath).VersionInfo
    Write-Ok ('Packaged app: ' + $exePath)
    Write-Info ('  product version ' + $vi.ProductVersion + ', ' + [math]::Round((Get-Item $exePath).Length / 1MB, 1) + ' MB')
    $archive = Join-Path (Split-Path $exePath) 'resources\app.asar'
    if (Test-Path $archive) {
      Write-Ok 'App archive present; startup must confirm the root-mode marker.'
    } else {
      Write-Fail ('Packaged app archive not found: ' + $archive)
      $problems++
    }
  }

  if (Test-Path $NormalEnv) {
    $keyLine = Select-String -Path $NormalEnv -Pattern '^\s*DEEPSEEK_API_KEY\s*=' | Select-Object -First 1
    if ($keyLine) {
      $value = ($keyLine.Line -split '=', 2)[1].Trim().Trim("'").Trim('"')
      if ($value.Length -gt 0) {
        Write-Ok ('DeepSeek key configured in ' + $NormalEnv + ' (value length ' + $value.Length + ')')
      } else {
        Write-Fail 'DEEPSEEK_API_KEY is empty in the normal profile -- answers will fail'
        $problems++
      }
    } else {
      Write-Fail 'No DEEPSEEK_API_KEY in the normal profile .env -- answers will fail'
      $problems++
    }
  } else {
    Write-Fail ('Normal profile .env not found: ' + $NormalEnv)
    $problems++
  }

  if (Test-Path (Join-Path $ModelsDir 'small.pt')) {
    Write-Ok ('Whisper model present: ' + (Join-Path $ModelsDir 'small.pt'))
  } else {
    Write-Warn ('Whisper model not found under ' + $ModelsDir + ' -- mic transcription will be unavailable until a model is prepared in Settings')
  }

  $consent = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
  $npDir = Join-Path $consent 'NonPackaged'
  $micState = $null
  if (Test-Path $npDir) {
    foreach ($entry in (Get-ChildItem $npDir -ErrorAction SilentlyContinue)) {
      if ($entry.PSChildName -notmatch 'screen-reader-util') { continue }
      $props = Get-ItemProperty $entry.PSPath -ErrorAction SilentlyContinue
      $val = $props.PSObject.Properties['Value']
      if ($val) { $micState = [string]$val.Value }
    }
  }
  if ($micState -eq 'Allow') {
    Write-Ok 'Microphone privacy consent: Allow (root-mode mic works)'
  } elseif ($micState) {
    Write-Warn ('Microphone privacy consent: ' + $micState + ' -- fix: Windows Settings > Privacy > Microphone > allow this app')
  } else {
    Write-Warn 'Microphone privacy consent: not recorded yet -- first mic use asks Windows; grant it once'
  }

  Write-Info 'cluely-shield helper is macOS-only; elevated Cluely replaces it on Windows.'
  Write-Host ''
  return $problems
}

# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

# Seed the root profile + process environment for an elevated/system launch.
# The API key travels in the process environment, never into a persistent
# machine-readable file (the SYSTEM launch path passes it through a transient,
# ACL-hardened params file that is deleted right after process creation).
function Seed-RootLaunchEnvironment {
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
  }
  if (Test-Path (Join-Path $ModelsDir 'small.pt')) {
    $env:WHISPER_MODEL_DIR = $ModelsDir
    $env:WHISPER_MODEL = 'small'
  }
}

function Invoke-Start {
  $isAdmin = Test-IsAdmin
  $exePath = Resolve-Exe

  if (-not $exePath -or -not (Test-Path $exePath)) {
    Write-Fail 'No packaged win-unpacked build found -- run doctor for details.'
    exit 1
  }

  # Already running (pidfile alive AND the process is our exe name, confirmed
  # by the stamp or the root-profile marker -- protects against PID reuse).
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
    Write-Info 'If you need to stop it: cluely stop'
    exit 0
  }

  # Clear a stale pidfile before launching.
  if (Test-Path $PidFile) {
    Write-Warn 'Stale pidfile found -- clearing it before launch.'
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  if (-not $isAdmin -and -not $FromElevated) {
    Write-Host ''
    Write-Info 'Requesting elevation (one UAC prompt -- click Yes) ...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), 'start', '-FromElevated', '-Exe', ('"' + $exePath + '"'))
    try {
      $elevated = Start-Process powershell -Verb RunAs -ArgumentList $argList -PassThru
    } catch {
      Write-Fail 'Elevation was canceled or failed (the UAC prompt was not accepted).'
      exit 1
    }
    # Deliberately no -Wait: under WSL/pipe hosts the elevated child's exit
    # can fail to signal and hang the wrapper forever. Poll instead, and
    # judge the outcome by the evidence the child wrote (boot markers),
    # never by an exit code that may not be delivered.
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
  if ($FromElevated) {
    $problems = Invoke-Doctor
    if ($problems -gt 0) {
      Write-Fail 'Doctor reported blocking problems -- fix them and rerun cluely start.'
      exit 1
    }
  }

  Seed-RootLaunchEnvironment

  # A crashed previous root run can leave Chromium singleton locks behind;
  # the root profile is root-exclusive, so clearing them here is safe.
  Clear-RootSingletonLocks

  # Harden the trust boundary (independent review finding 1, 2026-09-25):
  # the elevated app loads program and profile bytes, so no lower-privilege
  # user may modify them. Root data: Administrators + SYSTEM only. Candidate
  # package: Administrators + SYSTEM write, Users read/execute.
  #
  # Two-step sequence. A single /T pass with (OI)(CI) flags leaves FILES
  # with inherit-only ACEs (an empty effective DACL = deny everyone) --
  # verified live 2026-09-25 and reproduced on a scratch tree. So:
  #   1. strip inherited ACEs from the whole tree and apply PLAIN ACEs to
  #      every existing file and folder;
  #   2. add INHERITABLE ACEs to the top folder so future files inherit.
  foreach ($target in @($RootData, (Split-Path $exePath))) {
    $isRootData = ($target -eq $RootData)
    $usersPlain = if ($isRootData) { '' } else { ' "*S-1-5-32-545:RX"' }
    $usersInherit = if ($isRootData) { '' } else { ' "*S-1-5-32-545:(OI)(CI)RX"' }
    cmd.exe /c ('icacls "' + $target + '" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F"' + $usersPlain + ' /T /C /Q >nul 2>&1') | Out-Null
    cmd.exe /c ('icacls "' + $target + '" /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"' + $usersInherit + ' /Q >nul 2>&1') | Out-Null
  }

  # Boot markers are byte-offset-gated on today's app log: only log bytes
  # appended after this launch can satisfy verification, so an earlier boot
  # from the same day can never fake success.
  $appLogOffset = 0L
  if (Test-Path $AppLog) { $appLogOffset = (Get-Item $AppLog).Length }

  Remove-Item $BootLog -Force -ErrorAction SilentlyContinue
  Remove-Item $BootErr -Force -ErrorAction SilentlyContinue

  $stamp = 'cluely-root-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Write-Info ('Launching Cluely elevated (stamp ' + $stamp + ') ...')
  try {
    $proc = Start-Process -FilePath $exePath `
      -ArgumentList @(('--user-data-dir="' + $RootProfile + '"'), ('--cluely-root-run=' + $stamp)) `
      -WorkingDirectory (Split-Path $exePath) `
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

  # Pidfile carries the immutable WMI creation time: later checks prove exact
  # process ownership instead of trusting a reused PID.
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  $created = Get-ProcessCreatedWmi $proc.Id
  # Explicit $() strings: @('PID=' + ..., ...) collapses into ONE
  # space-joined line, which silently breaks the line-anchored ownership
  # regexes below (found 2026-09-25; stop never actually owned its target).
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
    Write-Info 'App log tail:'
    (Read-AppLogTailFrom $appLogOffset) -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 10 | ForEach-Object { Write-Info $_ }
    exit 1
  }
  if (-not $rootOk) {
    Write-Fail 'Boot marker found but the root-mode marker did not -- this build predates Windows root-mode support. Rebuild the package.'
    exit 1
  }

  $markerLine = Select-String -Path $AppLog -Pattern 'Root exam mode active' -ErrorAction SilentlyContinue | Select-Object -Last 1
  Write-Ok ('Cluely booted elevated (PID ' + $proc.Id + ')')
  $main = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $proc.Id) -ErrorAction SilentlyContinue
  if ($main -and $main.CommandLine -match 'CluelyRoot') {
    Write-Ok 'Main process carries the root profile marker (C:\ProgramData\CluelyRoot)'
  }
  if ($markerLine) { Write-Ok ('Self-reported: ' + $markerLine.Line.Trim()) }
  # Persist elevated-side evidence the unelevated shell cannot read (the
  # main's command line is invisible to unelevated WMI): status and QA use
  # this as the A4 ownership/stamp record.
  if ($main) {
    Set-Content -Path (Join-Path $env:TEMP 'cluely-root-state.txt') -Encoding UTF8 -Value @(
      "PID=$($main.ProcessId)"
      "CREATED=$(Get-ProcessCreatedWmi $main.ProcessId)"
      "CMDLINE=$($main.CommandLine)"
    )
  }
  Write-Host ''
  Write-Plan
  exit 0
}

function Invoke-StartSystem {
  $isAdmin = Test-IsAdmin
  $exePath = Resolve-Exe

  if (-not $exePath -or -not (Test-Path $exePath)) {
    Write-Fail 'No packaged win-unpacked build found -- run doctor for details.'
    exit 1
  }

  if (Test-RootInstanceAlive) {
    $pidValue = Get-PidFileValue
    Write-Ok ('Cluely is already running (PID ' + $pidValue + ') -- nothing to start.')
    exit 0
  }
  $strays = @(Get-RootProcesses)
  if ($strays.Count -gt 0) {
    Write-Ok ('Cluely is already running (' + $strays.Count + ' processes; pidfile missing).')
    Write-Info 'If you need to stop it: cluely stop'
    exit 0
  }

  if (Test-Path $PidFile) {
    Write-Warn 'Stale pidfile found -- clearing it before launch.'
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  if (-not $isAdmin -and -not $FromElevated) {
    Write-Host ''
    Write-Info 'Requesting elevation (one UAC prompt -- click Yes) ...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), 'system', '-FromElevated', '-Exe', ('"' + $exePath + '"'))
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
      Write-Fail 'The SYSTEM launch did not complete. Last log lines:'
      Get-Content $BootLog -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
      exit 1
    }
    Write-Fail 'Elevation timed out (150s) -- the UAC prompt was not answered or the launch stalled.'
    exit 1
  }

  if (-not $isAdmin) {
    Write-Fail 'Elevation was declined or failed -- SYSTEM launch needs an elevated launcher.'
    exit 1
  }

  if ($FromElevated) {
    $problems = Invoke-Doctor
    if ($problems -gt 0) {
      Write-Fail 'Doctor reported blocking problems -- fix them and rerun cluely system.'
      exit 1
    }
  }

  Seed-RootLaunchEnvironment
  Clear-RootSingletonLocks

  foreach ($target in @($RootData, (Split-Path $exePath))) {
    $isRootData = ($target -eq $RootData)
    $usersPlain = if ($isRootData) { '' } else { ' "*S-1-5-32-545:RX"' }
    $usersInherit = if ($isRootData) { '' } else { ' "*S-1-5-32-545:(OI)(CI)RX"' }
    cmd.exe /c ('icacls "' + $target + '" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F"' + $usersPlain + ' /T /C /Q >nul 2>&1') | Out-Null
    cmd.exe /c ('icacls "' + $target + '" /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"' + $usersInherit + ' /Q >nul 2>&1') | Out-Null
  }

  $appLogOffset = 0L
  if (Test-Path $AppLog) { $appLogOffset = (Get-Item $AppLog).Length }

  Remove-Item $BootLog -Force -ErrorAction SilentlyContinue
  Remove-Item $BootErr -Force -ErrorAction SilentlyContinue

  $stamp = 'cluely-system-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Write-Info ('Launching Cluely at SYSTEM integrity (stamp ' + $stamp + ') ...')

  $launcherExe = Join-Path $ScriptDir 'bin\SystemLauncher.exe'
  if (-not (Test-Path $launcherExe)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $launcherExe) | Out-Null
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    if (-not (Test-Path $csc)) { Write-Fail 'csc.exe not found -- cannot build the SYSTEM launcher.'; exit 1 }
    & $csc /nologo /platform:x64 /target:exe /optimize+ ('/out:' + $launcherExe) (Join-Path $ScriptDir 'SystemLauncher.cs') | Out-Null
    if (-not (Test-Path $launcherExe)) { Write-Fail 'Failed to compile SystemLauncher.cs.'; exit 1 }
    Write-Ok ('Built SYSTEM launcher: ' + $launcherExe)
  }

  $paramsPath = Join-Path $RootData 'system-launch-params.json'
  $resultPath = Join-Path $env:TEMP 'cluely-system-launch-result.txt'
  Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
  $envMap = [ordered]@{}
  foreach ($k in @('CLUELY_ROOT_EXAM','AI_MODE','LLM_PROVIDER','SPEECH_PROVIDER','WHISPER_COMMAND','WHISPER_CAPTURE_MODE','WHISPER_RESPONSE_TARGET','DEEPSEEK_API_KEY','WHISPER_MODEL_DIR','WHISPER_MODEL')) {
    $v = [Environment]::GetEnvironmentVariable($k, 'Process')
    if ($v) { $envMap[$k] = $v }
  }
  $params = [ordered]@{
    exe = $exePath
    args = ('--user-data-dir="' + $RootProfile + '" --cluely-root-run=' + $stamp)
    env = $envMap
    stdout = $BootLog
    stderr = $BootErr
    result = $resultPath
    cwd = (Split-Path $exePath)
  }
  [System.IO.File]::WriteAllText($paramsPath, (ConvertTo-Json $params -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

  $svcName = 'CluelySystemLaunch'
  & sc.exe stop $svcName 2>$null | Out-Null
  & sc.exe delete $svcName 2>$null | Out-Null
  $create = & sc.exe create $svcName binPath= ('"' + $launcherExe + '" -params "' + $paramsPath + '"') type= own start= demand 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Fail ('sc create failed: ' + ($create | Out-String)); exit 1 }
  & sc.exe start $svcName 2>$null | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $resultPath)) { Start-Sleep -Milliseconds 250 }
  & sc.exe delete $svcName 2>$null | Out-Null
  Remove-Item $paramsPath -Force -ErrorAction SilentlyContinue

  if (-not (Test-Path $resultPath)) { Write-Fail 'SYSTEM launch produced no result within 90s.'; exit 1 }
  $result = (Get-Content $resultPath -Raw).Trim()
  Write-Info ('SYSTEM launch result: ' + $result)
  if ($result -notmatch '^ok\|pid=(\d+)') { Write-Fail ('SYSTEM launch failed: ' + $result); exit 1 }
  $sysPid = [int]$Matches[1]

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  $created = Get-ProcessCreatedWmi $sysPid
  Set-Content -Path $PidFile -Encoding ASCII -Value @(
    "PID=$sysPid"
    "CREATED=$created"
    "STAMP=$stamp"
  )

  Write-Info 'Waiting for Cluely to finish booting ...'
  $deadline = (Get-Date).AddSeconds(45)
  $bootOk = $false
  $rootOk = $false
  $systemOk = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $sysPid -ErrorAction SilentlyContinue)) {
      Write-Fail 'Cluely exited during startup. Last log lines:'
      Get-Content $BootLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
      Get-Content $BootErr -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
      exit 1
    }
    $bootOk = Test-Marker 'Application initialized successfully' $appLogOffset
    $rootOk = Test-Marker 'Root exam mode active' $appLogOffset
    $systemOk = Test-Marker 'integrity system' $appLogOffset
    if ($bootOk -and $rootOk) { break }
  }

  if (-not $bootOk) {
    Write-Fail 'Timed out after 45s -- Cluely is alive but the boot marker never appeared.'
    Get-Content $BootLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
    exit 1
  }
  if (-not $rootOk) {
    Write-Fail 'Boot marker found but the root-mode marker did not.'
    exit 1
  }
  if (-not $systemOk) {
    Write-Fail 'App booted but did NOT report SYSTEM integrity -- the band protection is NOT active. Run: cluely stop'
    exit 1
  }

  Write-Info 'Waiting for the exam UI to appear on your desktop ...'
  $winDeadline = (Get-Date).AddSeconds(30)
  $windowVisible = $false
  while ((Get-Date) -lt $winDeadline -and -not $windowVisible) {
    Start-Sleep -Seconds 2
    $windowVisible = Test-VisibleWindow $sysPid
  }
  if (-not $windowVisible) {
    Write-Fail 'Cluely is running at SYSTEM but no visible window reached your desktop within 30s (wrong session/desktop?). Run: cluely stop'
    exit 1
  }

  Write-Ok ('Cluely booted at SYSTEM integrity (PID ' + $sysPid + ')')
  Write-Ok 'Band protection active: elevated apps can no longer demote, hide, or message-close the exam UI (UIPI); the summon hotkeys re-front it in the topmost band.'
  Write-Host ''
  Write-Plan
  exit 0
}

function Write-Plan {
  Write-Host 'Windows root mode is running. The exam-browser interaction is still unverified.'
  Write-Info 'Capture shortcut: Ctrl+Shift+S. When done, run: cluely stop'
}

# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------

function Invoke-Stop {
  # Cheap liveness check BEFORE requesting elevation: nothing to kill means
  # no UAC prompt at all.
  $pidValue = Get-PidFileValue
  $maybeRunning = $false
  if ($pidValue -gt 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { $maybeRunning = $true }
  $visible = @(Get-RootProcesses)
  if (-not $maybeRunning -and $visible.Count -eq 0) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
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
    # No -Wait (WSL/pipe hosts can hang on the elevated child's exit). Poll,
    # then judge the outcome ourselves: zero root-marker survivors = stopped.
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
    # This check runs in the elevated half, where the main command line is
    # readable. A public TEMP pidfile alone must never authorize taskkill.
    if ($proc -and (Test-PidFileOwnsProcess $pidValue) -and $recordedStamp -and
        (Get-RootStamp $pidValue) -eq $recordedStamp) {
      $found = $true
      Write-Info ('Stopping elevated Cluely (PID ' + $pidValue + ') ...')
      # Graceful first: WM_CLOSE lets the app quit cleanly.
      cmd.exe /c ("taskkill /PID " + $pidValue + " >nul 2>&1") | Out-Null
      $grace = 0
      while ((Get-Process -Id $pidValue -ErrorAction SilentlyContinue) -and $grace -lt 5) {
        Start-Sleep -Seconds 1
        $grace++
      }
      cmd.exe /c ("taskkill /T /F /PID " + $pidValue + " >nul 2>&1") | Out-Null
    }
  }

  # taskkill /T handles this main process's children. A marker-only sweep
  # could terminate another instance when the pidfile is stale or forged.
  # Leave any unproven survivors for an operator to inspect by exact PID.
  Start-Sleep -Seconds 1

  $survivors = @(Get-RootProcesses)
  if ($survivors.Count -gt 0) {
    Write-Warn ('Root-profile processes require manual inspection: ' + (($survivors | ForEach-Object { $_.ProcessId }) -join ', '))
    exit 1
  }
  if ($found) {
    Write-Ok 'Root Cluely stopped'
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

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

function Invoke-Status {
  Write-Host ''
  if (Test-IsAdmin) {
    Write-Ok ('This shell: elevated (integrity ' + (Get-IntegrityLabel) + ', session ' + (Get-SessionId) + ')')
  } else {
    Write-Info ('This shell: unelevated (integrity ' + (Get-IntegrityLabel) + ', session ' + (Get-SessionId) + ')')
  }

  $running = Test-RootInstanceAlive
  if (-not $running) {
    $strays = @(Get-RootProcesses)
    if ($strays.Count -eq 0) {
      Write-Warn 'Cluely is not running (root exam mode off).'
      exit 1
    }
    $running = $true
  }

  $pidValue = Get-PidFileValue
  $procs = @(Get-RootProcesses)
  # The elevated main's command line is unreadable from an unelevated WMI
  # query; include it explicitly when the pidfile proves ownership.
  if ($pidValue -gt 0 -and (Test-PidFileOwnsProcess $pidValue)) {
    $mainProc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pidValue) -ErrorAction SilentlyContinue
    if ($mainProc -and -not ($procs | Where-Object { $_.ProcessId -eq $pidValue })) { $procs += $mainProc }
  }
  foreach ($p in $procs) {
    $cmd = $p.CommandLine
    if (-not $cmd) { $cmd = '(elevated -- command line unreadable from this shell)' }
    Write-Info ('  PID ' + $p.ProcessId + '  session ' + $p.SessionId + '  started ' + $p.CreationDate + '  ' + (($cmd -split ' ')[0]))
  }
  Write-Ok ('Root exam mode active (' + $procs.Count + ' processes' + $(if ($pidValue -gt 0) { ', pidfile PID ' + $pidValue } else { '' }) + ')')

  # The app self-reports its actual token at boot; show that line as evidence.
  $marker = Select-String -Path $AppLog -Pattern 'Root exam mode active' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($marker) { Write-Ok ('Self-reported: ' + $marker.Line.Trim()) }
  $stateFile = Join-Path $env:TEMP 'cluely-root-state.txt'
  if (Test-Path $stateFile) {
    Write-Info 'Elevated-side state (recorded at start):'
    Get-Content $stateFile | ForEach-Object {
      if ($_.StartsWith('CMDLINE=')) { Write-Info ('  ' + $_.Substring(0, [Math]::Min(180, $_.Length))) }
      else { Write-Info ('  ' + $_) }
    }
  }

  Write-Info 'Capture on Windows: Ctrl+Shift+S (screenshot button). The macOS-only keystroke tap does not apply.'
  Write-Host ''
  Write-Info 'Boot log tail:'
  Get-Content $BootLog -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Info $_ }
  exit 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

# Atomic start lock guards the whole transaction (including the elevated
# child's boot wait) so two parallel `cluely` runs cannot double-launch.
$lockStream = $null
if (($Command -eq 'start' -or $Command -eq 'system') -and -not $FromElevated) {
  try {
    $lockStream = [System.IO.File]::Open($RunLock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    Write-Fail ('Another cluely run is in progress (lock file ' + $RunLock + ').')
    Write-Info 'Wait for it to finish; if it is stuck, delete the lock file.'
    exit 1
  }
}

try {
  switch ($Command) {
    'start'  { Invoke-Start }
    'system' { Invoke-StartSystem }
    'stop'   { Invoke-Stop }
    'status' { Invoke-Status }
    'doctor' {
      $problems = Invoke-Doctor
      exit $problems
    }
    'help' {
      Write-Host @'
cluely -- one-command root exam mode for OpenCluely (Windows)

  cluely            doctor + start (idempotent -- safe to re-run any time)
  cluely start      start root exam mode (one UAC prompt)
  cluely stop       kill elevated Cluely + clean up (one UAC prompt)
  cluely status     show whether it is running + boot-log tail
  cluely doctor     prerequisite checks only (no elevation needed)
  cluely help       this message
  cluely system     start at SYSTEM integrity (band-protected exam UI)

Exam sequence: run `cluely`, THEN open LockDown Browser, press Ctrl+Shift+S
(or the camera button) on a question.
'@
      exit 0
    }
  }
} finally {
  if ($lockStream) {
    $lockStream.Close()
    Remove-Item $RunLock -Force -ErrorAction SilentlyContinue
  }
}
