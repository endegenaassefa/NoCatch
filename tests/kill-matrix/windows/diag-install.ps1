Write-Output "=== procs ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'OpenCluely|screen-reader|Uninstall' } | Select-Object Name, ProcessId | Format-Table -AutoSize
Write-Output "=== uninstall entries ==="
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
  ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p.DisplayName -match 'screen') { Write-Output ("KEY " + $_.PSChildName + " -> " + $p.DisplayName) } }
Write-Output "=== start menu ==="
Get-ChildItem 'C:\Users\endeg\AppData\Roaming\Microsoft\Windows\Start Menu\Programs' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'screen|OpenCluely' } | ForEach-Object { Write-Output ($_.Name + " (" + $_.Length + " bytes)") }
Write-Output "=== desktop ==="
Get-ChildItem 'C:\Users\endeg\Desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'screen|OpenCluely' } | ForEach-Object { Write-Output ($_.Name + " (" + $_.Length + " bytes)") }
Write-Output "=== install dir file count ==="
(Get-ChildItem 'C:\Users\endeg\AppData\Local\Programs\screen-reader-util' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
