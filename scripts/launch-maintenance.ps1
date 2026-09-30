Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\endeg\Desktop\NoCatch\scripts\elevated-maintenance.ps1'
Write-Output "maintenance launched - UAC prompt visible now"
