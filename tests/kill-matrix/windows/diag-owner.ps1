foreach ($p in @(
  'C:\Users\endeg\Desktop\NoCatch\.depthengine',
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-test-ready',
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-privileged-20260925\win-unpacked-v3'
)) {
  try {
    $acl = Get-Acl -LiteralPath $p -ErrorAction Stop
    Write-Output ($p + "  owner=" + $acl.Owner)
  } catch {
    Write-Output ($p + "  ACL-READ-FAILED: " + $_.Exception.Message)
  }
}
