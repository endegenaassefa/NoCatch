# run-live-system.ps1 — one-click LockDown Browser practice exam against the
# SYSTEM-integrity Cluely build, with a zero-demotion acceptance check.
#
# Sequence (ONE UAC prompt total):
#   1. Launch OpenCluely at SYSTEM integrity on the interactive desktop
#      (scripts\bin\SystemLauncher.exe via a temporary service).
#   2. Wait for boot markers ('integrity system') + a visible window.
#   3. Start the visual recorder (tests\kill-matrix\windows\visual-watch.ps1)
#      with the root PID override — it samples Z-order/topmost/cloak every
#      500 ms and stops when LockDown Browser exits.
#   4. Open LockDown Browser. Take your practice test.
#   5. When you close LDB: stop the recorder, build the report, and judge:
#        ACCEPT: 0 samples with a Cluely window missing the topmost style
#                (the SYSTEM band blocked every demotion).
#        The report also counts cover-by-browser samples — the shared-topmost
#        band allows LDB to cover us by re-fronting; the summon hotkeys
#        (Ctrl+Shift+V) re-front Cluely. Record those presses mentally for
#        correlation with the report timestamps.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-live-system.ps1
#        [-Repo <dir>] [-BrowserExe <path>] [-DurationSeconds 2700]

param(
  [string]$Repo = '',
  [string]$BrowserExe = 'C:\Program Files (x86)\Respondus\LockDown Browser\LockDownBrowser.exe',
  [int]$DurationSeconds = 2700
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$PowerShell = (Get-Command powershell.exe).Source
$OutDir = Join-Path $env:TEMP 'cluely-live-system'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[LIVE] Requesting one UAC elevation...'
  $p = Start-Process -FilePath $PowerShell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Repo "' + $Repo + '" -BrowserExe "' + $BrowserExe + '" -DurationSeconds ' + $DurationSeconds) -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
}

Start-Transcript -Path (Join-Path $OutDir 'live-transcript.txt') -Force -ErrorAction SilentlyContinue
if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$Repo = (Resolve-Path $Repo).Path
# Prefer the packaged app (what `cluely system` launches) so the exam test
# exercises the production boundary; fall back to the source electron.exe.
$packaged = Join-Path $Repo 'dist\win-unpacked\screen-reader-util.exe'
$electron = if (Test-Path $packaged) { $packaged } else { Join-Path $Repo 'node_modules\electron\dist\electron.exe' }
$launcher = Join-Path $Repo 'scripts\bin\SystemLauncher.exe'
$visualWatch = Join-Path $Repo 'tests\kill-matrix\windows\visual-watch.ps1'
$visualReport = Join-Path $Repo 'tests\kill-matrix\windows\visual-report.ps1'
foreach ($f in @($electron, $launcher, $visualWatch, $visualReport)) {
  if (-not (Test-Path $f)) { throw ('Missing: ' + $f) }
}
if (-not (Test-Path $BrowserExe)) { throw ('LockDown Browser not found: ' + $BrowserExe) }
if (Get-Process -Name 'LockDownBrowser' -ErrorAction SilentlyContinue) { throw 'LockDown Browser is already open. Close it first.' }

# ── 1. Launch Cluely at SYSTEM ─────────────────────────────────────────────
$rootProfile = 'C:\ProgramData\CluelyRoot\userdata'
New-Item -ItemType Directory -Force -Path $rootProfile | Out-Null
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
Remove-Item $resultPath -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText($paramsPath, (ConvertTo-Json ([ordered]@{
  exe = $electron
  args = ('--no-sandbox "' + $Repo + '" --user-data-dir="' + $rootProfile + '" --cluely-root-run=live')
  env = $envMap
  stdout = (Join-Path $OutDir 'app-stdout.log')
  stderr = (Join-Path $OutDir 'app-stderr.log')
  result = $resultPath
  cwd = $Repo
}) -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

$svcName = 'CluelySystemLive'
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
if ($result -notmatch '^ok\|pid=(\d+)') { throw ('SYSTEM launch failed: ' + $result) }
$appPid = [int]$Matches[1]
Write-Host ('[LIVE] Cluely at SYSTEM: PID ' + $appPid)

# ── 2. Wait for boot + visible window ──────────────────────────────────────
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LiveWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<IntPtr> VisibleWindowsOf(int pid) {
    var l = new List<IntPtr>();
    EnumWindows((h, p) => { uint wpid; GetWindowThreadProcessId(h, out wpid); if (wpid == (uint)pid && IsWindowVisible(h)) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
}
'@
$deadline = (Get-Date).AddSeconds(120)
$windows = @()
while ((Get-Date) -lt $deadline -and $windows.Count -eq 0) {
  Start-Sleep -Seconds 2
  $windows = @([LiveWin]::VisibleWindowsOf($appPid))
}
if ($windows.Count -eq 0) { throw ('Cluely PID ' + $appPid + ' exposed no visible window within 120s.') }
# The logger writes under os.homedir() — for a SYSTEM service that is
# systemprofile; the stdout capture is a belt-and-braces fallback.
$markerOk = $false
$sysLog = 'C:\Windows\System32\config\systemprofile\.screen-reader-util\logs'
$userLog = Join-Path $env:USERPROFILE '.screen-reader-util\logs'
foreach ($logDir in @($sysLog, $userLog)) {
  $today = Get-ChildItem -Path $logDir -Filter 'application-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $today) { continue }
  $logText = Get-Content $today.FullName -Raw -ErrorAction SilentlyContinue
  if ($logText -match 'integrity system') { $markerOk = $true; break }
}
if (-not $markerOk) {
  foreach ($std in @('app-stdout.log', 'app-stderr.log')) {
    $p = Join-Path $OutDir $std
    if ((Test-Path $p) -and ((Get-Content $p -Raw -ErrorAction SilentlyContinue) -match 'integrity system')) { $markerOk = $true; break }
  }
}
if (-not $markerOk) { throw 'App booted but did not report SYSTEM integrity; aborting before the exam.' }
Write-Host '[LIVE] Boot verified: SYSTEM integrity + visible window.'

# ── 3. Visual recorder ─────────────────────────────────────────────────────
$capture = Join-Path $OutDir ('capture-' + (Get-Date -Format 'yyyyMMddTHHmmss'))
New-Item -ItemType Directory -Path $capture -Force | Out-Null
$visualArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $visualWatch + '" -Capture "' + $capture + '" -RootPidOverride ' + $appPid + ' -DurationSeconds ' + $DurationSeconds + ' -StopWhenProcessExit LockDownBrowser'
$visualProc = Start-Process -FilePath $PowerShell -ArgumentList $visualArgs -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $capture 'visual-ready.txt'))) {
  if ($visualProc.HasExited) { throw 'Visual recorder exited before LockDown Browser opened.' }
  Start-Sleep -Milliseconds 500
}
if (-not (Test-Path (Join-Path $capture 'visual-ready.txt'))) { throw 'Visual recorder did not become ready.' }

# ── 4. Exam ────────────────────────────────────────────────────────────────
Write-Host '[LIVE] Opening LockDown Browser. Take your PRACTICE test.'
Write-Host '[LIVE] Summon re-front: press Ctrl+Shift+V (twice) when you want Cluely above the browser.'
Start-Process -FilePath $BrowserExe | Out-Null

$deadline = (Get-Date).AddSeconds($DurationSeconds + 60)
while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $capture 'visual-ended.txt'))) {
  Start-Sleep -Seconds 2
}
if (-not (Test-Path (Join-Path $capture 'visual-ended.txt'))) {
  [System.IO.File]::WriteAllText((Join-Path $capture 'visual-stop.txt'), 'timeout', (New-Object System.Text.UTF8Encoding($false)))
  Start-Sleep -Seconds 5
}

# ── 5. Report + acceptance ─────────────────────────────────────────────────
if (Test-Path (Join-Path $capture 'visual-state.jsonl')) {
  & $PowerShell -NoProfile -ExecutionPolicy Bypass -File $visualReport -Capture $capture | Out-Host
}
$report = Join-Path $capture 'visual-report.md'
$demotions = -1
if (Test-Path $report) {
  $m = Select-String -Path $report -Pattern 'without the Windows topmost style: (\d+)'
  if ($m) { $demotions = [int]$m.Matches[0].Groups[1].Value }
}
$accept = ($demotions -eq 0)
$lines = @(
  '# Live SYSTEM exam verdict',
  ('UTC: ' + (Get-Date).ToUniversalTime().ToString('o')),
  ('App PID: ' + $appPid + ' (SYSTEM integrity, verified)'),
  ('Visual report: ' + $report),
  ('Topmost demotions observed during the exam: ' + $(if ($demotions -lt 0) { 'UNKNOWN (no report)' } else { $demotions }) + ' (ACCEPT = 0)'),
  ('Verdict: ' + $(if ($accept) { 'PASS — the SYSTEM band blocked every demotion attempt during the exam.' } else { 'FAIL — demotions observed; the band protection did not hold.' })),
  ''
)
if (-not $accept -and $demotions -ge 0) { $lines += 'Investigate: ' + $capture }
[System.IO.File]::WriteAllLines((Join-Path $OutDir 'verdict.txt'), $lines, (New-Object System.Text.UTF8Encoding($false)))
Get-Content (Join-Path $OutDir 'verdict.txt') | ForEach-Object { Write-Host ('[LIVE] ' + $_) }
if (Test-Path $report) { Start-Process -FilePath (Join-Path $env:WINDIR 'system32\notepad.exe') -ArgumentList ('"' + $report + '"') | Out-Null }
Write-Host ('[LIVE] App LEFT RUNNING (PID ' + $appPid + '). Stop with: taskkill /PID ' + $appPid + ' /T /F')
Stop-Transcript -ErrorAction SilentlyContinue
exit $(if ($accept) { 0 } else { 1 })
