$p = Start-Process -FilePath 'C:\Users\endeg\Desktop\NoCatch\dist\OpenCluely-Setup-1.0.0-x64.exe' -PassThru
Write-Output ("started PID " + $p.Id + " at " + (Get-Date -Format 'HH:mm:ss'))
$p.WaitForExit()
Write-Output ("exited at " + (Get-Date -Format 'HH:mm:ss') + " with code " + $p.ExitCode)
