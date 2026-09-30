$pidFile = Join-Path $env:TEMP 'cluely-root.pid'
$pidLine = (Select-String -Path $pidFile -Pattern '^PID=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1)
$createdLine = (Select-String -Path $pidFile -Pattern '^CREATED=(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1)
$thePid = [int]$pidLine.Matches[0].Groups[1].Value
$fileCreated = $createdLine.Matches[0].Groups[1].Value
Write-Output ("pidfile: PID=" + $thePid + " CREATED=" + $fileCreated)
$p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $thePid) -ErrorAction SilentlyContinue
if ($p) {
  $created = $p.CreationDate
  $ticks = ''
  if ($created -is [datetime]) { $ticks = $created.ToUniversalTime().Ticks.ToString() }
  else { try { $ticks = ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created)).ToUniversalTime().Ticks.ToString() } catch { $ticks = 'ERR' } }
  Write-Output ("live WMI ticks: " + $ticks)
  Write-Output ("MATCH: " + ($ticks -eq $fileCreated))
  Write-Output ("name: " + $p.Name)
  Write-Output ("cmdline: " + $p.CommandLine)
} else {
  Write-Output "pidfile PID not found"
}
Write-Output "=== all marked processes ==="
Get-CimInstance Win32_Process -Filter "Name='screen-reader-util.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'CluelyRoot' } | ForEach-Object { Write-Output ($_.ProcessId.ToString() + "  " + $_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length))) }
