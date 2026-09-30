# backdrop-form.ps1 — throttle-proof animated backdrop for the flicker probe.
# A plain WinForms form painted by WM_TIMER: hard-edged moving stripes that
# cannot be paused by browser background throttling. Runs for -Sec seconds,
# then exits. Positioned behind the topmost Cluely windows.
param(
  [int]$X = 100,
  [int]$Y = 60,
  [int]$W = 1440,
  [int]$H = 785,
  [int]$Sec = 40,
  [int]$Speed = 4    # pixels per tick
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'probe-backdrop'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size($W, $H)
$form.FormBorderStyle = 'FixedSingle'
$form.ShowInTaskbar = $false
$form.TopMost = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(10, 10, 10)

$phase = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 25
$timer.Add_Tick({
  $script:phase += $Speed
  if ($script:phase -ge 240) { $script:phase -= 240 }
  $form.Invalidate()
})

$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $stripe = 40
  $off = $script:phase
  $x = -$off
  $i = 0
  while ($x -lt $W) {
    $color = if ($i % 3 -eq 0) { [System.Drawing.Color]::FromArgb(230, 70, 86) }
             elseif ($i % 3 -eq 1) { [System.Drawing.Color]::FromArgb(241, 250, 238) }
             else { [System.Drawing.Color]::FromArgb(29, 53, 87) }
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillRectangle($brush, [float]$x, 0, [float]($stripe + 1), [float]$H)
    $brush.Dispose()
    $x += $stripe
    $i++
  }
})

$timer.Start()
$form.Add_Shown({ $form.Activate() })
# Auto-close after -Sec seconds so the form never lingers.
$closeTimer = New-Object System.Windows.Forms.Timer
$closeTimer.Interval = $Sec * 1000
$closeTimer.Add_Tick({ $form.Close() })
$closeTimer.Start()
[void]$form.ShowDialog()
$timer.Stop()
$closeTimer.Stop()
$form.Dispose()
