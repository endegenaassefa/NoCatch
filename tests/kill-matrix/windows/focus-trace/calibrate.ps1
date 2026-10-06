$ErrorActionPreference='Stop'
$e=Join-Path $PSScriptRoot ('evidence-'+[datetime]::UtcNow.ToString('yyyyMMddTHHmmss')+'-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($e)
$ps=Join-Path $PSHOME 'powershell.exe'
$fixture=$null;$record=$null
try{
 $fixture=Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-File',('"'+(Join-Path $PSScriptRoot 'fixture.ps1')+'"'),'-Control',('"'+$e+'"')) -PassThru
 $limit=[datetime]::UtcNow.AddSeconds(20);while(-not(Test-Path (Join-Path $e 'fixture.json'))){if([datetime]::UtcNow -gt $limit){throw 'fixture readiness timeout'};Start-Sleep -Milliseconds 100}
 $id=Get-Content (Join-Path $e 'fixture.json') -Raw|ConvertFrom-Json
 if($id.pid -ne $fixture.Id){throw 'Fixture PID mismatch'}
 $cap=Join-Path $e 'capture'
 $record=Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-File',('"'+(Join-Path $PSScriptRoot 'focus-trace.ps1')+'"'),'-TargetPid',$fixture.Id,'-ExpectedName','powershell','-Fixture','-Capture',('"'+$cap+'"'),'-DurationSeconds','45') -RedirectStandardOutput (Join-Path $e 'recorder.stdout.txt') -RedirectStandardError (Join-Path $e 'recorder.stderr.txt') -PassThru
 $limit=[datetime]::UtcNow.AddSeconds(20);while(-not(Test-Path (Join-Path $cap 'ready.json'))){if($record.HasExited -or [datetime]::UtcNow -gt $limit){throw 'recorder readiness failure'};Start-Sleep -Milliseconds 100}
 Start-Sleep -Seconds 5
 [IO.File]::WriteAllText((Join-Path $e 'quiet-ended.json'),(@{utc=[datetime]::UtcNow.ToString('o')}|ConvertTo-Json))
 [IO.File]::WriteAllText((Join-Path $e 'switch.request'),'owned fixture switch')
 Start-Sleep -Seconds 2
 [IO.File]::WriteAllText((Join-Path $e 'move.request'),'owned fixture position change, not physical drag')
 Start-Sleep -Seconds 3
 & (Join-Path $PSScriptRoot 'focus-trace.ps1') -Action Mark -Capture $cap -Marker trial-end
 & (Join-Path $PSScriptRoot 'focus-trace.ps1') -Action Stop -Capture $cap
 if(-not $record.WaitForExit(10000)){throw 'clean stop timeout'}
 & (Join-Path $PSScriptRoot 'focus-trace.ps1') -Action Report -Capture $cap|Set-Content (Join-Path $e 'report.json')
 # Fail-closed controls; the valid fixture remains alive for identity checks.
 try{& $ps -NoProfile -File (Join-Path $PSScriptRoot 'focus-trace.ps1') -TargetPid $fixture.Id -ExpectedName powershell -Fixture -Capture $cap 2>&1|Set-Content (Join-Path $e 'reuse.txt');$reuse=$LASTEXITCODE}catch{$reuse=1;($_|Out-String)|Set-Content (Join-Path $e 'reuse.txt')}
 try{& $ps -NoProfile -File (Join-Path $PSScriptRoot 'focus-trace.ps1') -TargetPid 2147483647 -ExpectedName powershell -Fixture -Capture (Join-Path $e 'invalid') 2>&1|Set-Content (Join-Path $e 'invalid.txt');$invalid=$LASTEXITCODE}catch{$invalid=1;($_|Out-String)|Set-Content (Join-Path $e 'invalid.txt')}
 # Synthetic evidence truncation control, explicitly not an actual abrupt process kill.
 $partial=Join-Path $e 'synthetic-incomplete';[void][IO.Directory]::CreateDirectory($partial)
 Copy-Item (Join-Path $cap 'ready.json') $partial;Copy-Item (Join-Path $cap 'observations.jsonl') $partial
 & (Join-Path $PSScriptRoot 'focus-trace.ps1') -Action Report -Capture $partial|Set-Content (Join-Path $e 'incomplete-report.json')
 @{reuseExit=$reuse;invalidExit=$invalid;incompleteControl='copied evidence without clean-stop marker, synthetic control'}|ConvertTo-Json|Set-Content (Join-Path $e 'negative-controls.json')
 Write-Output $e
}finally{
 if($record -and -not $record.HasExited){Stop-Process -Id $record.Id}
 if($fixture -and -not $fixture.HasExited){[IO.File]::WriteAllText((Join-Path $e 'close.request'),'cleanup owned fixture');if(-not $fixture.WaitForExit(3000)){Stop-Process -Id $fixture.Id}}
 @{utc=[datetime]::UtcNow.ToString('o');fixtureExited=($fixture -and $fixture.HasExited);recorderExited=($record -and $record.HasExited)}|ConvertTo-Json|Set-Content (Join-Path $e 'cleanup.json')
}
