param(
  [string]$Capture = '',
  [int]$TargetPid = 0,
  [switch]$Snapshot,
  [int]$DurationSeconds = 2700,
  [string]$StopWhenProcessExit = 'LockDownBrowser'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# This recorder reads window metadata only. It never reads titles or pixels.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VisualWindows {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
  public static List<IntPtr> OrderedWindows() {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, ignored) => { found.Add(hwnd); return true; }, IntPtr.Zero);
    return found;
  }
}
'@

$Here = $PSScriptRoot
$PidFile = Join-Path $env:TEMP 'cluely-root.pid'

function Get-CreatedTicks([int]$ProcessId) {
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
  if (-not $process) { return '' }
  return $process.CreationDate.ToUniversalTime().Ticks.ToString()
}
function Get-ProvenRootPid {
  if (-not (Test-Path -LiteralPath $PidFile)) { return 0 }
  $lines = @(Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue)
  $pidLine = @($lines | Where-Object { $_ -match '^PID=\d+$' } | Select-Object -First 1)
  $createdLine = @($lines | Where-Object { $_ -match '^CREATED=\d+$' } | Select-Object -First 1)
  if ($pidLine.Count -eq 0 -or $createdLine.Count -eq 0) { return 0 }
  $candidate = [int]($pidLine[0] -replace '^PID=', '')
  $created = [string]($createdLine[0] -replace '^CREATED=', '')
  $process = Get-Process -Id $candidate -ErrorAction SilentlyContinue
  if (-not $process -or $process.ProcessName -ne 'screen-reader-util') { return 0 }
  if ((Get-CreatedTicks $candidate) -ne $created) { return 0 }
  return $candidate
}
function Get-TargetPids([int]$RootPid) {
  $pids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$pids.Add($RootPid)
  if ($Capture) {
    $path = Join-Path $Capture 'targets.json'
    if (Test-Path -LiteralPath $path) {
      try {
        foreach ($target in @(Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)) {
          if ($target -and $target.pid) { [void]$pids.Add([int]$target.pid) }
        }
      } catch { }
    }
  }
  return ,$pids
}
function Take-Snapshot([int]$RootPid) {
  $targetPids = Get-TargetPids $RootPid
  $browserPids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($process in @(Get-Process -Name 'LockDownBrowser' -ErrorAction SilentlyContinue)) { [void]$browserPids.Add($process.Id) }
  $foreground = [VisualWindows]::GetForegroundWindow()
  $foregroundPid = [uint32]0
  if ($foreground -ne [IntPtr]::Zero) { [void][VisualWindows]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) }
  $all = New-Object 'System.Collections.Generic.List[object]'
  $index = 0
  foreach ($handle in [VisualWindows]::OrderedWindows()) {
    $processId = [uint32]0
    [void][VisualWindows]::GetWindowThreadProcessId($handle, [ref]$processId)
    $rect = New-Object VisualWindows+RECT
    if (-not [VisualWindows]::GetWindowRect($handle, [ref]$rect)) { $index++; continue }
    $cloaked = 0
    $dwmResult = [VisualWindows]::DwmGetWindowAttribute($handle, 14, [ref]$cloaked, 4)
    $exStyle = [VisualWindows]::GetWindowLong($handle, -20)
    $all.Add([pscustomobject]@{
      hwnd = $handle.ToInt64().ToString()
      pid = [int]$processId
      z = $index
      visibleStyle = [VisualWindows]::IsWindowVisible($handle)
      topmost = (($exStyle -band 8) -ne 0)
      cloaked = $(if ($dwmResult -eq 0) { $cloaked } else { -1 })
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
    })
    $index++
  }
  $selected = @($all | Where-Object { $targetPids.Contains($_.pid) -or $browserPids.Contains($_.pid) })
  $windows = @()
  foreach ($window in $selected) {
    $role = if ($targetPids.Contains($window.pid)) { 'cluely' } else { 'lockdown-browser' }
    $covers = @($all | Where-Object {
      $window.visibleStyle -and $window.cloaked -eq 0 -and
      $window.width -gt 0 -and $window.height -gt 0 -and
      $_.z -lt $window.z -and $_.visibleStyle -and $_.cloaked -eq 0 -and
      $_.width -gt 0 -and $_.height -gt 0 -and
      $_.x -le $window.x -and $_.y -le $window.y -and
      ($_.x + $_.width) -ge ($window.x + $window.width) -and
      ($_.y + $_.height) -ge ($window.y + $window.height)
    } | Select-Object -First 5)
    $windows += [pscustomobject]@{
      role = $role
      hwnd = $window.hwnd
      pid = $window.pid
      z = $window.z
      visibleStyle = $window.visibleStyle
      topmost = $window.topmost
      cloaked = $window.cloaked
      x = $window.x
      y = $window.y
      width = $window.width
      height = $window.height
      fullyCoveredBy = @($covers | ForEach-Object { [pscustomobject]@{ pid = $_.pid; z = $_.z; hwnd = $_.hwnd } })
    }
  }
  return [pscustomobject]@{
    utc = (Get-Date).ToUniversalTime().ToString('o')
    rootPid = $RootPid
    foregroundPid = [int]$foregroundPid
    browserPids = @($browserPids)
    windows = @($windows)
  }
}

$provenRoot = Get-ProvenRootPid
if (-not $provenRoot) { throw 'Elevated OpenCluely pidfile owner could not be verified.' }
if ($TargetPid -and $TargetPid -ne $provenRoot) { throw 'Target PID does not match the proven OpenCluely root.' }
if ($Snapshot) {
  Take-Snapshot $provenRoot | ConvertTo-Json -Depth 7
  return
}
if (-not $Capture -or -not (Test-Path -LiteralPath $Capture -PathType Container)) { throw 'An existing capture directory is required.' }
$out = Join-Path $Capture 'visual-state.jsonl'
$ready = Join-Path $Capture 'visual-ready.txt'
$stop = Join-Path $Capture 'visual-stop.txt'
[System.IO.File]::WriteAllText($ready, (Get-Date).ToUniversalTime().ToString('o'))
$deadline = (Get-Date).AddSeconds($DurationSeconds)
$sawBrowser = $false
$browserMissingSince = $null
try {
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $stop) { break }
    $row = Take-Snapshot $provenRoot
    Add-Content -LiteralPath $out -Value (ConvertTo-Json -InputObject $row -Depth 7 -Compress) -Encoding UTF8
    if ($row.browserPids.Count -gt 0) { $sawBrowser = $true; $browserMissingSince = $null }
    elseif ($sawBrowser -and $StopWhenProcessExit) {
      if ($null -eq $browserMissingSince) { $browserMissingSince = Get-Date }
      elseif (((Get-Date) - $browserMissingSince).TotalSeconds -ge 5) { break }
    }
    Start-Sleep -Milliseconds 500
  }
} catch {
  [System.IO.File]::WriteAllText((Join-Path $Capture 'visual-error.txt'), $_.Exception.ToString())
  throw
} finally {
  [System.IO.File]::WriteAllText((Join-Path $Capture 'visual-ended.txt'), (Get-Date).ToUniversalTime().ToString('o'))
}
