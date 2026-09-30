# Final one-click end-to-end acceptance: reinstall the fixed build, then
# run the installed launcher's start AND stop elevated (same elevation
# session => ONE UAC click), verifying the whole friend journey.
param([switch]$FromElevated)

$Status = Join-Path $env:TEMP 'e2e-status.txt'
$Launcher = 'C:\Users\endeg\AppData\Local\Programs\screen-reader-util\resources\launcher\cluely-admin.ps1'
function Write-Status([string]$Msg) {
  Write-Host $Msg
  Add-Content -Path $Status -Value ("[$(Get-Date -Format 'HH:mm:ss')] " + $Msg) -Encoding ASCII
}
function Get-Marked {
  Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'CluelyRoot' }
}

Remove-Item $Status -Force -ErrorAction SilentlyContinue
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $FromElevated) {
  Write-Status 'requesting elevation (click Yes on the UAC prompt)'
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-FromElevated')
  $deadline = (Get-Date).AddSeconds(600)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if ((Test-Path $Status) -and (Select-String -Path $Status -Pattern 'E2E-DONE|E2E-FAILED' -Quiet -ErrorAction SilentlyContinue)) {
      Write-Status 'e2e finished (see status file)'
      exit 0
    }
  }
  Write-Status 'timed out'
  exit 1
}

# ── Elevated from here on ──
Write-Status 'elevated: sweeping strays'
foreach ($t in @(Get-Marked)) {
  cmd.exe /c ("taskkill /T /F /PID " + $t.ProcessId + " >nul 2>&1") | Out-Null
}
Start-Sleep -Seconds 3

Write-Status 'fresh-install prep (remove prior install + registry + shortcuts)'
Remove-Item 'C:\Users\endeg\AppData\Local\Programs\screen-reader-util' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\endeg\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\OpenCluely (Admin).lnk' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\endeg\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\screen-reader-util.lnk' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\endeg\Desktop\OpenCluely (Admin).lnk' -Force -ErrorAction SilentlyContinue
Remove-Item 'C:\Users\endeg\Desktop\screen-reader-util.lnk' -Force -ErrorAction SilentlyContinue
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DisplayName -match 'screen') { Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue } }
Remove-Item 'HKCU:\Software\com.screenreaderutil.app' -Recurse -Force -ErrorAction SilentlyContinue

Write-Status 'reinstalling'
$p = Start-Process -FilePath 'C:\Users\endeg\Desktop\NoCatch\dist\OpenCluely-Setup-1.0.0-x64.exe' -ArgumentList '/S' -PassThru -Wait
Write-Status ("installer exit code " + $p.ExitCode)
if ($p.ExitCode -ne 0) { Write-Status 'E2E-FAILED install'; exit 1 }

Write-Status 'starting root mode via installed launcher'
& $Launcher start -FromElevated
$startCode = $LASTEXITCODE
Write-Status ("launcher start exit code " + $startCode)
Start-Sleep -Seconds 3
$running = @(Get-Marked)
Write-Status ("marked processes after start: " + $running.Count)
if ($running.Count -eq 0) { Write-Status 'E2E-FAILED start'; exit 1 }
$stateFile = Join-Path $env:TEMP 'cluely-root-state.txt'
Write-Status ("state file present: " + (Test-Path $stateFile))

Write-Status 'stopping root mode via installed launcher'
& $Launcher stop -FromElevated
$stopCode = $LASTEXITCODE
Write-Status ("launcher stop exit code " + $stopCode)
$survivors = @(Get-Marked)
Write-Status ("marked processes after stop: " + $survivors.Count)
$clean = $true
foreach ($f in @('cluely-root-state.txt','cluely-root.pid','cluely-root-boot.log','cluely-root-boot.err')) {
  $present = Test-Path (Join-Path $env:TEMP $f)
  Write-Status ("temp $f present: " + $present)
  if ($present) { $clean = $false }
}
if ($survivors.Count -gt 0 -or -not $clean) {
  Write-Status 'E2E-FAILED stop'
  exit 1
}
Write-Status 'E2E-DONE'
