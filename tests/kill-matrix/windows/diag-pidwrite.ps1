$t = Join-Path $env:TEMP 'pidfile-test.txt'
$procId = 12345
$created = '63925979'
$stamp = 'cluely-root-test'
Set-Content -Path $t -Encoding ASCII -Value @(
  "PID=$procId"
  "CREATED=$created"
  "STAMP=$stamp"
)
$lines = Get-Content $t
Write-Output ("lines: " + $lines.Count)
$lines | ForEach-Object { Write-Output ("[" + $_ + "]") }
Remove-Item $t -Force
