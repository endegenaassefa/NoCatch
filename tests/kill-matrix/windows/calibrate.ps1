param(
  [Parameter(Position = 0)]
  [ValidateSet('Run', 'Admin')]
  [string]$Command = 'Run',
  [switch]$AuditOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Watch = Join-Path $Here 'watch.ps1'
$Root = Join-Path $Here 'capture'
$Gate = Join-Path $Root 'calibration-gate.json'
$Done = Join-Path $Root 'medium.done'
$Ps = (Get-Command powershell.exe).Source

function Save-Json([string]$Path, $Value) {
  [System.IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
}
function Created([int]$Id) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $Id) -ErrorAction SilentlyContinue
  if (-not $p) { return '' }
  return $p.CreationDate.ToUniversalTime().Ticks.ToString()
}
function Is-Alive([int]$Id, [string]$Ticks) { return (Created $Id) -eq $Ticks }

New-Item -ItemType Directory -Path $Root -Force | Out-Null
if ($Command -eq 'Run') {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this phase from a normal, unelevated PowerShell.' }
  if (Test-Path $Gate) { throw ('Old calibration gate exists: ' + $Gate) }
  if (Test-Path (Join-Path $Root 'active.json')) { throw 'Another watcher capture is active. Stop it before calibrating.' }
  $errorFile = Join-Path $Root 'setup-error.txt'
  if (Test-Path $errorFile) { Remove-Item -LiteralPath $errorFile -Force }
  $arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" Admin'
  if ($AuditOnly) { $arg += ' -AuditOnly' }
  Start-Process -FilePath $Ps -ArgumentList $arg -Verb RunAs -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Path $Gate) -and -not (Test-Path $errorFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-Path $errorFile) { throw ('Administrator setup failed: ' + (Get-Content $errorFile -Raw)) }
  if (-not (Test-Path $Gate)) { throw 'Administrator setup did not publish a ready scratch target. Check UAC and capture/setup-error.txt.' }
  $gateData = Get-Content $Gate -Raw | ConvertFrom-Json
  $mediumResult = ''
  try {
    if (-not (Is-Alive ([int]$gateData.pid) ([string]$gateData.created))) { throw 'Scratch PID identity changed before medium attempt.' }
    $mediumTarget = Get-Process -Id ([int]$gateData.pid) -ErrorAction Stop
    if ([math]::Abs($mediumTarget.StartTime.ToUniversalTime().Ticks - [long]$gateData.created) -gt 10000) { throw 'Scratch process generation changed before medium attempt.' }
    Stop-Process -InputObject $mediumTarget -Force -ErrorAction Stop
    $mediumResult = 'SUCCEEDED_UNEXPECTEDLY'
  } catch {
    if ($_.Exception.Message -match '(?i)access is denied') { $mediumResult = 'DENIED: ' + $_.Exception.Message }
    else { $mediumResult = 'ERROR: ' + $_.Exception.Message }
  }
  $alive = Is-Alive ([int]$gateData.pid) ([string]$gateData.created)
  Save-Json (Join-Path $gateData.capture 'medium-result.json') ([ordered]@{ result = $mediumResult; alive = $alive; atUtc = (Get-Date).ToUniversalTime().ToString('o') })
  New-Item -ItemType File -Path $Done -Force | Out-Null
  Write-Host ('[OK]   Medium attempt: ' + $mediumResult + '; scratch alive: ' + $alive)
  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-Path (Join-Path $gateData.capture 'calibration.json')) -and -not (Test-Path $errorFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-Path $errorFile) { throw ('Administrator calibration failed: ' + (Get-Content $errorFile -Raw)) }
  if (Test-Path (Join-Path $gateData.capture 'calibration.json')) { Write-Host ('[OK]   Calibration evidence: ' + $gateData.capture) }
  else { Write-Host ('[WARN] Administrator kill phase did not finish. Inspect ' + $gateData.capture) }
  return
}

$scratch = $null
$ticks = ''
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Admin phase did not elevate.' }
  if (Test-Path (Join-Path $Root 'active.json')) { throw 'Another watcher capture is active. Stop it before calibrating.' }
  if (-not $AuditOnly) {
    $sysmon = Get-WinEvent -ListLog 'Microsoft-Windows-Sysmon/Operational' -ErrorAction Stop
    if (-not $sysmon.IsEnabled) { throw 'Sysmon log is disabled. Run watch.ps1 Setup first.' }
  }
  $scratch = Start-Process -FilePath (Join-Path $env:WINDIR 'system32\ping.exe') -ArgumentList '-t 127.0.0.1' -WindowStyle Hidden -PassThru
  $launchedTicks = $scratch.StartTime.ToUniversalTime().Ticks
  Start-Sleep -Seconds 2
  $ticks = Created $scratch.Id
  if (-not $ticks) { throw 'Scratch ping process did not remain alive.' }
  if ([math]::Abs([long]$ticks - $launchedTicks) -gt 10000) { throw 'Scratch PID changed generation after launch.' }
  $args = '-NoProfile -ExecutionPolicy Bypass -File "' + $Watch + '" Start -TargetPid ' + $scratch.Id
  if ($AuditOnly) { $args += ' -AuditOnly' }
  $watcher = Start-Process -FilePath $Ps -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Root 'watcher-out.txt') -RedirectStandardError (Join-Path $Root 'watcher-err.txt')
  $deadline = (Get-Date).AddSeconds(15)
  $activeFile = Join-Path $Root 'active.json'
  while (-not (Test-Path $activeFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path $activeFile)) { throw 'Watcher did not start.' }
  $active = Get-Content $activeFile -Raw | ConvertFrom-Json
  if ([int]$active.rootPid -ne $scratch.Id -or [string]$active.rootCreated -ne $ticks -or [int]$active.watcherPid -ne $watcher.Id) {
    throw 'Watcher capture identity does not match scratch; refusing to stop or attach evidence to it.'
  }
  Save-Json $Gate ([ordered]@{ pid = $scratch.Id; created = $ticks; capture = $active.capture })
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Path $Done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path $Done)) { throw 'Medium phase did not complete within 90 seconds.' }
  $medium = Get-Content (Join-Path $active.capture 'medium-result.json') -Raw | ConvertFrom-Json
  if ([string]$medium.result -notmatch '^DENIED:' -or $medium.alive -ne $true) { throw 'Medium denial and survival gate failed; elevated kill was not attempted.' }
  Start-Sleep -Seconds 3
  $elevatedResult = ''
  $killLine = '$p=Get-Process -Id ' + $scratch.Id + ' -ErrorAction Stop; if ([math]::Abs($p.StartTime.ToUniversalTime().Ticks - [long]' + $ticks + ') -gt 10000) { throw "Scratch generation changed" }; Stop-Process -InputObject $p -Force -ErrorAction Stop'
  $killer = Start-Process -FilePath $Ps -ArgumentList @('-NoProfile','-Command',$killLine) -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput (Join-Path $active.capture 'elevated-stop.out.txt') -RedirectStandardError (Join-Path $active.capture 'elevated-stop.err.txt')
  if ($killer.ExitCode -eq 0) { $elevatedResult = 'SUCCEEDED (separate PowerShell PID ' + $killer.Id + ')' }
  else { $elevatedResult = 'FAILED exit ' + $killer.ExitCode + ' (separate PowerShell PID ' + $killer.Id + ')' }
  Start-Sleep -Seconds 6
  $aliveAfter = Is-Alive $scratch.Id $ticks
  & $Watch Stop -Capture $active.capture
  if (-not $watcher.WaitForExit(10000)) { throw 'Watcher did not finish within 10 seconds after stop.' }
  Save-Json (Join-Path $active.capture 'calibration.json') ([ordered]@{
    targetPid = $scratch.Id; targetCreated = $ticks
    mediumResult = $medium.result; aliveAfterMedium = $medium.alive
    elevatedResult = $elevatedResult; aliveAfterElevated = $aliveAfter
    watcherPid = $watcher.Id
  })
  & $Watch Report -Capture $active.capture
  if (Test-Path (Join-Path $active.capture 'capture-error.txt')) { throw 'Watcher failed during calibration; see capture-error.txt.' }
} catch {
  [System.IO.File]::WriteAllText((Join-Path $Root 'setup-error.txt'), $_.Exception.ToString())
  if ($scratch -and $ticks -and (Is-Alive $scratch.Id $ticks)) {
    Stop-Process -InputObject $scratch -Force -ErrorAction SilentlyContinue
  }
} finally {
  if (Test-Path $Gate) { Remove-Item -LiteralPath $Gate -Force }
  if (Test-Path $Done) { Remove-Item -LiteralPath $Done -Force }
}
