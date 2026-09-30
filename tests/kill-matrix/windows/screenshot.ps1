Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0, 0, 0, 0, $b.Size)
$b.Save('C:\Users\endeg\Desktop\NoCatch\installer-state.png')
Write-Output "saved"
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'OpenCluely|Uninstall' } | Select-Object Name, ProcessId | Format-Table -AutoSize
