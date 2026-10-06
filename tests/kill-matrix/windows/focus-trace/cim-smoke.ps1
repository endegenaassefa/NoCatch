$ErrorActionPreference='Stop'
$cap=Join-Path $PSScriptRoot ('evidence-cim-smoke-'+[guid]::NewGuid().ToString('N'))
& (Join-Path $PSScriptRoot 'focus-trace.ps1') -IdentityMode Cim -TargetPid 5384 -ExpectedName screen-reader-util -Capture $cap -DurationSeconds 3
& (Join-Path $PSScriptRoot 'focus-trace.ps1') -Action Report -Capture $cap|Set-Content (Join-Path $cap 'report.json')
Write-Output $cap
