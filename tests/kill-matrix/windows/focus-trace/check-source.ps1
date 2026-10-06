$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'focus-trace.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
Add-Type -Path (Join-Path $PSScriptRoot 'Observer.cs')
try{$p=New-Object FocusTrace.Identity(5384);$p|ConvertTo-Json;$p.Dispose()}catch{Write-Output ('PID5384 boundary: '+$_.Exception.Message)}
'PARSE_AND_COMPILE_OK'
