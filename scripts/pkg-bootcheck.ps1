# pkg-bootcheck.ps1 -- boots the PACKAGED win-unpacked app (the exact binary
# `cluely system` launches) at normal integrity with a throwaway profile,
# waits for the boot marker, then kills it. No UAC, no lasting state.
param([string]$Exe = '')
$ErrorActionPreference = 'Stop'
if (-not $Exe) {
  $repo = Split-Path -Parent $PSScriptRoot
  $Exe = Join-Path $repo 'dist\win-unpacked\screen-reader-util.exe'
}
if (-not (Test-Path $Exe)) { Write-Host 'PKG-BOOTCHECK: SKIP (no packaged exe)'; exit 2 }
$profile = Join-Path $env:TEMP 'cluely-pkg-bootcheck'
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
$logFile = Join-Path $env:USERPROFILE ('.screen-reader-util\logs\application-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
$lenBefore = if (Test-Path $logFile) { (Get-Item $logFile).Length } else { 0 }

function Read-TailFrom([long]$offset) {
  if (-not (Test-Path $logFile)) { return '' }
  $fs = [System.IO.File]::Open($logFile, 'Open', 'Read', 'ReadWrite')
  try {
    $len = $fs.Length
    if ($len -le $offset) { return '' }
    $fs.Seek($offset, 'Begin') | Out-Null
    $buf = New-Object byte[] ($len - $offset)
    $read = $fs.Read($buf, 0, $buf.Length)
    return [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
  } finally { $fs.Close() }
}

$p = Start-Process -FilePath $Exe -ArgumentList @('--user-data-dir="' + $profile + '"', '--cluely-root-run=pkgbootcheck') -PassThru
$deadline = (Get-Date).AddSeconds(60)
$ok = $false
while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
  Start-Sleep -Seconds 2
  $tail = Read-TailFrom $lenBefore
  if ($tail -match 'Application initialized successfully') { $ok = $true; break }
  if ($tail -match 'FATAL|Uncaught') { break }
}
if ($ok) {
  Write-Host ('PKG-BOOTCHECK: PASS -- packaged app (PID ' + $p.Id + ') reached the boot marker.')
} else {
  Write-Host 'PKG-BOOTCHECK: FAIL -- boot marker not reached in 60s.'
  Write-Host '--- last log lines ---'
  Get-Content $logFile -Tail 15 -ErrorAction SilentlyContinue
}
taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
Start-Sleep -Seconds 2
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
exit $(if ($ok) { 0 } else { 1 })
