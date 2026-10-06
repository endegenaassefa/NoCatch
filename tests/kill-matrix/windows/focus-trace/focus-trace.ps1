[CmdletBinding()]
param([ValidateSet('Record','Mark','Stop','Report')][string]$Action='Record',[int]$TargetPid=0,[string]$ExpectedName='screen-reader-util',[switch]$Fixture,[ValidateSet('Native','Cim')][string]$IdentityMode='Native',[string]$Capture,[ValidateRange(1,7200)][int]$DurationSeconds=600,[ValidateSet('quiet-start','action-start','warning','trial-end')][string]$Marker='action-start')
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
if(-not $Capture){throw 'Explicit fresh capture path required.'}
$Capture=[IO.Path]::GetFullPath($Capture)
if($Action -eq 'Report'){
 if(-not(Test-Path -LiteralPath $Capture)){throw 'Capture missing'}
 $clean=Test-Path -LiteralPath (Join-Path $Capture 'clean-stop.json')
 $ready=Test-Path -LiteralPath (Join-Path $Capture 'ready.json')
 $errorFile=Test-Path -LiteralPath (Join-Path $Capture 'failure.txt')
 $rows=@();$parseFailure=$false
 try{$rows=@(Get-Content -LiteralPath (Join-Path $Capture 'observations.jsonl') | ForEach-Object {$_|ConvertFrom-Json})}catch{$parseFailure=$true}
 $beats=@($rows|Where-Object {$_.kind -eq 'heartbeat'})
 $dropped=0;foreach($b in $beats){if($b.dropped -gt $dropped){$dropped=$b.dropped}}
 $gap=0.0;for($i=1;$i -lt $beats.Count;$i++){ $delta=([datetime]$beats[$i].receiptUtc-[datetime]$beats[$i-1].receiptUtc).TotalSeconds;if($delta -gt $gap){$gap=$delta} }
 $stopData=$null;if($clean){try{$stopData=Get-Content -LiteralPath (Join-Path $Capture 'clean-stop.json') -Raw|ConvertFrom-Json;if($stopData.dropped -gt $dropped){$dropped=$stopData.dropped}}catch{$parseFailure=$true}}
 $hasFinal=@($rows|Where-Object {$_.kind -eq 'clean-stop'}).Count -eq 1
 $complete=$hasFinal -and ($null -ne $stopData) -and $stopData.unhooked -and $clean -and $ready -and -not $errorFile -and -not $parseFailure -and $dropped -eq 0 -and $gap -lt 3.5
 $report=[ordered]@{complete=$complete;ready=$ready;cleanStop=$clean;failure=$errorFile;parseFailure=$parseFailure;dropped=$dropped;maximumHeartbeatGapSeconds=$gap;nativeEvents=@($rows|Where-Object {$_.kind -eq 'native'}).Count;geometryChanges=@($rows|Where-Object {$_.kind -eq 'geometry-change'}).Count;limitation='Metadata observations only; no inference about exam warning, kick, or cause. Missing clean stop means incomplete.'}
 $report|ConvertTo-Json;return
}
if($Action -ne 'Record'){
 if(-not(Test-Path -LiteralPath (Join-Path $Capture 'ready.json')) -or (Test-Path -LiteralPath (Join-Path $Capture 'clean-stop.json'))){throw 'Capture is not ready/active'}
 if($Action -eq 'Stop'){[IO.File]::WriteAllText((Join-Path $Capture 'stop.request'),[datetime]::UtcNow.ToString('o'));return}
 $mark=[ordered]@{kind='operator-marker';operatorUtc=[datetime]::UtcNow.ToString('o');marker=$Marker;source='external-command';timestampMeaning='operator request, not native observed event'}|ConvertTo-Json -Compress
 $file=Join-Path $Capture ('marker-'+[guid]::NewGuid().ToString('N')+'.request');[IO.File]::WriteAllText($file,$mark);return
}
# Enforce ordinary unelevated execution; fixture opt-in never bypasses this.
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run unelevated. No UAC or privileged recorder mode.'}
if(Test-Path -LiteralPath $Capture){throw 'Refusing reused capture path'}
if($TargetPid -le 0){throw 'Explicit positive target PID required'}
Add-Type -Path (Join-Path $PSScriptRoot 'Observer.cs')
function Read-CimIdentity {
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$TargetPid) -Property ProcessId,Name,SessionId,CreationDate -ErrorAction Stop
 if(-not $p -or -not $p.CreationDate){throw 'CIM target identity unavailable'}
 return [pscustomobject]@{Pid=[int]$p.ProcessId;Name=[IO.Path]::GetFileNameWithoutExtension($p.Name);Session=[uint32]$p.SessionId;CreatedFileTime=$p.CreationDate.ToUniversalTime().ToFileTimeUtc();Path=$null;PathStatus='unavailable_not_queried';Alive=$true;Proof='CIM generation/session/name snapshot, not native process-handle pin'}
}
if($IdentityMode -eq 'Native'){$identity=New-Object FocusTrace.Identity($TargetPid)}else{$identity=Read-CimIdentity}
try{
 if($identity.Name -ne $ExpectedName){throw 'Target process name differs from explicit ExpectedName'}
 if(-not $Fixture -and $ExpectedName -ne 'screen-reader-util'){throw 'Ordinary fixture requires explicit -Fixture'}
 if($identity.Session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'Target is outside recorder session'}
 [void][IO.Directory]::CreateDirectory($Capture)
 $stream=New-Object IO.FileStream((Join-Path $Capture 'observations.jsonl'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 $writer=New-Object IO.StreamWriter($stream,(New-Object Text.UTF8Encoding($false)))
 $writer.AutoFlush=$true;$bytes=0L;$clean=$false;$registered=$false;$reason='failure';$lastBeat=-2.0;$lastDiscover=-2.0;$lastIdentity=-2.0;$states=@{};$browsers=@();$watch=[Diagnostics.Stopwatch]::StartNew()
 function Write-Row($row){$line=$row|ConvertTo-Json -Depth 8 -Compress;$script:bytes += [Text.Encoding]::UTF8.GetByteCount($line)+2;if($script:bytes -gt 67108864){throw '64 MiB output bound reached'};$writer.WriteLine($line)}
 function Role([uint32]$processId){if($processId -eq $TargetPid){return 'target'};if($browsers -contains [int]$processId){return 'browser'};return 'other'}
 try{
  Write-Row ([ordered]@{kind='identity';receiptUtc=[datetime]::UtcNow.ToString('o');identity=$identity;fixture=[bool]$Fixture;identityMode=$IdentityMode;tokenIdentity='not queried; privileges not inferred';monotonicFrequency=[FocusTrace.N]::Frequency})
  [FocusTrace.N]::Relevant(@([uint32]$TargetPid));[FocusTrace.N]::Begin();$registered=$true
  Write-Row ([ordered]@{kind='initial';receiptUtc=[datetime]::UtcNow.ToString('o');foreground=[FocusTrace.N]::Foreground();windows=@([FocusTrace.N]::Windows())})
  [IO.File]::WriteAllText((Join-Path $Capture 'ready.json'),(@{receiptUtc=[datetime]::UtcNow.ToString('o');registered=$true;firstObservationPersisted=$true;recorderPid=$PID}|ConvertTo-Json -Compress))
  while($watch.Elapsed.TotalSeconds -lt $DurationSeconds){
   if(Test-Path -LiteralPath (Join-Path $Capture 'stop.request')){$reason='requested';break}
   if(-not $identity.Alive){throw 'Pinned target exited; PID reuse cannot establish continuity'}
   $now=$watch.Elapsed.TotalSeconds
   if($IdentityMode -eq 'Cim' -and $now-$lastIdentity -ge 1){$current=Read-CimIdentity;if($current.Pid -ne $identity.Pid -or $current.CreatedFileTime -ne $identity.CreatedFileTime -or $current.Session -ne $identity.Session -or $current.Name -ne $identity.Name){throw 'CIM target identity changed; continuity lost'};Write-Row ([ordered]@{kind='identity-recheck';receiptUtc=[datetime]::UtcNow.ToString('o');identityMode='Cim';generationMatches=$true});$lastIdentity=$now}
   if($now-$lastDiscover -ge 1){$browsers=@(Get-Process -Name LockDownBrowser -ErrorAction SilentlyContinue|Where-Object {$_.SessionId -eq $identity.Session}|ForEach-Object {$_.Id});[FocusTrace.N]::Relevant([uint32[]](@($TargetPid)+$browsers));$lastDiscover=$now}
   foreach($event in [FocusTrace.N]::Drain()){Write-Row ([ordered]@{kind='native';classification=(Role $event.Pid);observation=$event})}
   foreach($window in [FocusTrace.N]::Windows()){$key=$window.Hwnd.ToString();$state=('{0},{1},{2},{3},{4},{5},{6}' -f $window.Pid,$window.Visible,$window.RectAvailable,$window.X,$window.Y,$window.Width,$window.Height);if($states.ContainsKey($key) -and $states[$key] -ne $state){Write-Row ([ordered]@{kind='geometry-change';classification=(Role $window.Pid);observation=$window;source='250ms metadata poll; may coalesce changes'})};$states[$key]=$state}
   foreach($file in @(Get-ChildItem -LiteralPath $Capture -Filter 'marker-*.request'|Select-Object -First 100)){if($file.Length -gt 4096){throw 'Operator marker exceeds 4 KiB'};Write-Row ([ordered]@{kind='marker-received';receiptUtc=[datetime]::UtcNow.ToString('o');operator=([IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json)});Remove-Item -LiteralPath $file.FullName}
   if($now-$lastBeat -ge 1){Write-Row ([ordered]@{kind='heartbeat';receiptUtc=[datetime]::UtcNow.ToString('o');elapsedSeconds=$now;targetAlive=$identity.Alive;browserPids=$browsers;dropped=[FocusTrace.N]::Dropped});$lastBeat=$now}
   Start-Sleep -Milliseconds 250
  }
  if($reason -eq 'failure'){$reason='duration'}
  foreach($event in [FocusTrace.N]::Drain()){Write-Row ([ordered]@{kind='native';classification=(Role $event.Pid);observation=$event})}
  foreach($file in @(Get-ChildItem -LiteralPath $Capture -Filter 'marker-*.request'|Select-Object -First 100)){if($file.Length -gt 4096){throw 'Operator marker exceeds 4 KiB'};Write-Row ([ordered]@{kind='marker-received';receiptUtc=[datetime]::UtcNow.ToString('o');operator=([IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json)});Remove-Item -LiteralPath $file.FullName}
  [FocusTrace.N]::Unregister();if(-not [FocusTrace.N]::LastUnhookSuccess){throw 'Unhook failed'};$registered=$false
  Write-Row ([ordered]@{kind='clean-stop';receiptUtc=[datetime]::UtcNow.ToString('o');reason=$reason;dropped=[FocusTrace.N]::Dropped})
  $writer.Dispose();$writer=$null
  [IO.File]::WriteAllText((Join-Path $Capture 'clean-stop.json'),(@{receiptUtc=[datetime]::UtcNow.ToString('o');reason=$reason;dropped=[FocusTrace.N]::Dropped;unhooked=$true}|ConvertTo-Json -Compress));$clean=$true
 }catch{[IO.File]::WriteAllText((Join-Path $Capture 'failure.txt'),$_.Exception.ToString());throw}finally{if($registered){[FocusTrace.N]::Unregister()};if($writer){$writer.Dispose()}}
}finally{if($IdentityMode -eq 'Native'){$identity.Dispose()}}
