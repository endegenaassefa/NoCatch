# backdrop-probe.ps1 — measures visual stability of a transparent Cluely
# window (blurred frosted glass) while the content BEHIND it animates.
#
# Under test (H2): .chat-container / main-window body use backdrop-filter over
# a transparent Electron window, so the glass live-blurs whatever is behind it
# (the exam page during LDB). If the blur layer drops out or the compositor
# churns while the backdrop animates, the window content visibly flickers.
#
# Signal: per-frame sharpness (edge energy) of the captured window region.
# A healthy blur keeps sharpness flat regardless of backdrop motion (edges are
# smeared). Sharpness spikes during the animated phase = blur dropout = RED.
# A bare-backdrop reference region proves the animation itself is smooth.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File backdrop-probe.ps1
#        [-WindowHwndHex <hex>] [-Sec 28] [-Fps 15] [-OutDir <dir>]

param(
  [string]$WindowHwndHex = '190924',   # main window (visible, transparent, blur)
  [int]$Sec = 28,
  [int]$Fps = 15,
  [string]$OutDir = (Join-Path $env:TEMP 'cluely-backdrop-probe')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class BP {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
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
}
'@ -ReferencedAssemblies 'System.Drawing'

[void][BP]::SetProcessDPIAware()

$hwnd = [IntPtr]::new([Convert]::ToInt64($WindowHwndHex, 16))
$rect = New-Object BP+RECT
if (-not [BP]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Window rect not found for ' + $WindowHwndHex }
Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$rect.Left = [math]::Max($rect.Left, $vs.Left)
$rect.Top = [math]::Max($rect.Top, $vs.Top)
$rect.Right = [math]::Min($rect.Right, $vs.Right)
$rect.Bottom = [math]::Min($rect.Bottom, $vs.Bottom)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw 'Empty window rect.' }

# Reference region: same size, offset right by width+40 px, clamped to screen.
$refLeft = [math]::Min($rect.Right + 40, $vs.Right - $w)
$refTop = $rect.Top
if ($refLeft -le $rect.Left) { throw 'No room for reference region beside the window.' }

if (-not (Test-Path -LiteralPath $OutDir)) { [void](New-Item -ItemType Directory -Path $OutDir -Force) }
$csvPath = Join-Path $OutDir 'frames.csv'
[System.IO.File]::WriteAllText($csvPath, "t_ms,win_diff,win_sharp,ref_diff,ref_sharp`n", (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $OutDir 'meta.json'), (ConvertTo-Json ([pscustomobject]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); hwnd = $WindowHwndHex; x = $rect.Left; y = $rect.Top; w = $w; h = $h; refX = $refLeft; refY = $refTop })), (New-Object System.Text.UTF8Encoding($false)))

$prevWin = $null
$prevRef = $null
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$framePeriod = [int](1000 / $Fps)
$nextAt = 0
$totalMs = $Sec * 1000

while ($sw.ElapsedMilliseconds -lt $totalMs) {
  if ($sw.ElapsedMilliseconds -lt $nextAt) { Start-Sleep -Milliseconds 10; continue }
  $win = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($win)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $ref = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g2 = [System.Drawing.Graphics]::FromImage($ref)
  $g2.CopyFromScreen($refLeft, $refTop, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g2.Dispose()
  $winDiff = if ($null -ne $prevWin) { [BP]::Diff($win, $prevWin) } else { 0.0 }
  $refDiff = if ($null -ne $prevRef) { [BP]::Diff($ref, $prevRef) } else { 0.0 }
  $winSharp = [BP]::Sharpness($win)
  $refSharp = [BP]::Sharpness($ref)
  if ($null -ne $prevWin) { $prevWin.Dispose() }
  if ($null -ne $prevRef) { $prevRef.Dispose() }
  $prevWin = $win; $prevRef = $ref
  [System.IO.File]::AppendAllText($csvPath, ("{0},{1},{2},{3},{4}`n" -f $sw.ElapsedMilliseconds, ([math]::Round($winDiff,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([math]::Round($winSharp,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([math]::Round($refDiff,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([math]::Round($refSharp,3)).ToString([System.Globalization.CultureInfo]::InvariantCulture)), (New-Object System.Text.UTF8Encoding($false)))
  $nextAt = $sw.ElapsedMilliseconds + $framePeriod
}
if ($null -ne $prevWin) { $prevWin.Dispose() }
if ($null -ne $prevRef) { $prevRef.Dispose() }
Write-Output ("done: " + $csvPath)
