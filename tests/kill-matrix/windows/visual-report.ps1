param([Parameter(Mandatory = $true)][string]$Capture)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Capture = (Resolve-Path -LiteralPath $Capture).Path
$inputPath = Join-Path $Capture 'visual-state.jsonl'
if (-not (Test-Path -LiteralPath $inputPath)) { throw ('No visual-state.jsonl in ' + $Capture) }

$count = 0
$browserCount = 0
$firstUtc = ''
$lastUtc = ''
$visibleDuringBrowser = 0
$visibleWithoutTopmost = 0
$coveredByBrowser = 0
$visibleAll = 0
$notTopmostAll = 0
$coveredAll = 0
$examples = New-Object 'System.Collections.Generic.List[string]'
$malformed = 0

foreach ($line in [System.IO.File]::ReadLines($inputPath)) {
  if (-not $line) { continue }
  try { $row = $line | ConvertFrom-Json } catch { $malformed++; continue }
  $count++
  if (-not $firstUtc) { $firstUtc = [string]$row.utc }
  $lastUtc = [string]$row.utc
  $visibleWindows = @($row.windows | Where-Object { $_.role -eq 'cluely' -and $_.visibleStyle -and $_.cloaked -eq 0 -and $_.width -gt 0 -and $_.height -gt 0 })
  foreach ($window in $visibleWindows) {
    $visibleAll++
    if (-not $window.topmost) { $notTopmostAll++ }
    if (@($window.fullyCoveredBy).Count -gt 0) { $coveredAll++ }
  }
  if (@($row.browserPids).Count -eq 0) { continue }
  $browserCount++
  $browserIds = @($row.browserPids | ForEach-Object { [int]$_ })
  foreach ($window in $visibleWindows) {
    $visibleDuringBrowser++
    if (-not $window.topmost) { $visibleWithoutTopmost++ }
    $browserCover = @($window.fullyCoveredBy | Where-Object { $browserIds -contains [int]$_.pid })
    if ($browserCover.Count -gt 0) {
      $coveredByBrowser++
      if ($examples.Count -lt 5) { $examples.Add('- ' + $row.utc + ': browser PID ' + $browserCover[0].pid + ' was above and covered Cluely HWND ' + $window.hwnd + ' (Cluely z=' + $window.z + ').') }
    }
  }
}

$complete = Test-Path -LiteralPath (Join-Path $Capture 'visual-ended.txt')
$lines = @(
  '# Windows visual-state report',
  '',
  ('Capture: `' + $Capture + '`'),
  '',
  ('- Samples: ' + $count + ' (' + $firstUtc + ' to ' + $lastUtc + ' UTC).'),
  ('- Visible-style, uncloaked Cluely window observations in all samples: ' + $visibleAll + '.'),
  ('- Of those, without the Windows topmost style: ' + $notTopmostAll + '.'),
  ('- Of those, geometrically fully covered by any higher window: ' + $coveredAll + '.'),
  ('- Samples while LockDown Browser process existed: ' + $browserCount + '.'),
  ('- Visible-style, uncloaked Cluely window observations during Browser: ' + $visibleDuringBrowser + '.'),
  ('- Of those, without the Windows topmost style: ' + $visibleWithoutTopmost + '.'),
  ('- Of those, geometrically fully covered by a higher LockDown Browser window: ' + $coveredByBrowser + '.'),
  ('- Recorder completed normally: ' + $complete + '. Malformed lines skipped: ' + $malformed + '.'),
  '',
  '## Examples',
  ''
)
if ($examples.Count) { $lines += @($examples | ForEach-Object { [string]$_ }) }
else { $lines += 'No browser-over-Cluely full-coverage example was captured.' }
$lines += @(
  '',
  '## Interpretation',
  '',
  'This file records window IDs, process IDs, Z order, bounds, topmost style, visible style, and DWM cloaking. It does not record pixels, window titles, exam text, or a human observation of the menu. A visible-style window may still be completely hidden by another window. Geometry alone cannot prove the user could or could not see the menu. Match these UTC times to the user-observed question-page and hotkey times. If the recorder stopped early, missing samples are unknown.',
  ''
)
$report = Join-Path $Capture 'visual-report.md'
[System.IO.File]::WriteAllLines($report, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('[OK]   ' + $report)
