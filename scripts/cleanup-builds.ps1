$targets = @(
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-privileged-20260925\win-unpacked-v3',
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-test-ready',
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-test-quit-ready',
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-next',
  'C:\Users\endeg\Desktop\NoCatch\.depthengine\windows-next-final'
)
$log = 'C:\Users\endeg\Desktop\NoCatch\cleanup-log3.txt'
Remove-Item $log -Force -ErrorAction SilentlyContinue
foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t)) { Add-Content $log ("absent: " + $t); continue }
  Add-Content $log ("granting: " + $t)
  cmd.exe /c ('icacls "' + $t + '" /grant "LI2\endeg:(OI)(CI)F" /T /C /Q >nul 2>&1') | Out-Null
  try {
    Remove-Item -LiteralPath ("\\?\" + $t) -Recurse -Force -ErrorAction Stop
    Add-Content $log ("ok: " + $t)
  } catch {
    Add-Content $log ("Remove-Item failed, trying rmdir: " + $t)
    cmd.exe /c ('rmdir /S /Q "' + $t + '" >nul 2>&1') | Out-Null
    if (Test-Path -LiteralPath $t) { Add-Content $log ("  FAILED: " + $t) } else { Add-Content $log ("  ok via rmdir: " + $t) }
  }
}
Add-Content $log "CLEANUP-DONE"
