Write-Output "=== app crash events (last 15 min) ==="
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-15)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 1000,1001,1026 } | Select-Object TimeCreated, @{n='Msg';e={($_.Message -split "`n")[0..3] -join ' | '}} | Format-List
Write-Output "=== Defender blocks (last 15 min) ==="
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=(Get-Date).AddMinutes(-15)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 1116,1117,1118,1119,1121 } | Select-Object TimeCreated, Id, @{n='Msg';e={($_.Message -split "`n")[0]}} | Format-List
Write-Output "=== done ==="
