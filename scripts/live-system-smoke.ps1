# live-system-smoke.ps1 — launch the REAL OpenCluely app at SYSTEM integrity
# on the interactive desktop and verify the band protection end to end.
#
# One UAC prompt. The app is left RUNNING afterwards (use `cluely stop` from a
# packaged build, or -Stop to kill the smoke instance).
#
# Checks (all evidence written to %TEMP%\cluely-system-smoke\):
#   S1 boot: app log shows 'Application initialized successfully' +
#            'Root exam mode active' with 'integrity system'.
#   S2 render: at least one visible top-level window belongs to the app PID.
#   S3 demotion blocked: 5x SetWindowPos(HWND_NOTOPMOST) from an ELEVATED
#      attacker -> the window's topmost style must stay TRUE.
#   S4 hide blocked: ShowWindow(SW_HIDE) -> the window must stay visible.
#   S5 state preserved: window still visible + topmost at the end (no
#      recreation), renderer PID unchanged.
#   USER: watch the screen (UI should appear), press Ctrl+Shift+V twice
#         (hide + re-front), Ctrl+Shift+T (force topmost), and try a capture
#         (Ctrl+Shift+S) if you want to hear/see the answer flow.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File live-system-smoke.ps1
#        [-Repo <dir>] [-AttackAfterSec 30] [-Stop]

param(
  [string]$Repo = '',
  [int]$AttackAfterSec = 30,
  [switch]$Stop
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$PowerShell = (Get-Command powershell.exe).Source
$OutDir = Join-Path $env:TEMP 'cluely-system-smoke'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[SMOKE] Requesting one UAC elevation...'
  $p = Start-Process -FilePath $PowerShell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Repo "' + $Repo + '" -AttackAfterSec ' + $AttackAfterSec + $(if ($Stop) { ' -Stop' } else { '' })) -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
}

Start-Transcript -Path (Join-Path $OutDir 'smoke-transcript.txt') -Force -ErrorAction SilentlyContinue
$SummaryPath = Join-Path $OutDir 'summary.txt'
Remove-Item $SummaryPath -Force -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Smoke {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int X, int Y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
  public static void Strip(IntPtr h) { SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010); }
  public static List<IntPtr> WindowsOfPid(int pid) {
    var l = new List<IntPtr>();
    EnumWindows((h, p) => { uint wpid; GetWindowThreadProcessId(h, out wpid); if (wpid == (uint)pid && IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
}
'@

if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
$Repo = (Resolve-Path $Repo).Path
$electron = Join-Path $Repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw ('electron.exe not found under ' + $Repo) }
$mainJs = Join-Path $Repo 'main.js'
if (-not (Test-Path $mainJs)) { throw ('main.js not found under ' + $Repo) }

# ── Launch at SYSTEM via the compiled token-dance helper ───────────────────
$launcher = Join-Path $Repo 'scripts\bin\SystemLauncher.exe'
if (-not (Test-Path $launcher)) { throw 'SystemLauncher.exe missing -- build it: csc /out:scripts\bin\SystemLauncher.exe scripts\SystemLauncher.cs' }
$rootProfile = 'C:\ProgramData\CluelyRoot\userdata'
New-Item -ItemType Directory -Force -Path $rootProfile | Out-Null
$env:CLUELY_ROOT_EXAM = '1'
$envMap = [ordered]@{ CLUELY_ROOT_EXAM = '1' }
foreach ($k in @('AI_MODE','LLM_PROVIDER','SPEECH_PROVIDER','WHISPER_COMMAND','WHISPER_CAPTURE_MODE','WHISPER_RESPONSE_TARGET','DEEPSEEK_API_KEY','WHISPER_MODEL_DIR','WHISPER_MODEL')) {
  $v = [Environment]::GetEnvironmentVariable($k, 'Process')
  if ($v) { $envMap[$k] = $v }
}
$normalEnv = Join-Path $env:APPDATA 'screen-reader-util\.env'
if (-not $envMap.Contains('DEEPSEEK_API_KEY') -and (Test-Path $normalEnv)) {
  $keyLine = Select-String -Path $normalEnv -Pattern '^\s*DEEPSEEK_API_KEY\s*=' | Select-Object -First 1
  if ($keyLine) {
    $value = ($keyLine.Line -split '=', 2)[1].Trim().Trim("'").Trim('"')
    if ($value.Length -gt 0) { $envMap['DEEPSEEK_API_KEY'] = $value }
  }
}
$paramsPath = Join-Path $OutDir 'launch-params.json'
$resultPath = Join-Path $OutDir 'launch-result.txt'
$bootOut = Join-Path $OutDir 'app-stdout.log'
$bootErr = Join-Path $OutDir 'app-stderr.log'
Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($paramsPath, (ConvertTo-Json ([ordered]@{
  exe = $electron
  args = ('--no-sandbox "' + $Repo + '" --user-data-dir="' + $rootProfile + '" --cluely-root-run=smoke')
  env = $envMap
  stdout = $bootOut
  stderr = $bootErr
  result = $resultPath
  cwd = $Repo
}) -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

$svcName = 'CluelySystemSmoke'
& sc.exe stop $svcName 2>$null | Out-Null
& sc.exe delete $svcName 2>$null | Out-Null
$create = & sc.exe create $svcName binPath= ('"' + $launcher + '" -params "' + $paramsPath + '"') type= own start= demand 2>&1
if ($LASTEXITCODE -ne 0) { throw ('sc create failed: ' + ($create | Out-String)) }
& sc.exe start $svcName 2>$null | Out-Null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and -not (Test-Path $resultPath)) { Start-Sleep -Milliseconds 300 }
& sc.exe delete $svcName 2>$null | Out-Null

if (-not (Test-Path $resultPath)) { throw 'SYSTEM launcher produced no result within 60s.' }
$result = (Get-Content $resultPath -Raw).Trim()
Write-Host ('[SMOKE] launch result: ' + $result)
if ($result -notmatch '^ok\|pid=(\d+)') {
  [System.IO.File]::WriteAllText($SummaryPath, ('FAIL: SYSTEM launch failed: ' + $result), (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}
$appPid = [int]$Matches[1]

# ── S1/S2: boot markers + visible window ───────────────────────────────────
$userLog = Join-Path $env:USERPROFILE '.screen-reader-util\logs'
$sysLog = 'C:\Windows\System32\config\systemprofile\.screen-reader-util\logs'
$deadline = (Get-Date).AddSeconds(90)
$windows = @()
while ((Get-Date) -lt $deadline -and $windows.Count -eq 0) {
  Start-Sleep -Seconds 2
  $windows = @([Smoke]::WindowsOfPid($appPid))
}
$bootOk = $false; $rootOk = $false; $systemOk = $false
foreach ($logDir in @($sysLog, $userLog)) {
  $today = Get-ChildItem -Path $logDir -Filter 'application-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $today) { continue }
  $text = Get-Content $today.FullName -Raw -ErrorAction SilentlyContinue
  if ($text -match 'Application initialized successfully') { $bootOk = $true }
  if ($text -match 'Root exam mode active') { $rootOk = $true }
  if ($text -match 'integrity system') { $systemOk = $true }
}
Write-Host ('[SMOKE] pid=' + $appPid + ' visibleWindows=' + $windows.Count + ' boot=' + $bootOk + ' root=' + $rootOk + ' systemIntegrity=' + $systemOk)
if ($windows.Count -eq 0) {
  [System.IO.File]::WriteAllText($SummaryPath, ('FAIL: app PID ' + $appPid + ' booted but exposed no visible window (S2).'), (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}
if (-not ($bootOk -and $rootOk -and $systemOk)) {
  [System.IO.File]::WriteAllText($SummaryPath, ('FAIL: markers boot=' + $bootOk + ' root=' + $rootOk + ' system=' + $systemOk + ' (S1). See ' + $bootErr), (New-Object System.Text.UTF8Encoding($false)))
  exit 1
}

# ── USER interaction window ────────────────────────────────────────────────
Write-Host '[SMOKE] The Cluely UI should now be visible on your screen.'
Write-Host '[SMOKE] Please: press Ctrl+Shift+V twice (hide + re-front), Ctrl+Shift+T (force topmost).'
Write-Host ('[SMOKE] Attacks start in ' + $AttackAfterSec + ' seconds ...')
Start-Sleep -Seconds $AttackAfterSec

# ── S3/S4: attack battery from this ELEVATED process ───────────────────────
$target = $windows | Select-Object -First 1
$rect = New-Object Smoke+RECT
[void][Smoke]::GetWindowRect($target, [ref]$rect)
$before = [ordered]@{ topmost = [Smoke]::IsTopmost($target); visible = [Smoke]::IsWindowVisible($target); rect = ('{0},{1},{2},{3}' -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom) }
$stripLog = @()
for ($i = 1; $i -le 5; $i++) {
  [void][Smoke]::Strip($target)
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $stillTop = [Smoke]::IsTopmost($target)
  $stripLog += [pscustomobject]@{ attempt = $i; lastWin32Error = $err; topmostAfter = $stillTop }
  Start-Sleep -Milliseconds 900
}
[void][Smoke]::ShowWindow($target, 0)  # SW_HIDE
Start-Sleep -Milliseconds 800
$after = [ordered]@{ topmost = [Smoke]::IsTopmost($target); visible = [Smoke]::IsWindowVisible($target) }
$stillAlive = [bool](Get-Process -Id $appPid -ErrorAction SilentlyContinue)

$s3 = (@($stripLog | Where-Object { -not $_.topmostAfter }).Count -eq 0)
$s4 = $after.visible
$s5 = ($stillAlive -and $after.topmost -and $after.visible)

[System.IO.File]::WriteAllText((Join-Path $OutDir 'evidence.json'), (ConvertTo-Json ([ordered]@{
  pid = $appPid; before = $before; strips = $stripLog; after = $after; stillAlive = $stillAlive
  s3DemotionBlocked = $s3; s4HideBlocked = $s4; s5StatePreserved = $s5
}) -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

$lines = @(
  '# SYSTEM smoke verdict',
  ('UTC: ' + (Get-Date).ToUniversalTime().ToString('o')),
  ('S1 boot markers (init/root/system-integrity): ' + $bootOk + '/' + $rootOk + '/' + $systemOk + ' (must be True)'),
  ('S2 visible window for PID ' + $appPid + ': ' + ($windows.Count -gt 0) + ' (must be True)'),
  ('S3 topmost demotion blocked (5 elevated strips; ' + (@($stripLog | Where-Object { -not $_.topmostAfter }).Count) + ' demotions observed): ' + $s3 + ' (must be True)'),
  ('S4 hide blocked (visible after SW_HIDE): ' + $s4 + ' (must be True)'),
  ('S5 state preserved (alive + topmost + visible at end): ' + $s5 + ' (must be True)'),
  ''
)
$overall = $bootOk -and $rootOk -and $systemOk -and $windows.Count -gt 0 -and $s3 -and $s4 -and $s5
$lines += if ($overall) { 'VERDICT: PASS — the real app at SYSTEM integrity renders, boots with the system marker, and shrugs off elevated demotion/hide attacks.' } else { 'VERDICT: FAIL — see failing lines above.' }
if ($Stop) {
  taskkill.exe /PID $appPid /T /F 2>$null | Out-Null
  $lines += 'App stopped (-Stop).'
} else {
  $lines += ('App LEFT RUNNING (PID ' + $appPid + '). Stop with: taskkill /PID ' + $appPid + ' /T /F')
}
[System.IO.File]::WriteAllLines($SummaryPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Get-Content $SummaryPath | ForEach-Object { Write-Host ('[SMOKE] ' + $_) }
Stop-Transcript -ErrorAction SilentlyContinue
exit $(if ($overall) { 0 } else { 1 })
