# flicker-probe.ps1 — red-capable feedback loop for the exam-time content flicker.
#
# Reproduces LockDown Browser's ~1 Hz topmost strip against a target window
# while capturing its screen region and a reference region, computing
# frame-to-frame mean-absolute pixel differences and edge sharpness.
#
# Two target modes:
#   -TargetTitle <title> : find a window by title (non-elevated harness mode;
#                          SetWindowPos works because both sides are non-elevated).
#   (default)            : the proven elevated OpenCluely root's chat window
#                          (pidfile verification; war strips fail under UIPI
#                          when this script is not elevated).
#
# Verdict: war-phase churn >> baseline = RED (flicker reproduced).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File flicker-probe.ps1
#        -TargetTitle FlickerHarness -WarMs 900 -BaselineSec 5 -WarSec 12 -AfterSec 4

param(
  [string]$TargetTitle = '',   # window title to war (overrides pidfile mode)
  [int]$WarMs        = 900,
  [int]$BaselineSec  = 5,
  [int]$WarSec       = 12,
  [int]$AfterSec     = 4,
  [int]$Fps          = 12,
  [int]$RefX = -1, [int]$RefY = -1, [int]$RefW = -1, [int]$RefH = -1,  # default: below the window
  [string]$OutDir    = (Join-Path $env:TEMP 'cluely-flicker-probe')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FlickerProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
  public static void StripTopmost(IntPtr h) {
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010); // HWND_NOTOPMOST, NOMOVE|NOSIZE|NOACTIVATE
  }
  public static void ReassertTopmost(IntPtr h) {
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010); // HWND_TOPMOST
  }
  public static List<IntPtr> OrderedWindows() {
    var found = new List<IntPtr>();
    EnumWindows((h, ignored) => { found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
}
'@

[void][FlickerProbe]::SetProcessDPIAware()

# ── Locate target window ───────────────────────────────────────────────────
$chatHwnd = [IntPtr]::Zero
if ($TargetTitle) {
  foreach ($h in [FlickerProbe]::OrderedWindows()) {
    if ([FlickerProbe]::Title($h) -eq $TargetTitle) { $chatHwnd = $h; break }
  }
  if ($chatHwnd -eq [IntPtr]::Zero) { throw ('Window with title "' + $TargetTitle + '" not found.') }
} else {
  $PidFile = Join-Path $env:TEMP 'cluely-root.pid'
  if (-not (Test-Path -LiteralPath $PidFile)) { throw 'Missing %TEMP%\cluely-root.pid (elevated OpenCluely not booted?).' }
  $lines = @(Get-Content -LiteralPath $PidFile)
  $pidLine = @($lines | Where-Object { $_ -match '^PID=\d+$' } | Select-Object -First 1)
  $createdLine = @($lines | Where-Object { $_ -match '^CREATED=\d+$' } | Select-Object -First 1)
  if ($pidLine.Count -eq 0 -or $createdLine.Count -eq 0) { throw 'Pidfile missing PID/CREATED.' }
  $rootPid = [int]($pidLine[0] -replace '^PID=', '')
  $created = [string]($createdLine[0] -replace '^CREATED=', '')
  $proc = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne 'screen-reader-util') { throw 'Pidfile owner is not the screen-reader-util process.' }
  $ci = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $rootPid)
  if (-not $ci -or ($ci.CreationDate.ToUniversalTime().Ticks.ToString() -ne $created)) { throw 'Pidfile CREATED mismatch.' }
  foreach ($h in [FlickerProbe]::OrderedWindows()) {
    $pid2 = [uint32]0
    [void][FlickerProbe]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ([int]$pid2 -ne $rootPid) { continue }
    $r = New-Object FlickerProbe+RECT
    if (-not [FlickerProbe]::GetWindowRect($h, [ref]$r)) { continue }
    if (($r.Bottom - $r.Top) -gt 300) { $chatHwnd = $h; break }
  }
  if ($chatHwnd -eq [IntPtr]::Zero) { throw 'Chat window of proven root not found.' }
}

$rect = New-Object FlickerProbe+RECT
[void][FlickerProbe]::GetWindowRect($chatHwnd, [ref]$rect)
Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$rect.Left = [math]::Max($rect.Left, $vs.Left)
$rect.Top = [math]::Max($rect.Top, $vs.Top)
$rect.Right = [math]::Min($rect.Right, $vs.Right)
$rect.Bottom = [math]::Min($rect.Bottom, $vs.Bottom)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw 'Empty target rect.' }
$wasVisible = [FlickerProbe]::IsWindowVisible($chatHwnd)

# Reference region: explicit or default (below the window).
if ($RefX -ge 0 -and $RefY -ge 0 -and $RefW -gt 0 -and $RefH -gt 0) {
  $refLeft = [math]::Max($RefX, $vs.Left); $refTop = [math]::Max($RefY, $vs.Top)
  $refW = [math]::Min($RefW, $vs.Right - $refLeft); $refH = [math]::Min($RefH, $vs.Bottom - $refTop)
} else {
  $refW = $w
  $refH = [math]::Min(200, $vs.Bottom - $rect.Bottom - 40)
  $refLeft = $rect.Left
  $refTop = $rect.Bottom + 40
}
if ($refW -le 0 -or $refH -le 0) { throw 'No valid reference region.' }

# ── Output ─────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $OutDir)) { [void](New-Item -ItemType Directory -Path $OutDir -Force) }
$csvPath = Join-Path $OutDir 'frames.csv'
$logPath = Join-Path $OutDir 'probe.jsonl'
$summaryPath = Join-Path $OutDir 'summary.txt'
[System.IO.File]::WriteAllText($csvPath, "t_ms,phase,win_diff,win_sharp,ref_diff,ref_sharp,topmost`n", (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($logPath, '', (New-Object System.Text.UTF8Encoding($false)))
$metaObj = [pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); hwnd = $chatHwnd.ToInt64().ToString(); title = [FlickerProbe]::Title($chatHwnd); x = $rect.Left; y = $rect.Top; width = $w; height = $h; wasVisible = $wasVisible; warMs = $WarMs; baselineSec = $BaselineSec; warSec = $WarSec; afterSec = $AfterSec; fps = $Fps; refX = $refLeft; refY = $refTop; refW = $refW; refH = $refH }
[System.IO.File]::WriteAllText((Join-Path $OutDir 'meta.json'), (ConvertTo-Json $metaObj), (New-Object System.Text.UTF8Encoding($false)))

if (-not $wasVisible) { [void][FlickerProbe]::ShowWindow($chatHwnd, 4) }
Start-Sleep -Milliseconds 1200

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
public static class FrameDiff {
  public static double Diff(Bitmap a, Bitmap b) {
    if (a == null || b == null || a.Width != b.Width || a.Height != b.Height) return -1;
    var ra = new Rectangle(0, 0, a.Width, a.Height);
    var da = a.LockBits(ra, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    var db = b.LockBits(ra, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      long sum = 0; long n = 0;
      int stride = da.Stride;
      byte[] rowA = new byte[stride];
      byte[] rowB = new byte[stride];
      for (int y = 0; y < a.Height; y++) {
        System.Runtime.InteropServices.Marshal.Copy(da.Scan0 + y * stride, rowA, 0, stride);
        System.Runtime.InteropServices.Marshal.Copy(db.Scan0 + y * stride, rowB, 0, stride);
        for (int x = 0; x < a.Width; x++) {
          int i = x * 3;
          int d0 = Math.Abs(rowA[i] - rowB[i]);
          int d1 = Math.Abs(rowA[i+1] - rowB[i+1]);
          int d2 = Math.Abs(rowA[i+2] - rowB[i+2]);
          sum += d0 + d1 + d2; n++;
        }
      }
      return (double)sum / (n * 3);
    } finally { a.UnlockBits(da); b.UnlockBits(db); }
  }
  public static double Sharpness(Bitmap b) {
    var ra = new Rectangle(0, 0, b.Width, b.Height);
    var d = b.LockBits(ra, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    try {
      long sum = 0; long n = 0;
      int stride = d.Stride;
      byte[] rowA = new byte[stride];
      byte[] rowB = new byte[stride];
      System.Runtime.InteropServices.Marshal.Copy(d.Scan0, rowA, 0, stride);
      for (int y = 1; y < b.Height; y++) {
        System.Runtime.InteropServices.Marshal.Copy(d.Scan0 + y * stride, rowB, 0, stride);
        for (int x = 1; x < b.Width; x++) {
          int i = x * 3;
          int gx = Math.Abs(rowB[i] - rowB[i-3]);
          int gy = Math.Abs(rowB[i] - rowA[i]);
          sum += gx + gy; n++;
        }
        var tmp = rowA; rowA = rowB; rowB = tmp;
      }
      return (double)sum / (n * 2);
    } finally { b.UnlockBits(d); }
  }
}
'@ -ReferencedAssemblies 'System.Drawing'

function Add-PhaseStat($list, $phase, $diffs) {
  $sorted = @($diffs | Sort-Object)
  $n = $sorted.Count
  if ($n -eq 0) { return }
  $list.Add([pscustomobject]@{
    phase = $phase
    frames = $n
    mean = [math]::Round(($sorted | Measure-Object -Average).Average, 3)
    median = [math]::Round($sorted[[int]($n / 2)], 3)
    p95 = [math]::Round($sorted[[int]($n * 0.95)], 3)
    max = [math]::Round($sorted[$n - 1], 3)
  })
}

$phaseStats = New-Object 'System.Collections.Generic.List[object]'
$prevWin = $null
$prevRef = $null
$framePeriod = [int](1000 / $Fps)
$baselineDiffs = New-Object 'System.Collections.Generic.List[double]'
$warDiffs = New-Object 'System.Collections.Generic.List[double]'
$afterDiffs = New-Object 'System.Collections.Generic.List[double]'

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$warStartMs = $BaselineSec * 1000
$warEndMs = $warStartMs + $WarSec * 1000
$totalMs = $warEndMs + $AfterSec * 1000
$nextFrameAt = 0
$nextStripAt = $warStartMs + $WarMs
$strips = 0
$stripFailures = 0

while ($sw.ElapsedMilliseconds -lt $totalMs) {
  $now = $sw.ElapsedMilliseconds
  if ($now -ge $warStartMs -and $now -lt $warEndMs -and $now -ge $nextStripAt) {
    $topmostBefore = [FlickerProbe]::IsTopmost($chatHwnd)
    [FlickerProbe]::StripTopmost($chatHwnd)
    $topmostAfter = [FlickerProbe]::IsTopmost($chatHwnd)
    $strips++
    if ($topmostBefore -and $topmostAfter) { $stripFailures++ }
    $nextStripAt = $now + $WarMs
    Add-Content -LiteralPath $logPath -Value (ConvertTo-Json -InputObject ([pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); evt = 'strip'; topmostBefore = $topmostBefore; topmostAfter = $topmostAfter }) -Compress) -Encoding UTF8
  }
  if ($now -ge $nextFrameAt) {
    $win = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($win)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $ref = New-Object System.Drawing.Bitmap($refW, $refH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g2 = [System.Drawing.Graphics]::FromImage($ref)
    $g2.CopyFromScreen($refLeft, $refTop, 0, 0, (New-Object System.Drawing.Size($refW, $refH)))
    $g2.Dispose()
    $phase = if ($now -lt $warStartMs) { 'baseline' } elseif ($now -lt $warEndMs) { 'war' } else { 'after' }
    $winDiff = if ($null -ne $prevWin) { [FrameDiff]::Diff($win, $prevWin) } else { 0.0 }
    $refDiff = if ($null -ne $prevRef) { [FrameDiff]::Diff($ref, $prevRef) } else { 0.0 }
    $winSharp = [FrameDiff]::Sharpness($win)
    $refSharp = [FrameDiff]::Sharpness($ref)
    if ($null -ne $prevWin) { $prevWin.Dispose() }
    if ($null -ne $prevRef) { $prevRef.Dispose() }
    $prevWin = $win; $prevRef = $ref
    $topmost = [FlickerProbe]::IsTopmost($chatHwnd)
    [System.IO.File]::AppendAllText($csvPath, ("{0},{1},{2},{3},{4},{5},{6}`n" -f $now, $phase, ([math]::Round($winDiff,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([math]::Round($winSharp,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([math]::Round($refDiff,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([math]::Round($refSharp,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), $topmost), (New-Object System.Text.UTF8Encoding($false)))
    if ($phase -eq 'baseline') { $baselineDiffs.Add($winDiff) } elseif ($phase -eq 'war') { $warDiffs.Add($winDiff) } else { $afterDiffs.Add($winDiff) }
    $nextFrameAt = $now + $framePeriod
  }
  Start-Sleep -Milliseconds 15
}
if ($null -ne $prevWin) { $prevWin.Dispose() }
if ($null -ne $prevRef) { $prevRef.Dispose() }

[FlickerProbe]::ReassertTopmost($chatHwnd)
if (-not $wasVisible) { [void][FlickerProbe]::ShowWindow($chatHwnd, 0) }

Add-PhaseStat $phaseStats 'baseline' $baselineDiffs
Add-PhaseStat $phaseStats 'war' $warDiffs
Add-PhaseStat $phaseStats 'after' $afterDiffs
$phaseStats | Format-Table | Out-String | Write-Output
$baselineMean = ($baselineDiffs | Measure-Object -Average).Average
$warMean = ($warDiffs | Measure-Object -Average).Average
$ratio = if ($baselineMean -gt 0) { [math]::Round($warMean / $baselineMean, 2) } else { -1 }
$verdict = if ($ratio -ge 3) { 'RED: war-phase pixel churn >= 3x baseline — flicker reproduced' } else { 'GREEN: war-phase pixel churn within noise of baseline — no flicker reproduced' }
Write-Output ("strips={0} stripFailures={1} warMean={2} baselineMean={3} ratio={4} verdict: {5}" -f $strips, $stripFailures, $warMean, $baselineMean, $ratio, $verdict)
[System.IO.File]::WriteAllText($summaryPath, (($phaseStats | Format-Table | Out-String) + "`n" + ("strips={0} stripFailures={1} warMean={2} baselineMean={3} ratio={4} verdict: {5}" -f $strips, $stripFailures, $warMean, $baselineMean, $ratio, $verdict)), (New-Object System.Text.UTF8Encoding($false)))
