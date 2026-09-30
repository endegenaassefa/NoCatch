$sh = New-Object -ComObject WScript.Shell
foreach ($p in @(
  'C:\Users\endeg\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\OpenCluely (Admin).lnk',
  'C:\Users\endeg\Desktop\OpenCluely (Admin).lnk',
  'C:\Users\endeg\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\screen-reader-util.lnk'
)) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Output ("MISSING: " + $p); continue }
  $s = $sh.CreateShortcut($p)
  Write-Output ("LNK: " + $p)
  Write-Output ("  Target: " + $s.TargetPath)
  Write-Output ("  Args:   " + $s.Arguments)
}
