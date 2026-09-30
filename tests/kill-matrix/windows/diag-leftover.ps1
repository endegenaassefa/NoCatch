Write-Output "=== leftover launcher/elevated shells ==="
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'cluely-admin' } | Select-Object Name, ProcessId, CommandLine | Format-List
Write-Output "=== root app processes ==="
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'CluelyRoot' } | Select-Object Name, ProcessId | Format-Table -AutoSize
Write-Output "=== done ==="
