Write-Output "=== recent Defender detections/blocks (last 30 min) ==="
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=(Get-Date).AddMinutes(-30)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 1116,1117,1118,1119,1121,5007 } |
  Select-Object TimeCreated, Id, @{n='Msg';e={($_.Message -split "`n")[0]}} | Format-List
Write-Output "=== AppLocker/SmartScreen blocks? ==="
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-AppLocker/EXE and DLL'; StartTime=(Get-Date).AddMinutes(-30)} -ErrorAction SilentlyContinue |
  Select-Object TimeCreated, Id, @{n='Msg';e={($_.Message -split "`n")[0]}} | Format-List
Write-Output "=== done ==="
