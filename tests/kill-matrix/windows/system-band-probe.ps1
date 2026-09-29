# system-band-probe.ps1 — empirical validation of the System-integrity z-band fix.
#
# Hypothesis under test: an elevated (High-integrity) process CANNOT strip the
# WS_EX_TOPMOST style, hide, or cover a window that belongs to a SYSTEM-integrity
# process on the interactive desktop; and a SYSTEM topmost window stays ABOVE a
# High topmost window regardless of creation/activation order.
#
# Phases (one UAC elevation total — the script self-elevates):
#   A  CONTROL (High vs High): an elevated attacker strips a High canary window
#      -> strips MUST succeed (proves the attacker is capable in the same band).
#   B  FIX (High attacker vs SYSTEM canary): a scheduled task (/RU SYSTEM /IT)
#      shows a green topmost canary window on the interactive desktop. Then:
#        B1 strip attempts -> all must FAIL (topmost stays true).
#        B2 ShowWindow(SW_HIDE) attempt -> window must stay visible.
#        B3 z-order: System canary must sit ABOVE a High topmost attacker window.
#        B4 pixels: the canary region on screen must remain green (uncovered).
#
# Verdict printed at the end: PASS / FAIL / INCONCLUSIVE per phase.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File system-band-probe.ps1
#        [-WarMs 900] [-Strips 5] [-CanarySec 60] [-OutDir <dir>]

param(
  [int]$WarMs = 900,
  [int]$Strips = 5,
  [int]$CanarySec = 150,
  [string]$OutDir = (Join-Path $env:TEMP 'cluely-system-band-probe')
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$PowerShell = (Get-Command powershell.exe).Source
$CanaryTitle = 'CluelyBandCanary'
$AttackerTitle = 'CluelyBandAttacker'
$TaskName = 'CluelyBandProbe'

# ── Elevate once ────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '[PROBE] Requesting one UAC elevation...'
  $ChildAll = Join-Path $OutDir 'child-all.txt'
  # -Verb RunAs cannot be combined with Start-Process redirection parameters;
  # redirect inside the elevated child instead.
  $p = Start-Process -FilePath $PowerShell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -WarMs ' + $WarMs + ' -Strips ' + $Strips + ' -CanarySec ' + $CanarySec + ' -OutDir "' + $OutDir + '" *> "' + $ChildAll + '"') -Verb RunAs -Wait -PassThru
  Write-Host ('[PROBE] Elevated child exit: ' + $p.ExitCode)
  if (Test-Path -LiteralPath $ChildAll) { Get-Content -LiteralPath $ChildAll | ForEach-Object { Write-Host ('[child] ' + $_) } }
  if (Test-Path -LiteralPath (Join-Path $OutDir 'error.txt')) { Get-Content -LiteralPath (Join-Path $OutDir 'error.txt') | ForEach-Object { Write-Host ('[child-err] ' + $_) } }
  if (Test-Path -LiteralPath (Join-Path $OutDir 'probe.jsonl')) { Get-Content -LiteralPath (Join-Path $OutDir 'probe.jsonl') | ForEach-Object { Write-Host ('[evidence] ' + $_) } }
  if (Test-Path -LiteralPath (Join-Path $OutDir 'summary.txt')) { Get-Content -LiteralPath (Join-Path $OutDir 'summary.txt') | ForEach-Object { Write-Host ('[summary] ' + $_) } }
  if (Test-Path -LiteralPath (Join-Path $OutDir 'probe-transcript.txt')) { Get-Content -LiteralPath (Join-Path $OutDir 'probe-transcript.txt') -Tail 40 | ForEach-Object { Write-Host ('[transcript] ' + $_) } }
  exit $p.ExitCode
}
$LogPath = Join-Path $OutDir 'probe.jsonl'
$SummaryPath = Join-Path $OutDir 'summary.txt'
$ErrorPath = Join-Path $OutDir 'error.txt'
$CanaryOut = Join-Path $OutDir 'canary-info.txt'
$StopFile = Join-Path $OutDir 'canary-stop.txt'
[System.IO.File]::WriteAllText($LogPath, '', (New-Object System.Text.UTF8Encoding($false)))
Remove-Item $SummaryPath -Force -ErrorAction SilentlyContinue
Remove-Item $CanaryOut, $StopFile, $ErrorPath -Force -ErrorAction SilentlyContinue

try {
Start-Transcript -Path (Join-Path $OutDir 'probe-transcript.txt') -Force -ErrorAction SilentlyContinue

function Log-Event($Name, $Value) {
  Add-Content -LiteralPath $LogPath -Value (ConvertTo-Json -InputObject ([ordered]@{ utc = (Get-Date).ToUniversalTime().ToString('o'); evt = $Name; data = $Value }) -Depth 6 -Compress) -Encoding UTF8
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Band {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int X, int Y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
  public static bool Strip(IntPtr h) { return SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010); }
  public static void ReFront(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010); }
  public static List<IntPtr> Ordered() {
    var l = new List<IntPtr>();
    EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static string Title(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
}
'@

[void][Band]::SetProcessDPIAware()  # form coords must equal physical capture pixels


function Find-Hwnd([string]$Title) {
  foreach ($h in [Band]::Ordered()) {
    if ([Band]::Title($h) -eq $Title) { return $h }
  }
  return [IntPtr]::Zero
}

function Green-Ratio([IntPtr]$hwnd, [int]$x, [int]$y, [int]$w, [int]$h) {
  # Fraction of the region that is canary-green (#00FF00-ish). If another
  # window covers the canary, this collapses.
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $d = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $stride = $d.Stride
  $buf = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $buf, 0, $buf.Length)
  $bmp.UnlockBits($d)
  $bmp.Dispose()
  $green = 0L; $red = 0L; $total = 0L
  for ($row = 0; $row -lt $h; $row += 4) {
    for ($col = 0; $col -lt $w; $col += 4) {
      $i = $row * $stride + $col * 3
      $b = $buf[$i]; $g2 = $buf[$i + 1]; $r = $buf[$i + 2]
      if ($g2 -gt 200 -and $r -lt 80 -and $b -lt 80) { $green++ }
      if ($r -gt 180 -and $g2 -lt 80 -and $b -lt 80) { $red++ }
      $total++
    }
  }
  return [pscustomobject]@{ green = [math]::Round([double]$green / [double]$total, 3); red = [math]::Round([double]$red / [double]$total, 3) }
}

# ── Phase A: control — High attacker vs High canary ────────────────────────
Write-Host '[PROBE] Phase A: High attacker strips a High canary (control).'
$aForm = New-Object System.Windows.Forms.Form
$aForm.Text = $AttackerTitle
$aForm.TopMost = $true
$aForm.FormBorderStyle = 'None'
$aForm.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 255)
$aForm.StartPosition = 'Manual'
$aForm.Location = New-Object System.Drawing.Point(600, 500)
$aForm.Size = New-Object System.Drawing.Size(200, 120)
$aForm.Show()
[void][System.Windows.Forms.Application]::DoEvents()
$attackerHwnd = $aForm.Handle
$aWasTopmost = [Band]::IsTopmost($attackerHwnd)
[Band]::Strip($attackerHwnd)
$aAfterTopmost = [Band]::IsTopmost($attackerHwnd)
$controlStripSucceeded = ($aWasTopmost -and -not $aAfterTopmost)
Log-Event 'phase-a-control-strip' @{ topmostBefore = $aWasTopmost; topmostAfter = $aAfterTopmost; stripSucceeded = $controlStripSucceeded }
$aForm.Close(); $aForm.Dispose()
Write-Host ('[PROBE] Phase A control strip succeeded: ' + $controlStripSucceeded)

# ── Phase B: SYSTEM canary via scheduled task ──────────────────────────────
$canaryScript = Join-Path $OutDir 'canary.ps1'
@'
param([string]$InfoFile = '', [string]$StopFile = '', [string]$StateFile = '', [int]$Seconds = 60)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CanaryProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int len, out int needed);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int X, int Y, int cx, int cy, uint f);
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
  public static void ReFront(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010); }
  public static string DesktopName() {
    var h = GetThreadDesktop((uint)System.Diagnostics.Process.GetCurrentProcess().Threads[0].Id);
    var sb = new StringBuilder(256); int n = 0;
    if (GetUserObjectInformation(h, 2, sb, 512, out n)) return sb.ToString();
    return "unknown";
  }
}
"@
$f = New-Object System.Windows.Forms.Form
$f.Text = 'CluelyBandCanary'
$f.TopMost = $true
$f.FormBorderStyle = 'None'
$f.BackColor = [System.Drawing.Color]::FromArgb(0, 255, 0)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(200, 200)
$f.Size = New-Object System.Drawing.Size(320, 180)
$f.Show()
[void][System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 600
$integrity = 'unknown'
try {
  $groups = & whoami.exe /groups 2>$null | Out-String
  if ($groups -match 'S-1-16-16384') { $integrity = 'system' }
  elseif ($groups -match 'S-1-16-12288') { $integrity = 'high' }
  elseif ($groups -match 'S-1-16-8192') { $integrity = 'medium' }
} catch { }
$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$desktop = [CanaryProbe]::DesktopName()
$selfTopmost = [CanaryProbe]::IsTopmost($f.Handle)
$selfVisible = [CanaryProbe]::IsWindowVisible($f.Handle)
$info = [string]$f.Handle.ToInt64() + '|' + $integrity + '|' + $PID + '|' + $sessionId + '|' + $desktop + '|' + $selfTopmost + '|' + $selfVisible
[System.IO.File]::WriteAllText($InfoFile, $info, (New-Object System.Text.UTF8Encoding($false)))
# Self-sampled state timeline (250 ms): the attacker's own reads of this
# SYSTEM window are UIPI-sanitized (GetWindowLong/IsWindowVisible/GetWindowRect
# all return zero/false from a High process), so the canary records its own
# truth: topmost flag, visibility, and any close attempt.
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  $line = $sw.ElapsedMilliseconds.ToString() + ',' + ([CanaryProbe]::IsTopmost($f.Handle)).ToString() + ',' + ([CanaryProbe]::IsWindowVisible($f.Handle)).ToString()
  Add-Content -LiteralPath $StateFile -Value $line
})
$f.Add_FormClosing({ param($snd, $ev)
  [System.IO.File]::AppendAllText($StateFile, ('CLOSED:' + $ev.CloseReason.ToString() + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
})
$timer.Start()
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $StopFile)) {
  if (Test-Path -LiteralPath ($StateFile + '.refront')) {
    Remove-Item -LiteralPath ($StateFile + '.refront') -Force -ErrorAction SilentlyContinue
    [CanaryProbe]::ReFront($f.Handle)
    Add-Content -LiteralPath $StateFile -Value 'REFRONT'
  }
  [void][System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 100
}
$timer.Stop()
$f.Close(); $f.Dispose()
'@ | Set-Content -LiteralPath $canaryScript -Encoding UTF8

Write-Host '[PROBE] Phase B: launching SYSTEM-integrity canary (PsExec -s -i reference path).'
# schtasks /RU SYSTEM /IT and InteractiveToken XML both landed in session 0 on
# this machine; the PowerShell token-dance port hit CreateProcessAsUser 203.
# Use PsExec (Sysinternals, same download source the repo already trusts for
# Sysmon in watch.ps1) as the reference implementation for this validation.
$canaryCmd = Join-Path $OutDir 'run-canary.cmd'
$CanaryState = Join-Path $OutDir 'canary-state.csv'
$cmdLine = '"' + $PowerShell + '" -NoProfile -ExecutionPolicy Bypass -File "' + $canaryScript + '" -InfoFile "' + $CanaryOut + '" -StopFile "' + $StopFile + '" -StateFile "' + $CanaryState + '" -Seconds ' + $CanarySec
[System.IO.File]::WriteAllText($canaryCmd, $cmdLine, (New-Object System.Text.UTF8Encoding($false)))
$toolsDir = Join-Path $OutDir 'tools'
New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
$psexec = Join-Path $toolsDir 'PsExec64.exe'
if (-not (Test-Path -LiteralPath $psexec)) {
  $zip = Join-Path $toolsDir 'PSTools.zip'
  Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/PSTools.zip' -OutFile $zip -UseBasicParsing
  Expand-Archive -LiteralPath $zip -DestinationPath $toolsDir -Force
}
$sig = Get-AuthenticodeSignature -LiteralPath $psexec
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') { throw ('PsExec signature is not valid Microsoft code: ' + $sig.Status) }
$psexecArgs = '-accepteula -nobanner -s -i cmd.exe /c "' + $canaryCmd + '"'
Start-Process -FilePath $psexec -ArgumentList $psexecArgs -WindowStyle Hidden | Out-Null
Log-Event 'phase-b-psexec-launched' @{ psexec = $psexec; signature = $sig.Status; canaryCmd = $canaryCmd }

$deadline = (Get-Date).AddSeconds(30)
$canaryHwnd = [IntPtr]::Zero
$canarySession = -1
while ((Get-Date) -lt $deadline -and $canaryHwnd -eq [IntPtr]::Zero) {
  if (Test-Path -LiteralPath $CanaryOut) {
    $info = (Get-Content -LiteralPath $CanaryOut -Raw).Trim()
    if ($info) {
      $parts = $info.Split('|')
      if ($parts.Count -ge 7) {
        $canaryHwnd = [IntPtr]::new([Convert]::ToInt64($parts[0]))
        $canaryIntegrity = $parts[1]
        $canarySession = [int]$parts[3]
        $canarySelfTopmost = $parts[5]
        $canarySelfVisible = $parts[6]
        Log-Event 'phase-b-canary-boot' @{
          hwnd = $parts[0]; integrity = $canaryIntegrity; pid = $parts[2]
          canarySession = $parts[3]; canaryDesktop = $parts[4]
          canarySelfTopmost = $parts[5]; canarySelfVisible = $parts[6]
          attackerSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        }
      }
    }
  }
  Start-Sleep -Milliseconds 500
}
if ($canaryHwnd -eq [IntPtr]::Zero) {
  Write-Host '[PROBE] INCONCLUSIVE: SYSTEM canary window never appeared.'
  [System.IO.File]::WriteAllText($SummaryPath, 'INCONCLUSIVE: SYSTEM canary never appeared. Check task history and ' + $CanaryOut, (New-Object System.Text.UTF8Encoding($false)))
  exit 2
}
$attackerSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
# Session/desktop verification uses the canary's SELF-REPORT plus session
# match. The attacker's EnumWindows cannot even SEE a System-integrity window
# (UIPI hides it from enumeration) — that invisibility is itself evidence of
# the protection, so it must not be treated as failure.
$seenByAttacker = $false
foreach ($h in [Band]::Ordered()) { if ($h -eq $canaryHwnd) { $seenByAttacker = $true; break } }
Write-Host ('[PROBE] SYSTEM canary up: hwnd=' + $canaryHwnd.ToString() + ' integrity=' + $canaryIntegrity + ' canarySession=' + $canarySession + ' attackerSession=' + $attackerSession + ' enumVisibleToAttacker=' + $seenByAttacker + ' (false is expected: UIPI hides System windows from High enumeration)')
if ($canaryIntegrity -ne 'system' -or $canarySession -ne $attackerSession -or $canarySelfVisible -ne 'True' -or $canarySelfTopmost -ne 'True') {
  Set-Content -LiteralPath $StopFile -Value 'stop'
  [System.IO.File]::WriteAllText($SummaryPath, ('INCONCLUSIVE: canary not verifiable on the interactive desktop (integrity=' + $canaryIntegrity + ', canarySession=' + $canarySession + ', attackerSession=' + $attackerSession + ', selfVisible=' + $canarySelfVisible + ', selfTopmost=' + $canarySelfTopmost + ').'), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '[PROBE] INCONCLUSIVE: canary not verifiable on the interactive desktop; see summary.txt.'
  exit 2
}

# Attacker-side reads of the SYSTEM window are UIPI-sanitized (style/visible/
# rect all come back zero/false from a High process), so the EFFECT of every
# attack is measured from the canary's OWN 250 ms state timeline instead.
$attackerStyleRead = [Band]::IsTopmost($canaryHwnd)
$attackerVisibleRead = [Band]::IsWindowVisible($canaryHwnd)
$probeRect = New-Object Band+RECT
$attackerRectRead = [Band]::GetWindowRect($canaryHwnd, [ref]$probeRect)
Log-Event 'phase-b-attacker-blinded' @{ styleRead = $attackerStyleRead; visibleRead = $attackerVisibleRead; rectReadOk = $attackerRectRead; rect = @{ l = $probeRect.Left; t = $probeRect.Top; r = $probeRect.Right; b = $probeRect.Bottom } }

# Only samples written AFTER the attacks begin count as evidence.
$preAttackLines = if (Test-Path -LiteralPath $CanaryState) { @(Get-Content -LiteralPath $CanaryState).Count } else { 0 }

# B1: strip attempts (SetWindowPos HWND_NOTOPMOST), with Win32 error capture.
$stripFailures = 0
for ($i = 1; $i -le $Strips; $i++) {
  [void][Band]::Strip($canaryHwnd)
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Log-Event 'phase-b-strip' @{ attempt = $i; lastWin32Error = $err }
  Start-Sleep -Milliseconds $WarMs
}

# B2: hide attempt
[void][Band]::ShowWindow($canaryHwnd, 0)  # SW_HIDE
$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
Log-Event 'phase-b-hide' @{ lastWin32Error = $err }
Start-Sleep -Milliseconds 800

# Canary-side truth during the attack window.
# Liveness proof: the canary's own timeline must still be GROWING.
$lastMsBefore = if (Test-Path -LiteralPath $CanaryState) { $tail = @(Get-Content -LiteralPath $CanaryState -Tail 1); if ($tail.Count -gt 0 -and $tail[0] -match '^(\d+),') { [long]$Matches[1] } else { -1 } } else { -1 }
Start-Sleep -Milliseconds 1200
$lastMsAfter = if (Test-Path -LiteralPath $CanaryState) { $tail = @(Get-Content -LiteralPath $CanaryState -Tail 1); if ($tail.Count -gt 0 -and $tail[0] -match '^(\d+),') { [long]$Matches[1] } else { -1 } } else { -1 }
$canaryAliveDuringWar = ($lastMsAfter -gt $lastMsBefore)
$stateRows = @()
if (Test-Path -LiteralPath $CanaryState) {
  $idx = 0
  foreach ($line in (Get-Content -LiteralPath $CanaryState)) {
    $idx++
    if ($idx -le $preAttackLines) { continue }
    if ($line -match '^(\d+),(True|False),(True|False)$') { $stateRows += [pscustomobject]@{ ms = [long]$Matches[1]; topmost = ($Matches[2] -eq 'True'); visible = ($Matches[3] -eq 'True') } }
  }
}
$warTopmostFlips = @($stateRows | Where-Object { -not $_.topmost }).Count
$warVisibleFlips = @($stateRows | Where-Object { -not $_.visible }).Count
Log-Event 'phase-b-canary-self-state' @{ samples = $stateRows.Count; topmostFalseSamples = $warTopmostFlips; visibleFalseSamples = $warVisibleFlips; canaryAliveDuringWar = $canaryAliveDuringWar; lastMsBefore = $lastMsBefore; lastMsAfter = $lastMsAfter }

# B3/B4: cover test with a High topmost attacker. EnumWindows cannot compare
# z-order here (UIPI hides the System window from the attacker's enumeration),
# so the DECISIVE evidence is pixel-level: the attacker window re-fronts
# itself over the canary region, then a screen capture of that region must
# still show canary-green — meaning the System window stayed on top.
$bForm = New-Object System.Windows.Forms.Form
$bForm.Text = $AttackerTitle
$bForm.TopMost = $true
$bForm.FormBorderStyle = 'None'
$bForm.BackColor = [System.Drawing.Color]::FromArgb(220, 0, 0)
$bForm.StartPosition = 'Manual'
$bForm.Location = New-Object System.Drawing.Point(180, 180)
$bForm.Size = New-Object System.Drawing.Size(400, 260)
$bForm.Show()
[void][System.Windows.Forms.Application]::DoEvents()
$attackerHwnd = $bForm.Handle
Start-Sleep -Milliseconds 600
[void][Band]::ReFront($attackerHwnd)  # attacker re-fronts itself, as LDB does
Start-Sleep -Milliseconds 600

# B4: pixel evidence at the canary's KNOWN coordinates (200,200 320x180) —
# GetWindowRect on the System window is UIPI-blinded for the attacker, but
# desktop pixels are not.
$first = Green-Ratio $canaryHwnd 200 200 320 180
Log-Event 'phase-b-cover-attacker-refronted' @{ greenRatio = $first.green; redRatio = $first.red }

# Counter-test: the SYSTEM canary re-fronts ITSELF (SetWindowPos HWND_TOPMOST,
# NOACTIVATE) — does it get back above the High attacker without activation?
[System.IO.File]::WriteAllText(($CanaryState + '.refront'), 'go', (New-Object System.Text.UTF8Encoding($false)))
Start-Sleep -Milliseconds 1200
$second = Green-Ratio $canaryHwnd 200 200 320 180
Log-Event 'phase-b-cover-canary-refronted' @{ greenRatio = $second.green; redRatio = $second.red }

# Then the attacker re-fronts again — who wins the band now?
[void][Band]::ReFront($attackerHwnd)
Start-Sleep -Milliseconds 1200
$third = Green-Ratio $canaryHwnd 200 200 320 180
Log-Event 'phase-b-cover-attacker-refronted-again' @{ greenRatio = $third.green; redRatio = $third.red }

$canaryWinsBand = ($second.green -ge 0.8)
$uncovered = $canaryWinsBand
$systemAbove = $canaryWinsBand
$green = $second.green

$bForm.Close(); $bForm.Dispose()

# ── Cleanup ─────────────────────────────────────────────────────────────────
# B1b (informational): WM_CLOSE is on the UIPI benign allowlist — expected to
# be delivered. The app must ignore it (Electron close preventDefault).
$aliveAfterClose = $null
if ([Band]::IsWindow($canaryHwnd)) {
  [void][Band]::PostMessage($canaryHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
  Start-Sleep -Seconds 1
  $aliveAfterClose = [Band]::IsWindow($canaryHwnd)
  Log-Event 'phase-b-close' @{ aliveAfterWMClose = $aliveAfterClose; wmCloseDelivered = (-not $aliveAfterClose) }
}
Set-Content -LiteralPath $StopFile -Value 'stop'

# ── Verdict ─────────────────────────────────────────────────────────────────
$b1Pass = ($warTopmostFlips -eq 0 -and $canaryAliveDuringWar)
$b2Pass = ($warVisibleFlips -eq 0 -and $canaryAliveDuringWar)
$wmCloseNote = if ($aliveAfterClose -eq $null) { 'WM_CLOSE check skipped: canary already gone.' } elseif ($aliveAfterClose) { 'WM_CLOSE delivered but window survived (app-level defense works).' } else { 'WM_CLOSE was delivered (UIPI benign allowlist) and closed the raw canary; the real app must ignore close (Electron close preventDefault).' }
$lines = @(
  '# System-band probe summary',
  ('UTC: ' + (Get-Date).ToUniversalTime().ToString('o')),
  ('Phase A control (High strips High) succeeded: ' + $controlStripSucceeded + ' (must be True)'),
  ('Canary integrity: ' + $canaryIntegrity + ' (must be system)'),
  ('B1 strip attempts blocked (canary-side topmost never flipped; ' + $warTopmostFlips + ' false samples): ' + $b1Pass + ' (must be True)'),
  ('B2 hide attempt blocked (canary-side visible never flipped; ' + $warVisibleFlips + ' false samples): ' + $b2Pass + ' (must be True)'),
  ('B3 System canary uncovered by pixel evidence (green ratio ' + $green + '): ' + $systemAbove + ' (must be True)'),
  ('B4 canary region uncovered on screen (green ratio ' + $green + '): ' + $uncovered + ' (must be True)'),
  ('B1b note: ' + $wmCloseNote),
  ''
)
$overall = $controlStripSucceeded -and $b1Pass -and $b2Pass -and $systemAbove -and $uncovered -and ($canaryIntegrity -eq 'system')
$lines += if ($overall) { 'VERDICT: PASS — System-integrity windows are immune to High-integrity demotion/hide/cover on this machine.' } else { 'VERDICT: FAIL — see failing lines above.' }
[System.IO.File]::WriteAllLines($SummaryPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Get-Content -LiteralPath $SummaryPath | ForEach-Object { Write-Host ('[PROBE] ' + $_) }
exit $(if ($overall) { 0 } else { 1 })
} catch {
  [System.IO.File]::WriteAllText($ErrorPath, $_.Exception.ToString() + [Environment]::NewLine + ($_ | Out-String), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('[PROBE] EXCEPTION: ' + $_.Exception.Message)
  Write-Host $_.ScriptStackTrace
  exit 1
}
