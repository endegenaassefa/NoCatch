# Zero-frame attacker for probe-sync-guard.js.
# Simulates the exam app's strip: SetWindowLong(GWL_EXSTYLE, clear WS_EX_TOPMOST)
# + SetWindowPos(HWND_NOTOPMOST). After every attack pair, reads the victim's
# style bit IMMEDIATELY (inside the same call) and then tight-samples ~1 ms
# for 30 ms to catch transient demotions. PASS = zero demoted observations.
param(
  [int]$SingleRounds = 60,
  [int]$SingleIntervalMs = 250,
  [int]$BurstRounds = 30,
  [int]$BurstIntervalMs = 30,
  [string]$HwndOverride = '',
  [switch]$DestroyOnly
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot ''
$hwndFile = Join-Path $dir 'probe-hwnd.txt'
$outFile = Join-Path $dir 'probe-attack-results.txt'

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
  [DllImport("user32.dll")]
  public static extern bool DestroyWindow(IntPtr hWnd);
}
"@

function Get-Topmost([IntPtr]$hwnd) {
  return (([Win]::GetWindowLongPtr($hwnd, -20)).ToInt64() -band 0x8) -ne 0
}

$hex = $null
if ($HwndOverride) {
  $hex = $HwndOverride.Trim()
  $hwnd = [IntPtr]([Convert]::ToInt64($hex, 16))
  if (-not [Win]::IsWindow($hwnd)) { "FAIL: hwnd $hex is not a window" | Set-Content $outFile; exit 1 }
} else {
  # Wait for the probe window (max 20 s)
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 200; $i++) {
    if (Test-Path $hwndFile) {
      $hex = (Get-Content $hwndFile -Raw).Trim()
      $hwnd = [IntPtr]([Convert]::ToInt64($hex, 16))
      if ([Win]::IsWindow($hwnd)) { break }
    }
    Start-Sleep -Milliseconds 100
  }
  if ($hwnd -eq [IntPtr]::Zero -or -not [Win]::IsWindow($hwnd)) {
    "FAIL: probe window not found" | Set-Content $outFile
    exit 1
  }
}

if ($DestroyOnly) {
  $ok = [Win]::DestroyWindow($hwnd)
  "DESTROY hwnd=$hex ok=$ok" | Set-Content $outFile
  Write-Output "DESTROY hwnd=$hex ok=$ok"
  exit $(if ($ok) { 0 } else { 2 })
}

$GWLEX = -20
$NOTOPMOST = [IntPtr](-2)
$FLAGS = 0x0002 -bor 0x0001 -bor 0x0010  # SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE
$sw = New-Object System.Diagnostics.Stopwatch
$demotedAfterCall = 0
$demotedSamples = 0
$totalSamples = 0

function Invoke-Attack {
  $style = [Win]::GetWindowLongPtr($hwnd, $GWLEX).ToInt64()
  $stripped = $style -band (-bnot 0x8)
  [void][Win]::SetWindowLongPtr($hwnd, $GWLEX, [IntPtr]$stripped)
  [void][Win]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $FLAGS)
}

function Sample-Tight([int]$ms) {
  $script:sw.Restart()
  while ($script:sw.ElapsedMilliseconds -lt $ms) {
    $script:totalSamples++
    if (-not (Get-Topmost $hwnd)) { $script:demotedSamples++ }
  }
}

$lines = @("attacker start $(Get-Date -Format o) hwnd=$hex")
foreach ($round in 1..$SingleRounds) {
  Invoke-Attack
  if (-not (Get-Topmost $hwnd)) { $demotedAfterCall++; $lines += "round $round : DEMOTED after attack pair" }
  Sample-Tight 30
  Start-Sleep -Milliseconds $SingleIntervalMs
}
$lines += "phase single done: demotedAfterCall=$demotedAfterCall demotedSamples=$demotedSamples totalSamples=$totalSamples"
$burstStart = Get-Date
foreach ($round in 1..$BurstRounds) {
  Invoke-Attack
  if (-not (Get-Topmost $hwnd)) { $demotedAfterCall++; $lines += "burst $round : DEMOTED after attack pair" }
  Start-Sleep -Milliseconds $BurstIntervalMs
}
Sample-Tight 100
$lines += "phase burst done: demotedAfterCall=$demotedAfterCall demotedSamples=$demotedSamples totalSamples=$totalSamples"
$attacks = $SingleRounds + $BurstRounds
$verdict = if ($demotedAfterCall -eq 0 -and $demotedSamples -eq 0) { "PASS" } else { "FAIL" }
$lines += "VERDICT=$verdict attacks=$attacks demotedAfterCall=$demotedAfterCall demotedSamples=$demotedSamples totalSamples=$totalSamples durationMs=$([int](Get-Date).Subtract($burstStart).TotalMilliseconds + $SingleRounds * $SingleIntervalMs)"
$lines | Set-Content $outFile
$lines | ForEach-Object { Write-Output $_ }
exit $(if ($verdict -eq 'PASS') { 0 } else { 2 })
