Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'OpenCluely-Setup' } | ForEach-Object {
  Write-Output ("killing PID " + $_.ProcessId)
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$left = Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'OpenCluely-Setup' }
if ($left) { Write-Output ("STILL ALIVE: " + $left.ProcessId) } else { Write-Output "no installer processes remain" }
