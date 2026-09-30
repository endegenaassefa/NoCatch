param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$TargetPid,
  [Parameter(Mandatory=$true)][string]$Capture,
  [string]$ExpectedExe = (Join-Path $env:LOCALAPPDATA 'Programs\screen-reader-util\screen-reader-util.exe'),
  [string]$PidFile = (Join-Path $env:TEMP 'cluely-root.pid'),
  [string]$MainHwndHex = '',
  [string]$ChatHwndHex = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (-not ('NativeTopmostCalibration.Native' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'NativeTopmostCalibration.cs')
}

function Read-OwnedProcess {
  $lines = @(Get-Content -LiteralPath $PidFile)
  $pidLines = @($lines | Where-Object { $_ -match '^PID=\d+$' })
  $createdLines = @($lines | Where-Object { $_ -match '^CREATED=\d+$' })
  if ($pidLines.Count -ne 1 -or $createdLines.Count -ne 1) { throw 'Pidfile requires exactly one PID and CREATED ownership record.' }
  if ([int]($pidLines[0].Substring(4)) -ne $TargetPid) { throw 'TargetPid differs from launcher-owned root PID.' }
  $created = [long]$createdLines[0].Substring(8)
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $TargetPid)
  if (-not $process -or $process.Name -ne 'screen-reader-util.exe') { throw 'Launcher PID does not own the expected process name.' }
  if ($process.CreationDate.ToUniversalTime().Ticks -ne $created) { throw 'Stale PID: immutable creation time differs from the pidfile.' }
  return [pscustomobject]@{ ProcessId=$TargetPid; CreatedTicks=$created; SessionId=$process.SessionId }
}

function Assert-PinnedOwner {
  if (-not $script:processPin.IsAlive) { throw 'Pinned target process has exited.' }
  $owned = Read-OwnedProcess
  if ($owned.CreatedTicks -ne $script:ownership.CreatedTicks) { throw 'Launcher ownership changed during calibration.' }
}

function Assert-SameWindow($State, $Before) {
  if (-not $State.Exists -or $State.ProcessId -ne $TargetPid) { throw 'Window disappeared or changed process ownership.' }
  if (-not $State.Visible -or $State.Minimized) { throw 'Window became hidden or minimized.' }
  if ($State.X -ne $Before.X -or $State.Y -ne $Before.Y -or $State.Width -ne $Before.Width -or $State.Height -ne $Before.Height) { throw 'Window bounds changed during calibration.' }
  if ($State.ForegroundHwnd -ne $Before.ForegroundHwnd) { throw 'Foreground changed during calibration; nonactivation cannot be established.' }
}

$script:ownership = Read-OwnedProcess
$script:processPin = $null
$result = [ordered]@{ startedUtc=[DateTime]::UtcNow.ToString('o'); targetPid=$TargetPid; createdTicks=$script:ownership.CreatedTicks; status='preflight'; windows=@(); error=$null }
$captureFull = [IO.Path]::GetFullPath($Capture)
[IO.Directory]::CreateDirectory($captureFull) | Out-Null
$prefix = 'native-topmost-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$resultPath = Join-Path $captureFull ($prefix + '-result.json')
try {
  $script:processPin = New-Object NativeTopmostCalibration.ProcessPin -ArgumentList $TargetPid
  # WMI's CIM datetime has microsecond precision; native FILETIME has 100 ns precision.
  if ([Math]::Abs($script:processPin.CreatedTicks - $script:ownership.CreatedTicks) -gt 9) { throw 'Pinned native process creation time does not match launcher ownership.' }
  if (-not [String]::Equals([IO.Path]::GetFullPath($script:processPin.ExecutablePath), [IO.Path]::GetFullPath($ExpectedExe), [StringComparison]::OrdinalIgnoreCase)) { throw 'PID executable path differs from the expected installed application.' }
  Assert-PinnedOwner
  if ($script:ownership.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Target is not in the calibration desktop session.' }
  $result.executable = $script:processPin.ExecutablePath
  $visible = @([NativeTopmostCalibration.Native]::VisibleWindows([uint32]$TargetPid))
  if (($MainHwndHex -eq '') -ne ($ChatHwndHex -eq '')) { throw 'Supply both HWND arguments or neither.' }
  if ($MainHwndHex -and $ChatHwndHex) {
    $mainHandle = [Convert]::ToInt64(($MainHwndHex -replace '^0x',''),16)
    $chatHandle = [Convert]::ToInt64(($ChatHwndHex -replace '^0x',''),16)
    if ($mainHandle -eq $chatHandle) { throw 'Main and chat HWNDs must be distinct.' }
    $main = @($visible | Where-Object Hwnd -eq $mainHandle)
    $chat = @($visible | Where-Object Hwnd -eq $chatHandle)
    if ($main.Count -ne 1 -or $chat.Count -ne 1) { throw 'Explicit HWNDs must both be visible and owned by the proven process.' }
    $main=$main[0]; $chat=$chat[0]
  } else {
    if ($visible.Count -ne 2) { throw 'Automatic identification requires exactly two visible PID-owned windows; close setup/settings or provide both HWNDs.' }
    $main = @($visible | Where-Object { $_.Height -ge 15 -and $_.Height -le 150 -and $_.Width -ge 30 })
    $chat = @($visible | Where-Object { $_.Height -ge 250 -and $_.Width -ge 250 })
    if ($main.Count -ne 1 -or $chat.Count -ne 1) { throw 'Toolbar/chat geometry is ambiguous; supply separately verified HWNDs.' }
    $main=$main[0]; $chat=$chat[0]
  }
  foreach ($selected in @(@{role='main'; window=$main}, @{role='chat'; window=$chat})) {
    Assert-PinnedOwner
    $handle = [long]$selected.window.Hwnd
    $before = [NativeTopmostCalibration.Native]::Sample($handle)
    if (-not $before.Topmost -or -not $before.Visible -or $before.Minimized -or $before.ProcessId -ne $TargetPid) { throw 'Both targets must start visible, non-minimized, and topmost.' }
    $entry = [ordered]@{ role=$selected.role; hwnd=$handle.ToString(); before=$before; demotionObserved=$false; recovered=$false; recoveryMs=$null; success=$false; samples=@(); events=@(); cleanupRestored=$false; cleanupError=$null }
    $result.windows += $entry
    [NativeTopmostCalibration.Native]::BeginEvents([uint32]$TargetPid, [long[]]@($main.Hwnd,$chat.Hwnd))
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
      [NativeTopmostCalibration.Native]::Demote($handle, [uint32]$TargetPid)
      while ($clock.Elapsed.TotalMilliseconds -le 2000) {
        if (-not $script:processPin.IsAlive) { throw 'Pinned process exited during native calibration.' }
        [NativeTopmostCalibration.Native]::PumpEvents()
        $sample = [NativeTopmostCalibration.Native]::Sample($handle)
        $entry.samples += [pscustomobject]@{ elapsedMs=[Math]::Round($clock.Elapsed.TotalMilliseconds,3); state=$sample }
        Assert-SameWindow $sample $before
        if (-not $sample.Topmost) { $entry.demotionObserved=$true }
        elseif ($entry.demotionObserved) { $entry.recovered=$true; $entry.recoveryMs=[Math]::Round($clock.Elapsed.TotalMilliseconds,3); break }
        Start-Sleep -Milliseconds 20
      }
      # Drain delayed WinEvents and verify the recovered state stays stable briefly.
      $settle = [Diagnostics.Stopwatch]::StartNew()
      while ($settle.Elapsed.TotalMilliseconds -lt 150) { [NativeTopmostCalibration.Native]::PumpEvents(); Start-Sleep -Milliseconds 10 }
      $entry.events = @([NativeTopmostCalibration.Native]::ReadEvents())
      $settled = [NativeTopmostCalibration.Native]::Sample($handle)
      Assert-SameWindow $settled $before
      if (-not $entry.demotionObserved) { throw 'Demotion was not observed; this run cannot prove recovery.' }
      if (-not $entry.recovered -or $entry.recoveryMs -gt 2000) { throw 'Native WS_EX_TOPMOST did not recover within two seconds.' }
      if (-not $settled.Topmost) { throw 'Recovered topmost state was lost again during the settling check.' }
      if ($entry.events.Count -ne 0) { throw 'Show/hide/focus/foreground events occurred; clean nonactivating recovery was not established.' }
      Assert-PinnedOwner
      $entry.success=$true
    } finally {
      $entry.events = @([NativeTopmostCalibration.Native]::ReadEvents())
      [NativeTopmostCalibration.Native]::EndEvents()
      # Failed calibration never counts this safety rollback as app recovery.
      if (-not $entry.success -and $script:processPin.IsAlive) {
        try {
          Assert-PinnedOwner
          $cleanupState = [NativeTopmostCalibration.Native]::Sample($handle)
          if ($cleanupState.ProcessId -eq $TargetPid -and $cleanupState.Visible -and -not $cleanupState.Topmost) {
            [NativeTopmostCalibration.Native]::RestoreForCleanup($handle, [uint32]$TargetPid)
            $entry.cleanupRestored=([NativeTopmostCalibration.Native]::Sample($handle)).Topmost
          }
        } catch { $entry.cleanupError=$_.Exception.Message }
      }
    }
  }
  $result.status='passed'
} catch {
  $result.status='failed'
  $result.error=$_.Exception.Message
} finally {
  [NativeTopmostCalibration.Native]::EndEvents()
  if ($script:processPin) { $script:processPin.Dispose() }
  $result.completedUtc=[DateTime]::UtcNow.ToString('o')
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
[pscustomobject]@{ status=$result.status; path=$resultPath } | ConvertTo-Json
if ($result.status -ne 'passed') { exit 1 }
