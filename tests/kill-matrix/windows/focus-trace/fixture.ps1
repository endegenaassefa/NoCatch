param([string]$Control)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$f1=New-Object Windows.Forms.Form;$f1.Text='Owned calibration A';$f1.StartPosition='Manual';$f1.Location=New-Object Drawing.Point(180,180);$f1.Size=New-Object Drawing.Size(320,200)
$f2=New-Object Windows.Forms.Form;$f2.Text='Owned calibration B';$f2.StartPosition='Manual';$f2.Location=New-Object Drawing.Point(540,180);$f2.Size=New-Object Drawing.Size(320,200)
$f2.Show();$f1.Show();$f1.Activate()
@{pid=$PID;hwndA=$f1.Handle.ToInt64();hwndB=$f2.Handle.ToInt64()}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Control 'fixture.json')
$timer=New-Object Windows.Forms.Timer;$timer.Interval=100
$timer.Add_Tick({
 foreach($op in @('switch','move','close')){$path=Join-Path $Control ($op+'.request');if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path;switch($op){'switch'{$f2.Activate()};'move'{$f1.Location=New-Object Drawing.Point(240,260)};'close'{$timer.Stop();$f2.Close();$f1.Close()}};@{operation=$op;operatorUtc=[datetime]::UtcNow.ToString('o');hwndA=$f1.Handle.ToInt64();hwndB=$f2.Handle.ToInt64();x=$f1.Left;y=$f1.Top}|ConvertTo-Json -Compress|Add-Content -LiteralPath (Join-Path $Control 'fixture-controls.jsonl')}}
})
$timer.Start()
try{[Windows.Forms.Application]::Run($f1)}finally{$timer.Dispose();$f2.Dispose();$f1.Dispose()}
