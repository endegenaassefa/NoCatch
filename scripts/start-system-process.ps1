# start-system-process.ps1 — launch a process at SYSTEM integrity on the
# interactive desktop (WinSta0\Default of the active console session).
#
# schtasks /RU SYSTEM /IT and InteractiveToken XML both landed in session 0 on
# this machine (see tests/kill-matrix/windows/system-band-probe.ps1 evidence),
# so delivery uses the documented route instead: a temporary Windows service
# (which runs as SYSTEM) duplicates its own primary token, stamps it with the
# console session id, builds an environment block, and CreateProcessAsUser's
# the target onto the interactive desktop. The service self-exits immediately.
#
# Usage (requires elevation — one UAC):
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-system-process.ps1 `
#       -ParamsFile <json with exe, args, marker> [-ServiceMode]
#
# Params JSON: { "exe": "<path>", "args": "<arg string>", "marker": "<path>",
#                "markerTimeoutSec": 60 }

param(
  [string]$ParamsFile = '',
  [string]$ResultFile = '',
  [switch]$ServiceMode
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ServiceName = 'CluelySystemLaunch'
$WorkDir = 'C:\ProgramData\CluelyRoot'
$DefaultParams = Join-Path $WorkDir 'launch-params.json'
if (-not $ResultFile) { $ResultFile = Join-Path $WorkDir 'system-launch-result.txt' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SysLaunch {
  public const uint TOKEN_ALL_ACCESS = 0xF01FF;
  public const int TOKEN_TYPE_PRIMARY = 1;
  public const int SECURITY_IMPERSONATION = 2;
  public const int TokenSessionId = 12;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  public const uint CREATE_NEW_CONSOLE = 0x00000010;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern int WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attrs, int level, int type, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int cls, ref int info, int len);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmdLine, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
}
'@

function Get-LastError() { [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }

if ($ServiceMode) {
  # ── Runs as the (SYSTEM) service worker ──────────────────────────────────
  try {
    [System.IO.File]::WriteAllText($ResultFile, ('started|pid=' + $PID + '|utc=' + (Get-Date).ToUniversalTime().ToString('o')), (New-Object System.Text.UTF8Encoding($false)))
    Start-Transcript -Path ($ResultFile + '.worker-log.txt') -Force -ErrorAction SilentlyContinue
    $params = Get-Content -LiteralPath $ParamsFile -Raw | ConvertFrom-Json
    $exe = [string]$params.exe
    $args = [string]$params.args

    # 1. Duplicate our own (SYSTEM) token into a primary token.
    $proc = [SysLaunch]::GetCurrentProcess()
    $raw = [IntPtr]::Zero
    if (-not [SysLaunch]::OpenProcessToken($proc, [SysLaunch]::TOKEN_ALL_ACCESS, [ref]$raw)) { throw ('OpenProcessToken failed: ' + (Get-LastError)) }
    $primary = [IntPtr]::Zero
    if (-not [SysLaunch]::DuplicateTokenEx($raw, [SysLaunch]::TOKEN_ALL_ACCESS, [IntPtr]::Zero, [SysLaunch]::SECURITY_IMPERSONATION, [SysLaunch]::TOKEN_TYPE_PRIMARY, [ref]$primary)) { throw ('DuplicateTokenEx failed: ' + (Get-LastError)) }
    [SysLaunch]::CloseHandle($raw) | Out-Null

    # 2. Stamp the token with the active console session so the child lands
    #    on the user's desktop instead of session 0.
    $sessionId = [SysLaunch]::WTSGetActiveConsoleSessionId()
    if ($sessionId -lt 1) { throw ('No active console session (id=' + $sessionId + ').') }
    $sidRef = [int]$sessionId
    if (-not [SysLaunch]::SetTokenInformation($primary, [SysLaunch]::TokenSessionId, [ref]$sidRef, 4)) { throw ('SetTokenInformation failed: ' + (Get-LastError)) }

    # 3. Environment block: build it manually from OUR OWN environment
    #    (which provably contains SystemRoot). CreateEnvironmentBlock can
    #    silently fail for SYSTEM tokens, and a NULL block made
    #    CreateProcessAsUser fail with 203 (ERROR_ENVVAR_NOT_FOUND).
    $vars = [Environment]::GetEnvironmentVariables()
    $block = New-Object System.Text.StringBuilder
    foreach ($k in $vars.Keys) { [void]$block.Append([string]$k + '=' + [string]$vars[$k]).Append([char]0) }
    [void]$block.Append([char]0)
    $envBytes = [System.Text.Encoding]::Unicode.GetBytes($block.ToString())
    $envPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($envBytes.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($envBytes, 0, $envPtr, $envBytes.Length)
    if (-not ($vars.Contains('SystemRoot'))) { throw 'Worker environment lacks SystemRoot; refusing to launch a broken child.' }

    # 4. Launch onto WinSta0\Default of the user's session.
    $si = New-Object SysLaunch+STARTUPINFO
    $si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
    $si.lpDesktop = 'winsta0\default'
    $pi = New-Object SysLaunch+PROCESS_INFORMATION
    $cmdLine = New-Object System.Text.StringBuilder(('"' + $exe + '" ' + $args), 32768)
    $ok = [SysLaunch]::CreateProcessAsUser($primary, $exe, $cmdLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, [SysLaunch]::CREATE_UNICODE_ENVIRONMENT, $envPtr, $null, [ref]$si, [ref]$pi)
    $err = Get-LastError
    if (-not $ok -and $err -eq 203) {
      # Fallback: lpApplicationName=NULL form (full path in the command line).
      $ok = [SysLaunch]::CreateProcessAsUser($primary, $null, $cmdLine, [IntPtr]::Zero, [IntPtr]::Zero, $false, [SysLaunch]::CREATE_UNICODE_ENVIRONMENT, $envPtr, $null, [ref]$si, [ref]$pi)
      $err = Get-LastError
    }
    if (-not $ok) { throw ('CreateProcessAsUser failed: ' + $err) }
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($envPtr)
    [SysLaunch]::CloseHandle($primary) | Out-Null
    [System.IO.File]::WriteAllText($ResultFile, ('ok|pid=' + $pi.dwProcessId + '|session=' + $sessionId + '|utc=' + (Get-Date).ToUniversalTime().ToString('o')), (New-Object System.Text.UTF8Encoding($false)))
    [SysLaunch]::CloseHandle($pi.hThread) | Out-Null
    [SysLaunch]::CloseHandle($pi.hProcess) | Out-Null
    exit 0
  } catch {
    try { [System.IO.File]::WriteAllText($ResultFile, ('error|' + $_.Exception.Message), (New-Object System.Text.UTF8Encoding($false))) } catch { }
    exit 1
  }
}

# ── Elevated caller mode: install temp service, run it, clean up ───────────
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[SYSTEM-LAUNCH] Requires elevation. Re-running with UAC...'
  $p = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -ParamsFile "' + $ParamsFile + '"') -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$resultPath = $ResultFile
Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
try {
  & sc.exe stop $ServiceName 2>$null | Out-Null
  & sc.exe delete $ServiceName 2>$null | Out-Null
  # Wrap the worker invocation in a .cmd so sc binPath needs no embedded
  # quotes (the documented quoting for sc is unreliable across builds).
  # The .cmd itself writes progress markers + captures stderr, because a
  # session-0 service failure is otherwise invisible.
  $workerCmd = Join-Path $WorkDir 'syslaunch-worker.cmd'
  $workerBody = @"
@echo off
echo ran-at %DATE% %TIME% >> "$WorkDir\cmd-ran.txt"
whoami /user >> "$WorkDir\cmd-ran.txt" 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PSCommandPath" -ServiceMode -ParamsFile "$ParamsFile" -ResultFile "$ResultFile" 1> "$WorkDir\worker-stdout.txt" 2> "$WorkDir\worker-stderr.txt"
echo exit=%ERRORLEVEL% >> "$WorkDir\cmd-ran.txt"
"@
  [System.IO.File]::WriteAllText($workerCmd, $workerBody, (New-Object System.Text.UTF8Encoding($false)))
  $bin = 'cmd.exe /c ' + $workerCmd
  $create = & sc.exe create $ServiceName binPath= $bin type= own start= demand 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('sc create failed: ' + ($create | Out-String)) }
  # The worker deliberately never calls StartServiceCtrlDispatcher (it is a
  # launch-and-exit worker), so SCM reports error 1053 after the work is done.
  # Treat that as expected; the result file is the source of truth.
  $start = & sc.exe start $ServiceName 2>&1
  Write-Host ('[SYSTEM-LAUNCH] sc start said: ' + ($start | Out-String))

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $resultPath)) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path -LiteralPath $resultPath)) { throw 'SYSTEM launcher produced no result within 90 s.' }
  $result = Get-Content -LiteralPath $resultPath -Raw
  Write-Host ('[SYSTEM-LAUNCH] result: ' + $result)
  if ($result -notmatch '^ok') { throw ('SYSTEM launch failed: ' + $result) }
  exit 0
} catch {
  $details = @($_.Exception.Message)
  try { $details += ('sc qc: ' + ((& sc.exe qc $ServiceName 2>&1 | Out-String).Trim())) } catch { }
  try {
    $hard = Join-Path $WorkDir 'system-launch-result.txt'
    if (Test-Path -LiteralPath $hard) { $details += ('hardened result: ' + (Get-Content -LiteralPath $hard -Raw)) }
    foreach ($f in @('cmd-ran.txt', 'worker-stderr.txt', 'worker-stdout.txt')) {
      $p = Join-Path $WorkDir $f
      if (Test-Path -LiteralPath $p) {
        $content = (Get-Content -LiteralPath $p -Raw | Select-Object -First 1)
        $details += ($f + ': ' + ($content.Substring(0, [Math]::Min(1200, $content.Length))))
      }
    }
    $details += ('hardened dir: ' + ((Get-ChildItem -LiteralPath $WorkDir -Force | Select-Object -ExpandProperty Name) -join ', '))
  } catch { }
  try { [System.IO.File]::WriteAllText($resultPath, ('caller-error|' + ($details -join ' || ')), (New-Object System.Text.UTF8Encoding($false))) } catch { }
  throw
} finally {
  & sc.exe stop $ServiceName 2>$null | Out-Null
  & sc.exe delete $ServiceName 2>$null | Out-Null
}
