Write-Output "=== screen-reader processes ==="
Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
  Select-Object ProcessId, @{n='Start';e={$_.CreationDate}}, @{n='CmdTail';e={ if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(110, $_.CommandLine.Length)) } else { '(elevated: cmdline hidden)' } }} | Format-List
Write-Output "=== count ==="
(Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue | Measure-Object).Count
