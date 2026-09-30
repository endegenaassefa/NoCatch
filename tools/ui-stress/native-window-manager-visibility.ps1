param(
  [ValidateSet('main','chat')][string]$Type = 'main',
  [ValidateSet('guard','control')][string]$Mode = 'guard',
  [switch]$AllowPixelCapture,
  [switch]$TraceNative
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$fixture = Join-Path $PSScriptRoot 'native-window-manager-probe.cjs'
$attack = Join-Path $PSScriptRoot 'attack-topmost.ps1'
$out = Join-Path $env:TEMP ('nc-native-visibility-' + $Type + '-' + $Mode + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NCVisible {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
}
'@

function Sample([int]$x, [int]$y, [switch]$NoPixel) {
  $point = New-Object NCVisible+Point
  $point.X = $x; $point.Y = $y
  $hit = [NCVisible]::WindowFromPoint($point)
  $rootHwnd = [NCVisible]::GetAncestor($hit, 2).ToInt64().ToString('x')
  $pixel = $null
  if (-not $NoPixel) {
    $dc = [NCVisible]::GetDC([IntPtr]::Zero)
    try { $pixel = [NCVisible]::GetPixel($dc, $x, $y).ToString('x6') }
    finally { [void][NCVisible]::ReleaseDC([IntPtr]::Zero, $dc) }
  }
  return [pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); hwnd = $rootHwnd; pixel = $pixel }
}

$process = $null
$job = $null
$pass = $false
try {
  $fixtureArgs = @('--no-sandbox', $fixture, $root, $out, $Type, $Mode)
  if ($AllowPixelCapture) { $fixtureArgs += '--capture-pixels' }
  if ($TraceNative) { $fixtureArgs += '--trace-native' }
  $process = Start-Process -FilePath $exe -ArgumentList $fixtureArgs -WorkingDirectory $root -PassThru
  $file = Join-Path $out 'fixture.json'
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path $file) -and (Get-Date) -lt $deadline -and -not $process.HasExited) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path $file)) { throw "Fixture did not become ready; exit=$($process.ExitCode)" }
  $ready = Get-Content $file -Raw | ConvertFrom-Json
  if ($ready.errors.Count -gt 0 -or -not $ready.marker -or -not $ready.visible) { throw "Fixture invalid: $(Get-Content $file -Raw)" }
  $x = [int]$ready.sample.x; $y = [int]$ready.sample.y
  $before = Sample $x $y
  $job = Start-Job -ScriptBlock {
    param($scriptPath, $hwnd)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -HwndOverride $hwnd -SingleRounds 8 -SingleIntervalMs 100 -BurstRounds 10 -BurstIntervalMs 20
  } -ArgumentList $attack, $ready.targetHwnd
  $samples = New-Object 'System.Collections.Generic.List[object]'
  $sampleDeadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $sampleDeadline -and $job.State -eq 'Running') {
    $samples.Add((Sample $x $y -NoPixel))
    Start-Sleep -Milliseconds 5
  }
  Wait-Job $job -Timeout 12 | Out-Null
  $attacker = @(Receive-Job $job | ForEach-Object { $_.ToString() })
  $after = Sample $x $y
  $targetCount = @($samples | Where-Object hwnd -eq $ready.targetHwnd).Count
  $coverSamples = @($samples | Where-Object hwnd -eq $ready.coverHwnd)
  $coverCount = $coverSamples.Count
  $attackStart = if ($attacker.Count -gt 0 -and $attacker[0] -match '^attacker start ([^ ]+)') {
    [DateTimeOffset]::Parse($Matches[1]).ToUnixTimeMilliseconds()
  } else { $null }
  $result = [pscustomobject]@{
    type = $Type; mode = $Mode; out = $out; target = $ready.targetHwnd; cover = $ready.coverHwnd
    baseline = $before; after = $after; samples = $samples.Count
    targetSamples = $targetCount; coverSamples = $coverCount
    otherSamples = $samples.Count - $targetCount - $coverCount
    attackStart = $attackStart; coverSampleTimes = @($coverSamples | ForEach-Object at)
    coverDuringAttack = @($coverSamples | Where-Object { $_.at -ge $attackStart }).Count
    pixelCaptureEnabled = [bool]$AllowPixelCapture
    attacker = $attacker
  }
  $attackerPassed = $attacker.Count -gt 0 -and $attacker[-1] -match '^VERDICT=PASS attacks=18'
  $attackerFailed = $attacker.Count -gt 0 -and $attacker[-1] -match '^VERDICT=FAIL attacks=18 demotedAfterCall=18'
  $pass = if ($Mode -eq 'guard') {
    $before.hwnd -eq $ready.targetHwnd -and $after.hwnd -eq $ready.targetHwnd -and $coverCount -eq 0 -and $attackerPassed
  } else {
    $before.hwnd -eq $ready.targetHwnd -and $after.hwnd -eq $ready.coverHwnd -and $coverCount -gt 0 -and $attackerFailed
  }
  $result | Add-Member -NotePropertyName pass -NotePropertyValue ([bool]$pass)
  $result | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $out 'result.json')
  [pscustomobject]@{ type = $Type; mode = $Mode; pass = $pass; output = $out; samples = $samples.Count;
    targetSamples = $targetCount; coverDuringAttack = $result.coverDuringAttack;
    baseline = $before.hwnd; after = $after.hwnd; attacker = $attacker[-1] } | ConvertTo-Json
} finally {
  [IO.File]::WriteAllText((Join-Path $out 'stop'), 'stop')
  if ($job) { Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue }
  if ($process -and -not $process.HasExited) {
    if (-not $process.WaitForExit(2500)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
}
if (-not $pass) { exit 1 }
