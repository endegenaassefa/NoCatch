# One-shot elevated maintenance (self-elevating, like cluely-admin):
# sweeps orphaned root-profile processes, then silently reinstalls the
# fresh package over the hardened install dir. Progress is written to
# %TEMP%\maintenance-status.txt for the coordinator to read.
param([switch]$FromElevated)

$Status = Join-Path $env:TEMP 'maintenance-status.txt'
function Write-Status([string]$Msg) {
  Write-Host $Msg
  Add-Content -Path $Status -Value ("[$(Get-Date -Format 'HH:mm:ss')] " + $Msg) -Encoding ASCII
}

Remove-Item $Status -Force -ErrorAction SilentlyContinue
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $FromElevated) {
  Write-Status 'requesting elevation (click Yes on the UAC prompt)'
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-FromElevated')
  # The UAC dialog itself blocks ShellExecute until answered; once the
  # elevated child is up, poll the status file for the finish marker.
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if ((Test-Path $Status) -and (Select-String -Path $Status -Pattern 'MAINTENANCE-DONE' -Quiet -ErrorAction SilentlyContinue)) {
      Write-Status 'maintenance completed'
      exit 0
    }
  }
  Write-Status 'timed out waiting for maintenance'
  exit 1
}

# ── Elevated from here on ──
Write-Status 'elevated; sweeping root-profile orphans'
$targets = Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'CluelyRoot' }
if ($targets) {
  foreach ($t in $targets) {
    Write-Status ("killing PID " + $t.ProcessId)
    cmd.exe /c ("taskkill /T /F /PID " + $t.ProcessId + " >nul 2>&1") | Out-Null
  }
  Start-Sleep -Seconds 3
} else {
  Write-Status 'no orphans found'
}
$left = Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'CluelyRoot' }
if ($left) {
  Write-Status ('STILL ALIVE: ' + (($left | ForEach-Object { $_.ProcessId }) -join ', '))
  exit 1
}
Write-Status 'orphans cleared; reinstalling'
$p = Start-Process -FilePath 'C:\Users\endeg\Desktop\NoCatch\dist\OpenCluely-Setup-1.0.0-x64.exe' -ArgumentList '/S' -PassThru -Wait
Write-Status ("installer exited with code " + $p.ExitCode)
Write-Status 'MAINTENANCE-DONE'
