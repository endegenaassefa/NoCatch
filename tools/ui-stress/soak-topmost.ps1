# Long-duration soak for the sync topmost guard.
# Phase 1 (compressed): 20 Hz flat strip rate — N minutes of attacks worth
#   ~3.3 exam-hours per minute at the exam's real 1 Hz cadence.
# Phase 2 (realistic): 1 Hz baseline with random 33 Hz bursts for M minutes,
#   matching the observed LockDown Browser behavior (steady strip + burst),
#   with continuous background sampling.
# Verdict: zero demoted observations = PASS.
param(
  [int]$CompressedMinutes = 10,
  [int]$RealisticMinutes = 60,
  [int]$TightSampleMs = 10
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot ''
$hwndFile = Join-Path $dir 'probe-hwnd.txt'
$outFile = Join-Path $dir 'soak-results.txt'
$progressFile = Join-Path $dir 'soak-progress.txt'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
  public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
  public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
}
"@

function Get-Topmost([IntPtr]$hwnd) {
  return (([Win]::GetWindowLongPtr($hwnd, -20)).ToInt64() -band 0x8) -ne 0
}

# Wait for the probe window (max 30 s)
$hwnd = [IntPtr]::Zero
$hex = ''
for ($i = 0; $i -lt 300; $i++) {
  if (Test-Path $hwndFile) {
    $hex = (Get-Content $hwndFile -Raw).Trim()
    if ($hex) {
      $hwnd = [IntPtr]([Convert]::ToInt64($hex, 16))
      if ([Win]::IsWindow($hwnd)) { break }
    }
  }
  Start-Sleep -Milliseconds 100
}
if ($hwnd -eq [IntPtr]::Zero -or -not [Win]::IsWindow($hwnd)) {
  "FAIL: probe window not found" | Set-Content $outFile
  Write-Output "FAIL: probe window not found"
  exit 1
}

$GWLEX = -20
$NOTOPMOST = [IntPtr](-2)
$FLAGS = 0x0002 -bor 0x0001 -bor 0x0010  # SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE
$script:demotedAfter = 0
$script:demotedSamples = 0
$script:totalSamples = 0
$script:attacks = 0
$sw = New-Object System.Diagnostics.Stopwatch
$rand = New-Object System.Random

function Invoke-Attack {
  $script:attacks++
  $style = [Win]::GetWindowLongPtr($hwnd, $GWLEX).ToInt64()
  [void][Win]::SetWindowLongPtr($hwnd, $GWLEX, [IntPtr]($style -band (-bnot 0x8)))
  [void][Win]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $FLAGS)
  if (-not (Get-Topmost $hwnd)) { $script:demotedAfter++ }
}

function Sample-Tight([int]$ms) {
  $sw.Restart()
  while ($sw.ElapsedMilliseconds -lt $ms) {
    $script:totalSamples++
    if (-not (Get-Topmost $hwnd)) { $script:demotedSamples++ }
  }
}

function Sample-Once {
  $script:totalSamples++
  if (-not (Get-Topmost $hwnd)) { $script:demotedSamples++ }
}

function Report([string]$phase, [int]$elapsedMin) {
  $line = "[$phase] t+${elapsedMin}m attacks=$($script:attacks) demotedAfter=$($script:demotedAfter) demotedSamples=$($script:demotedSamples) samples=$($script:totalSamples)"
  Add-Content -Path $progressFile -Value $line
  Write-Output $line
}

"soak start $(Get-Date -Format o) hwnd=$hex" | Set-Content $outFile
"" | Set-Content $progressFile

# ---------------- Phase 1: compressed 20 Hz ----------------
$phaseEnd = (Get-Date).AddMinutes($CompressedMinutes)
$lastReport = Get-Date
while ((Get-Date) -lt $phaseEnd) {
  Invoke-Attack
  Sample-Tight $TightSampleMs
  Start-Sleep -Milliseconds 40   # ~20 Hz
  if ((Get-Date).Subtract($lastReport).TotalSeconds -ge 60) { $lastReport = Get-Date; Report 'compressed' ([int]($CompressedMinutes - $phaseEnd.Subtract((Get-Date)).TotalMinutes)) }
}
Report 'compressed' $CompressedMinutes

# ---------------- Phase 2: realistic 1 Hz + bursts ----------------
$phaseEnd = (Get-Date).AddMinutes($RealisticMinutes)
$lastReport = Get-Date
while ((Get-Date) -lt $phaseEnd) {
  Invoke-Attack
  if ($rand.Next(100) -lt 10) {
    # LDB-style burst: 10 extra strips at 33 Hz
    for ($b = 0; $b -lt 10; $b++) {
      Invoke-Attack
      Start-Sleep -Milliseconds 30
    }
  }
  # continuous low-rate sampling between attacks
  $sampleWindowEnd = (Get-Date).AddMilliseconds(800)
  while ((Get-Date) -lt $sampleWindowEnd -and (Get-Date) -lt $phaseEnd) {
    Sample-Once
    Start-Sleep -Milliseconds 5
  }
  if ((Get-Date).Subtract($lastReport).TotalSeconds -ge 60) { $lastReport = Get-Date; Report 'realistic' ([int]($RealisticMinutes - $phaseEnd.Subtract((Get-Date)).TotalMinutes)) }
}
Report 'realistic' $RealisticMinutes

$verdict = if ($script:demotedAfter -eq 0 -and $script:demotedSamples -eq 0) { 'PASS' } else { 'FAIL' }
$summary = "VERDICT=$verdict totalAttacks=$($script:attacks) demotedAfterAttack=$($script:demotedAfter) demotedSamples=$($script:demotedSamples) totalSamples=$($script:totalSamples) end=$(Get-Date -Format o)"
Add-Content -Path $outFile -Value $summary
Write-Output $summary
exit $(if ($verdict -eq 'PASS') { 0 } else { 2 })
