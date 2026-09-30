Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
  Select-Object ProcessId, @{n='Start';e={$_.CreationDate}}, @{n='CL';e={$_.CommandLine}} | Format-List
