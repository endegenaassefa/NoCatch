$procs = Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -notmatch 'CluelyRoot' }
foreach ($p in $procs) {
  Write-Output ("closing PID " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$left = (Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output ("remaining: " + $left)
