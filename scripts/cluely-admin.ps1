# =============================================================================
#  cluely-admin.ps1 -- packaged one-click root mode for OpenCluely on Windows
#
#  What it is: the FRIEND-facing launcher that ships INSIDE the installer,
#  next to screen-reader-util.exe. Double-click "OpenCluely (Admin)" in the
#  Start Menu and it: seeds the root profile, copies your DeepSeek key from
#  the normal profile, hardens the trust boundary, and starts the app with
#  ONE UAC click.
#
#  Two exam modes:
#    start   -- Administrator token (High integrity) root mode
#    system  -- SYSTEM integrity via the temp-service token dance; band
#               protection blocks elevated demote/hide/close attacks (UIPI)
#
#  Usage (via the cluely-admin.cmd shim, never the .ps1 directly):
#    OpenCluely (Admin).cmd          # start root mode
#    OpenCluely (Admin).cmd system   # start SYSTEM exam mode (recommended)
#    OpenCluely (Admin).cmd stop     # stop this desktop session
#
#  This file is the packaged subset of scripts/cluely.ps1. The developer
#  keeps the full doctor/status tooling in the repo; this copy has no
#  .depthengine or dev-path lookups and resolves everything relative to
#  the install directory. Reviewed logic (root seeding, key copy, icacls
#  two-step hardening) stays in place. Ownership is session-scoped, and
#  readiness comes from the running app rather than historical log markers.
# =============================================================================

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'help', 'system')]
  [string]$Command = 'start',
  [switch]$FromElevated
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Install layout: <install>\resources\launcher\cluely-admin.ps1 and
# <install>\screen-reader-util.exe -- so the install root is two levels up.
$InstallRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ExePath = Join-Path $InstallRoot 'screen-reader-util.exe'

# Launch artifacts belong to the invoking interactive Windows session.
$SessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$RootData = 'C:\ProgramData\CluelyRoot'
$RootProfile = Join-Path $RootData ('sessions\' + $SessionId + '\userdata')
$PidFile = Join-Path $env:TEMP ('cluely-root-' + $SessionId + '.pid')
$BootLog = Join-Path $env:TEMP ('cluely-root-boot-' + $SessionId + '.log')
$BootErr = Join-Path $env:TEMP ('cluely-root-boot-' + $SessionId + '.err')
$NormalProfile = Join-Path $env:APPDATA 'screen-reader-util'
$NormalEnv = Join-Path $NormalProfile '.env'

function Write-Ok([string]$Msg)   { Write-Host ("[OK]   " + $Msg) }
function Write-Warn([string]$Msg) { Write-Host ("[WARN] " + $Msg) -ForegroundColor Yellow }
function Write-Fail([string]$Msg) { Write-Host ("[FAIL] " + $Msg) -ForegroundColor Red }
function Write-Info([string]$Msg) { Write-Host ("       " + $Msg) }

function Test-IsAdmin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Session ownership is independent of Chromium's normal/elevated profiles.
# The only public pipe operations are status and activation. Never trust a
# claimed PID: Windows provides the actual server PID from the pipe handle.
function Initialize-ProcessProbe {
  if (-not ('CluelyTokenProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CluelyTokenProbe {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Arguments(string command) {
    int count;
    IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var result = new string[count];
      for (int i=0; i<count; i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i*IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }

  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int info, IntPtr data, int size, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  public static string Mode(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero, data = IntPtr.Zero;
    try {
      if (process == IntPtr.Zero || !OpenProcessToken(process, 8, out token)) return "unknown";
      int size; GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
      if (size <= 0 || size > 65536) return "unknown";
      data = Marshal.AllocHGlobal(size);
      if (!GetTokenInformation(token, 25, data, size, out size)) return "unknown";
      IntPtr sid = Marshal.ReadIntPtr(data);
      byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      if (count == 0) return "unknown";
      int rid = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
      return rid >= 16384 ? "system" : rid >= 12288 ? "administrator" : "normal";
    } finally {
      if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }
}
'@
  }
}

function Get-ProcessMode([int]$ProcessId) {
  Initialize-ProcessProbe
  return [CluelyTokenProbe]::Mode($ProcessId)
}

function Get-ProcessArguments([string]$CommandLine) {
  Initialize-ProcessProbe
  return [CluelyTokenProbe]::Arguments($CommandLine)
}

function Get-ProcessAccountSid([int]$ProcessId) {
  $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ProcessId) -ErrorAction Stop
  if (-not $processInfo) { return '' }
  $account = Invoke-CimMethod -InputObject $processInfo -MethodName GetOwnerSid -ErrorAction Stop
  if ($account.ReturnValue -ne 0) { return '' }
  return [string]$account.Sid
}

function Read-SessionOwner([string]$Action = 'status') {
  if (-not ('CluelyPipeIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CluelyPipeIdentity {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
}
'@
  }
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', ('OpenCluely-session-' + $SessionId + '-v1'), [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  $server = $null
  try {
    try { $pipe.Connect(400) } catch [System.TimeoutException] { return $null }
    [uint32]$serverId = 0
    if (-not [CluelyPipeIdentity]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$serverId)) { throw 'Cannot verify the existing session.' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Action + "`n")
    $pipe.Write($bytes, 0, $bytes.Length)
    $reader = New-Object System.IO.StreamReader($pipe)
    $read = $reader.ReadLineAsync()
    if (-not $read.Wait(2500)) { throw 'The existing OpenCluely session is not responding. Use OpenCluely Stop, then retry.' }
    $owner = $read.Result | ConvertFrom-Json
    if ($owner.protocol -ne 1 -or $owner.pid -ne $serverId -or $owner.ready -isnot [bool] -or $owner.mode -notin @('normal','administrator','system')) { throw 'The existing session identity could not be verified.' }
    $server = Get-Process -Id $serverId -ErrorAction Stop
    if ($server.SessionId -ne $SessionId -or $server.ProcessName -ne 'screen-reader-util') { throw 'The existing session process could not be verified.' }
    if (-not $server.Path) {
      throw [System.UnauthorizedAccessException]::new('Windows permission is required to verify the existing OpenCluely session.')
    }
    if ($server.Path -ne $ExePath) { throw 'The existing session belongs to another OpenCluely installation. Stop it there before choosing another mode.' }
    # Retain the process object through the account lookup so this PID cannot
    # be recycled into a different process while its identity is being checked.
    $null = $server.Handle
    if ($server.HasExited) { throw 'The existing OpenCluely session closed during verification. Retry the shortcut.' }
    $nativeMode = Get-ProcessMode $serverId
    $modeVerified = $nativeMode -eq $owner.mode
    if (-not $modeVerified -and $nativeMode -eq 'unknown' -and $owner.mode -eq 'system') {
      # Windows may deny TOKEN_QUERY on a SYSTEM token even to an admin.
      # The authenticated app computes its reported mode from its OWN token.
      # Corroborate that report with the actual Windows SYSTEM account; an
      # access denial, launcher flag or ordinary-user report alone is no proof.
      $modeVerified = (Get-ProcessAccountSid $serverId) -eq 'S-1-5-18'
    }
    if (-not $modeVerified) { throw 'The existing session process could not be verified. Use OpenCluely Stop before choosing another mode.' }
    if ($server.HasExited) { throw 'The existing OpenCluely session closed during verification. Retry the shortcut.' }
    return $owner
  } finally {
    if ($server) { $server.Dispose() }
    $pipe.Dispose()
  }
}

function Show-LaunchMessage([string]$Message) {
  Write-Info $Message
  $shell = New-Object -ComObject WScript.Shell
  $null = $shell.Popup($Message, 0, 'OpenCluely', 64)
}

function Get-InstalledMainProcesses {
  $sessionProcesses = @(Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" | Where-Object { $_.SessionId -eq $SessionId })
  foreach ($candidate in $sessionProcesses) {
    if ((-not $candidate.ExecutablePath -or -not $candidate.CommandLine) -and (Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue)) {
      throw 'Windows could not identify an existing OpenCluely process. Nothing was stopped or started. Use OpenCluely Stop with Windows permission, or restart Windows before retrying.'
    }
  }
  $processes = @($sessionProcesses | Where-Object { $_.ExecutablePath -eq $ExePath })
  return @($processes | Where-Object {
    $candidate = $_
    $parent = @($processes | Where-Object { $_.ProcessId -eq $candidate.ParentProcessId -and $_.CreationDate -le $candidate.CreationDate })
    # Electron's Node workers (e.g. materials search) have no --type flag.
    # They belong to their owning main and must never be mistaken for mains,
    # particularly when the parent is an isolated QA/playground instance.
    if (-not $candidate.CommandLine) { return $false }
    $arguments = @(Get-ProcessArguments $candidate.CommandLine)
    $profileArgument = @($arguments | Where-Object { $_.StartsWith('--user-data-dir=', [StringComparison]::Ordinal) -and $_.Length -gt 16 })
    $qaRequested = $arguments -ccontains '--cluely-qa-instance' -and $profileArgument.Count -gt 0
    $mode = if ($qaRequested) { Get-ProcessMode $candidate.ProcessId } else { 'unused' }
    if ($qaRequested -and $mode -eq 'unknown') { throw 'Cannot verify a possible isolated QA process. Stop was canceled before changing it.' }
    $isolatedQA = $qaRequested -and $mode -eq 'normal'
    $hasType = @($arguments | Where-Object { $_.StartsWith('--type=', [StringComparison]::Ordinal) }).Count -gt 0
    $parent.Count -eq 0 -and -not $isolatedQA -and $candidate.CommandLine -and -not $hasType -and
    $arguments -cnotcontains '--ingestion-playground' -and
    $candidate.CommandLine -notmatch 'app\.asar[\\/].+\.(?:c?js|mjs)(?:"|\s|$)'
  })
}

function Confirm-AvailableSession([string]$RequestedMode) {
  try { $owner = Read-SessionOwner 'activate' }
  catch [System.UnauthorizedAccessException] {
    # A medium-integrity shortcut cannot inspect a SYSTEM owner's image.
    # Request the ordinary UAC flow, then retry the same check before starting
    # anything. The running owner is preserved if permission is canceled.
    if (-not (Test-IsAdmin) -and -not $FromElevated) {
      $action = if ($RequestedMode -eq 'system') { 'system' } else { 'start' }
      Invoke-ElevatedCommand $action
    }
    throw
  }
  if ($owner) {
    if ($owner.mode -eq $RequestedMode -and $owner.ready -and (Test-VisibleWindow $owner.pid)) {
      Write-Ok ('OpenCluely is already running in ' + $owner.mode + ' mode (PID ' + $owner.pid + '). Its window was requested.')
      exit 0
    }
    if ($owner.mode -eq $RequestedMode) {
      Write-Info ('The existing ' + $owner.mode + ' session is still opening. No new session was started.')
      exit 2
    }
    $state = if ($owner.ready) { 'running' } else { 'starting' }
    Show-LaunchMessage ('OpenCluely is already ' + $state + ' in ' + $owner.mode + ' mode. Your current session stays open. To change modes, use OpenCluely Stop, then open the shortcut you want.')
    exit 2
  }
  # Also catch an older installed process that predates the shared pipe.
  if (@(Get-InstalledMainProcesses).Count -gt 0) {
    Show-LaunchMessage 'OpenCluely is already open. Use OpenCluely Stop before changing modes. Your current session stays open.'
    exit 2
  }
}

function Enter-LaunchTransaction {
  # Local\ is scoped by Windows to this interactive session. The elevated
  # coordinator holds the mutex for its entire launch/stop transaction.
  $script:LaunchMutex = New-Object System.Threading.Mutex($false, 'Local\OpenCluely-launch-v1')
  $entered = $false
  try { $entered = $script:LaunchMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $entered = $true }
  if (-not $entered) {
    Show-LaunchMessage 'Another OpenCluely launch or stop is still finishing. Please wait, then try again.'
    exit 2
  }
}

function Invoke-ElevatedCommand([string]$Mode, [int]$Seconds = 150) {
  Write-Info 'Requesting elevation (one UAC prompt -- click Yes) ...'
  $argsForChild = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), $Mode, '-FromElevated')
  try { $child = Start-Process powershell.exe -Verb RunAs -ArgumentList $argsForChild -PassThru }
  catch {
    Show-LaunchMessage 'Windows permission was canceled or could not be granted. Your existing OpenCluely session was kept.'
    exit 1
  }
  if (-not $child.WaitForExit($Seconds * 1000)) {
    Show-LaunchMessage 'OpenCluely is still starting or stopping. Check its window before retrying. A timeout does not mean the app has stopped.'
    exit 1
  }
  # The exact coordinator's result replaces inference from old log strings.
  $child.Refresh()
  $code = $child.ExitCode
  if ($null -eq $code) { throw 'Windows did not provide the launch result.' }
  if ($code -ne 0) { Show-LaunchMessage 'OpenCluely did not complete the requested action. Check the existing window. Use OpenCluely Stop before retrying a mode change.' }
  exit $code
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

function Test-VisibleWindow([int]$ProcessId) {
  # Fail-fast UI proof for the SYSTEM launch: boot markers in a log are not
  # the same as a window on the user's desktop (the token dance can land the
  # app on the wrong session/desktop and still boot cleanly).
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

function Seed-RootLaunchEnvironment {
  New-Item -ItemType Directory -Force -Path $RootProfile | Out-Null
  $rootEnv = Join-Path $RootProfile '.env'
  if (-not (Test-Path $rootEnv)) {
    @('AI_MODE=direct', 'LLM_PROVIDER=deepseek', 'SPEECH_PROVIDER=whisper', 'WHISPER_COMMAND=whisper', 'WHISPER_CAPTURE_MODE=manual', 'WHISPER_RESPONSE_TARGET=chat') |
      Set-Content -Path $rootEnv -Encoding ASCII
  }
  $normalSetup = Join-Path $NormalProfile 'setup-state.json'
  $rootSetup = Join-Path $RootProfile 'setup-state.json'
  if (-not (Test-Path $rootSetup) -and (Test-Path $normalSetup) -and (Get-Item $normalSetup).Length -le 4096) {
    try {
      $state = Get-Content $normalSetup -Raw | ConvertFrom-Json
      if ($state.version -eq 1 -and $state.completed -eq $true -and $state.step -eq 'complete' -and $state.draft -eq '' -and $state.inputMode -in @('text','screenshot')) {
        [System.IO.File]::WriteAllText($rootSetup, '{"version":1,"completed":true,"step":"complete","draft":"","inputMode":"text"}', (New-Object System.Text.UTF8Encoding($false)))
      }
    } catch { Write-Warn 'Saved setup progress could not be read. The app will show setup if needed.' }
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
}


function Write-Plan {
  Write-Host ''
  Write-Host 'You are up. Now:'
  Write-Info '1. Open your exam browser (Cluely is already first -- correct order).'
  Write-Info '2. On a question, press Ctrl+Shift+S (or the camera button in the chat header).'
  Write-Info '3. The answer lands in the Cluely chat.'
  Write-Info 'When done, use the OpenCluely Stop shortcut. Use Stop before changing modes.'
  Write-Host ''
}

function Invoke-Start {
  $isAdmin = Test-IsAdmin

  if (-not (Test-Path $ExePath)) {
    Write-Fail ('Installed app not found: ' + $ExePath)
    Write-Info 'Reinstall OpenCluely and try again.'
    exit 1
  }

  Confirm-AvailableSession 'administrator'
  if (-not $isAdmin -and -not $FromElevated) { Invoke-ElevatedCommand 'start' }
  if (-not $isAdmin) { throw 'Windows administrator permission is required.' }
  Enter-LaunchTransaction
  Confirm-AvailableSession 'administrator'

  Seed-RootLaunchEnvironment


  # Harden the root DATA dir (Administrators + SYSTEM only). The install
  # directory is deliberately NOT hardened: per-user installs must stay
  # writable so uninstall and future updates work without elevation.
  # (scripts/cluely.ps1 keeps its stronger install-dir hardening for the
  # developer machine's exam-integrity contract.)
  foreach ($target in @($RootData)) {
    cmd.exe /c ('icacls "' + $target + '" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" /T /C /Q >nul 2>&1') | Out-Null
    cmd.exe /c ('icacls "' + $target + '" /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q >nul 2>&1') | Out-Null
  }


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
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
    $owner = Read-SessionOwner
    if ($owner -and $owner.pid -eq $proc.Id -and $owner.mode -eq 'administrator' -and $owner.ready -and (Test-VisibleWindow $proc.Id)) { $ready = $true; break }
  }
  if (-not $ready) { throw 'Administrator startup was not verified. Check the existing window or use OpenCluely Stop before retrying.' }
  Write-Ok ('OpenCluely is running in administrator mode (PID ' + $proc.Id + ').')
  Write-Plan
  exit 0
}

function Invoke-StartSystem {
  $isAdmin = Test-IsAdmin

  if (-not (Test-Path $ExePath)) {
    Write-Fail ('Installed app not found: ' + $ExePath)
    exit 1
  }

  Confirm-AvailableSession 'system'
  if (-not $isAdmin -and -not $FromElevated) { Invoke-ElevatedCommand 'system' }
  if (-not $isAdmin) { throw 'Windows administrator permission is required.' }
  Enter-LaunchTransaction
  Confirm-AvailableSession 'system'

  Seed-RootLaunchEnvironment

  # Harden the root DATA dir only; the per-user install directory stays
  # writable so uninstall and updates work without elevation.
  foreach ($target in @($RootData)) {
    cmd.exe /c ('icacls "' + $target + '" /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" /T /C /Q >nul 2>&1') | Out-Null
    cmd.exe /c ('icacls "' + $target + '" /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q >nul 2>&1') | Out-Null
  }


  Remove-Item $BootLog -Force -ErrorAction SilentlyContinue
  Remove-Item $BootErr -Force -ErrorAction SilentlyContinue

  $stamp = 'cluely-system-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Write-Info ('Launching Cluely at SYSTEM integrity (stamp ' + $stamp + ') ...')

  $launcherExe = Join-Path $PSScriptRoot 'SystemLauncher.exe'
  if (-not (Test-Path $launcherExe) -or (Get-Item (Join-Path $PSScriptRoot 'SystemLauncher.cs')).LastWriteTimeUtc -gt (Get-Item $launcherExe).LastWriteTimeUtc) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    if (-not (Test-Path $csc)) { Write-Fail 'csc.exe not found -- cannot build the SYSTEM launcher.'; exit 1 }
    & $csc /nologo /platform:x64 /target:exe /optimize+ /r:System.Web.Extensions.dll ('/out:' + $launcherExe) (Join-Path $PSScriptRoot 'SystemLauncher.cs') | Out-Null
    if (-not (Test-Path $launcherExe) -or (Get-Item (Join-Path $PSScriptRoot 'SystemLauncher.cs')).LastWriteTimeUtc -gt (Get-Item $launcherExe).LastWriteTimeUtc) { Write-Fail 'Failed to compile SystemLauncher.cs.'; exit 1 }
    Write-Ok ('Built SYSTEM launcher: ' + $launcherExe)
  }

  $paramsPath = Join-Path $RootData ('system-launch-params-' + $SessionId + '.json')
  $launchId = [guid]::NewGuid().ToString('N')
  $resultPath = Join-Path $RootData ('system-result-' + $launchId + '.txt')
  Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
  $envMap = [ordered]@{}
  foreach ($k in @('CLUELY_ROOT_EXAM','AI_MODE','LLM_PROVIDER','SPEECH_PROVIDER','WHISPER_COMMAND','WHISPER_CAPTURE_MODE','WHISPER_RESPONSE_TARGET','DEEPSEEK_API_KEY','WHISPER_MODEL_DIR','WHISPER_MODEL')) {
    $v = [Environment]::GetEnvironmentVariable($k, 'Process')
    if ($v) { $envMap[$k] = $v }
  }
  $params = [ordered]@{
    session = [string]$SessionId
    exe = $ExePath
    args = ('--user-data-dir="' + $RootProfile + '" --cluely-root-run=' + $stamp)
    env = $envMap
    stdout = $BootLog
    stderr = $BootErr
    result = $resultPath
    cwd = $InstallRoot
  }
  [System.IO.File]::WriteAllText($paramsPath, (ConvertTo-Json $params -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

  $svcName = 'CluelySystemLaunch' + $SessionId
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
  if ($result -notmatch ('^ok\|pid=(\d+)\|session=' + $SessionId + '$')) { Write-Fail ('SYSTEM launch failed: ' + $result); exit 1 }
  $sysPid = [int]$Matches[1]
  Remove-Item $resultPath -Force -ErrorAction SilentlyContinue

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  $created = Get-ProcessCreatedWmi $sysPid
  Set-Content -Path $PidFile -Encoding ASCII -Value @(
    "PID=$sysPid"
    "CREATED=$created"
    "STAMP=$stamp"
  )

  Write-Info 'Waiting for Cluely to finish booting ...'
  $deadline = (Get-Date).AddSeconds(45)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $sysPid -ErrorAction SilentlyContinue)) { break }
    $owner = Read-SessionOwner
    if ($owner -and $owner.pid -eq $sysPid -and $owner.mode -eq 'system' -and $owner.ready -and (Test-VisibleWindow $sysPid)) { $ready = $true; break }
  }
  if (-not $ready) { throw 'SYSTEM startup was not verified. Check the existing window or use OpenCluely Stop before retrying.' }
  Write-Ok ('OpenCluely is running in SYSTEM mode (PID ' + $sysPid + ').')
  Write-Plan
  exit 0
}

function Invoke-Stop {
  if (-not (Test-IsAdmin) -and -not $FromElevated) { Invoke-ElevatedCommand 'stop' 60 }
  if (-not (Test-IsAdmin)) { throw 'Windows administrator permission is required to stop elevated OpenCluely.' }
  Enter-LaunchTransaction
  $mains = @(Get-InstalledMainProcesses)
  $all = @(Get-CimInstance Win32_Process | Where-Object {
    $_.SessionId -eq $SessionId -and $_.ExecutablePath
  })
  $owned = @{}
  foreach ($main in $mains) { $owned[[int]$main.ProcessId] = $main }
  do {
    $changed = $false
    foreach ($candidate in $all) {
      if (-not $owned.ContainsKey([int]$candidate.ProcessId) -and $owned.ContainsKey([int]$candidate.ParentProcessId)) {
        $parent = $owned[[int]$candidate.ParentProcessId]
        if ($candidate.CreationDate -ge $parent.CreationDate) {
          $owned[[int]$candidate.ProcessId] = $candidate
          $changed = $true
        }
      }
    }
  } while ($changed)
  # Bind handles before stopping anything; compare immutable creation time to
  # the snapshot so a reused numeric PID cannot become a kill target.
  $handles = @()
  foreach ($entry in $owned.Values) {
    $target = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if (-not $target) { continue }
    $null = $target.Handle
    $nativeTicks = $target.StartTime.ToUniversalTime().Ticks
    # CIM records microseconds; native FILETIME retains 100ns ticks.
    $sameCreation = ($nativeTicks - ($nativeTicks % 10)) -eq $entry.CreationDate.ToUniversalTime().Ticks
    if (-not $sameCreation -or $target.Path -ne $entry.ExecutablePath -or $target.SessionId -ne $SessionId) {
      $target.Dispose()
      throw 'A process changed while stopping. No unverified process will be stopped; retry OpenCluely Stop.'
    }
    $handles += $target
  }
  try {
    foreach ($target in $handles) {
      if (-not $target.HasExited) { $target.Kill() }
    }
    foreach ($target in $handles) {
      if (-not $target.WaitForExit(10000)) { throw ('OpenCluely process ' + $target.Id + ' did not stop.') }
    }
  } finally { foreach ($target in $handles) { $target.Dispose() } }
  if (@(Get-InstalledMainProcesses).Count -gt 0) { throw 'An OpenCluely session is still running. Stop did not complete.' }
  $owner = Read-SessionOwner
  if ($owner) { throw 'Another OpenCluely installation still owns this desktop session. Stop it from that installation.' }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Ok 'OpenCluely stopped in this Windows session. You can now choose another mode.'
  exit 0
}

function Show-Help {
  Write-Host ''
  Write-Host 'OpenCluely launcher'
  Write-Host '  (no command)   start Cluely in root mode (Administrator, one UAC click)'
  Write-Host '  system         start Cluely at SYSTEM integrity -- band-protected exam mode (one UAC click)'
  Write-Host '  stop           stop normal or elevated OpenCluely in this Windows session (one UAC click)'
  Write-Host '  help           this text'
  Write-Host ''
  exit 0
}

try {
  switch ($Command) {
    'start'  { Invoke-Start }
    'system' { Invoke-StartSystem }
    'stop'   { Invoke-Stop }
    'help'   { Show-Help }
  }
} catch {
  Write-Fail $_.Exception.Message
  Show-LaunchMessage $_.Exception.Message
  exit 1
}
