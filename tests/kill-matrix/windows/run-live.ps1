param([switch]$Check)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Repo = (Resolve-Path (Join-Path $Here '..\..\..')).Path
$CaptureRoot = Join-Path $Here 'capture'
$Calibrate = Join-Path $Here 'calibrate.ps1'
$Watch = Join-Path $Here 'watch.ps1'
$Visual = Join-Path $Here 'visual-watch.ps1'
$VisualReport = Join-Path $Here 'visual-report.ps1'
$Cluely = Join-Path $Repo 'scripts\cluely.ps1'
$Browser = 'C:\Program Files (x86)\Respondus\LockDown Browser\LockDownBrowser.exe'
$PidFile = Join-Path $env:TEMP 'cluely-root.pid'
$PowerShell = (Get-Command powershell.exe).Source
$LiveCapture = ''
$VisualProcess = $null

function Say([string]$Text) { Write-Host ('[OK]   ' + $Text) }
function Warn([string]$Text) { Write-Host ('[WARN] ' + $Text) -ForegroundColor Yellow }
function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}
function Get-CreatedTicks([int]$ProcessId) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
  if (-not $p) { return '' }
  return $p.CreationDate.ToUniversalTime().Ticks.ToString()
}
function Get-RootPid {
  if (-not (Test-Path -LiteralPath $PidFile)) { return 0 }
  $lines = @(Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue)
  $pidLine = @($lines | Where-Object { $_ -match '^PID=\d+$' } | Select-Object -First 1)
  $createdLine = @($lines | Where-Object { $_ -match '^CREATED=\d+$' } | Select-Object -First 1)
  if ($pidLine.Count -eq 0 -or $createdLine.Count -eq 0) { return 0 }
  $processId = [int]($pidLine[0] -replace '^PID=', '')
  $created = [string]($createdLine[0] -replace '^CREATED=', '')
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process -or $process.ProcessName -ne 'screen-reader-util') { return 0 }
  if ((Get-CreatedTicks $processId) -ne $created) { return 0 }
  return $processId
}
function Latest-NewCalibration([datetime]$SinceUtc) {
  $dirs = @(Get-ChildItem -LiteralPath $CaptureRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{8}T\d{6}Z-' -and $_.CreationTimeUtc -ge $SinceUtc.AddSeconds(-2) } |
    Sort-Object CreationTimeUtc -Descending)
  foreach ($dir in $dirs) {
    if (Test-Path (Join-Path $dir.FullName 'calibration.json')) { return $dir.FullName }
  }
  return ''
}
function Assert-Calibration([string]$Path) {
  if (-not $Path) { throw 'Scratch calibration did not produce a result.' }
  if (Test-Path (Join-Path $Path 'capture-error.txt')) { throw ('Scratch watcher failed: ' + $Path) }
  $result = Read-Json (Join-Path $Path 'calibration.json')
  if (-not $result) { throw ('Missing calibration.json in ' + $Path) }
  if ([string]$result.mediumResult -notmatch '^DENIED:' -or $result.aliveAfterMedium -ne $true) {
    throw 'Scratch calibration did not prove that the normal process was denied and the target survived.'
  }
  if ([string]$result.elevatedResult -notmatch '^SUCCEEDED' -or $result.aliveAfterElevated -ne $false) {
    throw 'Scratch calibration did not prove that the separate elevated process killed the target.'
  }
  $match = [regex]::Match([string]$result.elevatedResult, 'PID (\d+)')
  if (-not $match.Success) { throw 'Cannot identify the elevated scratch killer PID.' }
  $killerPid = [int]$match.Groups[1].Value
  $logged = $false
  $deniedLogged = $false
  foreach ($line in (Get-Content -LiteralPath (Join-Path $Path 'events.jsonl') -ErrorAction Stop)) {
    if (-not $line) { continue }
    $row = $line | ConvertFrom-Json
    if ($row.channel -eq 'sysmon' -and $row.eventId -eq 10 -and $row.sourcePid -eq $killerPid -and $row.targetPid -eq $result.targetPid -and $row.verdict -eq 'GRANTED') {
      $logged = $true
    }
    if ($row.channel -eq 'security' -and $row.targetPid -eq $result.targetPid -and $row.verdict -eq 'BLOCKED') { $deniedLogged = $true }
  }
  if (-not $logged) { throw 'Sysmon did not attribute a terminate-capable scratch access to the elevated killer. The live run will not start.' }
  Say ('Scratch check passed. Evidence: ' + $Path)
  if (-not $deniedLogged) {
    Warn 'Windows did not attribute the denied attempt in Security. Silence about blocked LockDown Browser attempts will remain unknown.'
  }
}
function Stop-OwnedCapture {
  if (-not $LiveCapture) { return }
  if ($VisualProcess -and -not $VisualProcess.HasExited) {
    [System.IO.File]::WriteAllText((Join-Path $LiveCapture 'visual-stop.txt'), 'Launcher requested stop.')
  }
  try {
    $active = Read-Json (Join-Path $CaptureRoot 'active.json')
    if ($active -and [string]$active.capture -eq $LiveCapture) { & $Watch Stop -Capture $LiveCapture | Out-Host }
  } catch { Warn ('Could not request watcher stop: ' + $_.Exception.Message) }
}

try {
  if (-not (Test-Path -LiteralPath $Browser)) { throw ('LockDown Browser executable was not found: ' + $Browser) }
  if (-not (Test-Path -LiteralPath $Cluely)) { throw ('OpenCluely launcher was not found: ' + $Cluely) }
  $service = Get-Service -Name Sysmon64,Sysmon -ErrorAction SilentlyContinue | Where-Object Status -eq 'Running' | Select-Object -First 1
  if (-not $service) { throw 'Sysmon is not running. Run watch.ps1 Setup as Administrator before this one-click test.' }
  $rootPid = Get-RootPid
  if ($Check) {
    Say ('LockDown Browser found: ' + $Browser)
    Say ('Sysmon service running: ' + $service.Name)
    if ($rootPid) { Say ('Elevated OpenCluely pidfile owner: PID ' + $rootPid) }
    else { Warn 'OpenCluely is not running with a proven pidfile owner; the launcher will start it.' }
    Say 'One-click test prerequisites checked. No application was launched.'
    return
  }
  if (Get-Process -Name 'LockDownBrowser' -ErrorAction SilentlyContinue) {
    throw 'LockDown Browser is already open. Close it before starting the recording.'
  }
  $activeFile = Join-Path $CaptureRoot 'active.json'
  if (Test-Path -LiteralPath $activeFile) {
    $old = Read-Json $activeFile
    if (-not $old -or -not $old.watcherPid -or (Get-Process -Id ([int]$old.watcherPid) -ErrorAction SilentlyContinue)) {
      throw 'A watcher may still be active. Stop it before starting this test.'
    }
    Warn ('Previous watcher ended unexpectedly; its capture remains at ' + $old.capture)
    Remove-Item -LiteralPath $activeFile
  }

  Write-Host ''
  Write-Host 'ONE-CLICK LOCKDOWN BROWSER TEST'
  Write-Host 'Windows will ask for Administrator approval twice: once for a safe scratch check, once for the live watcher.'
  Write-Host 'Approve both prompts. The scratch check does not touch OpenCluely.'
  Write-Host ''
  $calibrationStarted = (Get-Date).ToUniversalTime()
  & $Calibrate Run
  $scratchCapture = Latest-NewCalibration $calibrationStarted
  Assert-Calibration $scratchCapture

  $rootPid = Get-RootPid
  if (-not $rootPid) {
    Warn 'OpenCluely was not running. Starting its elevated instance now; this may request one additional UAC approval.'
    $launcher = Start-Process -FilePath $PowerShell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $Cluely + '" start') -Wait -PassThru -NoNewWindow
    if ($launcher.ExitCode -ne 0) { throw ('OpenCluely start failed with exit code ' + $launcher.ExitCode) }
    $rootPid = Get-RootPid
    if (-not $rootPid) { throw 'OpenCluely did not produce a proven root pidfile owner.' }
  }
  Say ('OpenCluely root PID: ' + $rootPid)

  $watchArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $Watch + '" Start -DurationSeconds 2700 -StopWhenProcessExit LockDownBrowser'
  $watcher = Start-Process -FilePath $PowerShell -ArgumentList $watchArgs -Verb RunAs -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(25)
  $activeFile = Join-Path $CaptureRoot 'active.json'
  $active = $null
  while ((Get-Date) -lt $deadline) {
    try { $active = Read-Json $activeFile } catch { $active = $null }
    if ($active -and [int]$active.watcherPid -eq $watcher.Id -and [int]$active.rootPid -eq $rootPid -and $active.mode -eq 'cluely') { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $active -or [int]$active.watcherPid -ne $watcher.Id -or $active.mode -ne 'cluely') { throw 'The live watcher did not start. No browser was launched.' }
  $LiveCapture = [string]$active.capture
  Say ('Live capture: ' + $LiveCapture)

  $deadline = (Get-Date).AddSeconds(30)
  $pinned = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path (Join-Path $LiveCapture 'capture-error.txt')) { throw 'The watcher failed before the browser opened.' }
    try {
      $targets = @(Read-Json (Join-Path $LiveCapture 'targets.json'))
      $root = @($targets | Where-Object { $_ -and $_.pid -eq $rootPid } | Select-Object -First 1)
      if ($root.Count -gt 0 -and $root[0].PSObject.Properties['guid'] -and $root[0].guid) { $pinned = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $pinned) { throw 'The watcher could not pin the live OpenCluely identity. No browser was launched.' }
  $visualArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $Visual + '" -Capture "' + $LiveCapture + '" -TargetPid ' + $rootPid + ' -DurationSeconds 2700'
  $VisualProcess = Start-Process -FilePath $PowerShell -ArgumentList $visualArgs -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $LiveCapture 'visual-ready.txt'))) {
    if ($VisualProcess.HasExited) { throw 'The visual recorder exited before LockDown Browser opened.' }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path (Join-Path $LiveCapture 'visual-ready.txt'))) { throw 'The visual recorder did not become ready.' }
  Say 'Watcher is ready. Opening LockDown Browser now.'
  Say 'Window order and placement are also being recorded without screen images or exam text.'
  Write-Host 'Use your PRACTICE test. When you close LockDown Browser, the report will open automatically.'
  Start-Process -FilePath $Browser | Out-Null

  $deadline = (Get-Date).AddMinutes(46)
  while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $LiveCapture 'ended.txt'))) {
    if (-not (Get-Process -Id $watcher.Id -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 2
  }
  if (-not (Test-Path (Join-Path $LiveCapture 'ended.txt'))) { throw ('Watcher ended without a clean report. Inspect ' + $LiveCapture) }
  $reportPath = Join-Path $LiveCapture 'report.md'
  if (-not (Test-Path $reportPath)) { & $Watch Report -Capture $LiveCapture | Out-Host }
  $visualDeadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $visualDeadline -and -not (Test-Path (Join-Path $LiveCapture 'visual-ended.txt'))) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path (Join-Path $LiveCapture 'visual-state.jsonl')) { & $VisualReport -Capture $LiveCapture | Out-Host }
  Say ('Report: ' + $reportPath)
  Start-Process -FilePath (Join-Path $env:WINDIR 'system32\notepad.exe') -ArgumentList ('"' + $reportPath + '"') | Out-Null
  $LiveCapture = ''
} catch {
  Write-Host ('[FAIL] ' + $_.Exception.Message) -ForegroundColor Red
  Stop-OwnedCapture
  if ($LiveCapture -and (Test-Path (Join-Path $LiveCapture 'visual-state.jsonl'))) {
    try { & $VisualReport -Capture $LiveCapture | Out-Host } catch { Warn ('Visual summary failed: ' + $_.Exception.Message) }
  }
  exit 1
}
