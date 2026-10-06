param([string]$Source = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
$output = Join-Path $PSScriptRoot 'SystemLauncher.QA.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /platform:x64 /target:exe /optimize+ /r:System.Web.Extensions.dll ('/out:' + $output) (Join-Path $Source 'scripts\SystemLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Actual production SYSTEM helper failed to compile.' }
# Load metadata and invoke JSON conversion only. Never invoke Main or launch.
$assembly=[Reflection.Assembly]::LoadFrom($output)
$type=$assembly.GetType('SystemLauncher')
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$strings=$type.GetMethod('JsonString',$flags)
$environment=$type.GetMethod('JsonEnv',$flags)
Add-Type -AssemblyName System.Web.Extensions
$serializer=New-Object System.Web.Script.Serialization.JavaScriptSerializer
$data=$serializer.DeserializeObject('{"exe":"C:\\Program Files\\Fixture\\screen-reader-util.exe","args":"--user-data-dir=\"C:\\QA space\"","session":"7","env":{"FIXTURE":"quotes \" braces } slash \\ unicode \u03bb newline\nend","EMPTY":""}}')
if ($strings.Invoke($null,[object[]]@($data,'exe')) -cne 'C:\Program Files\Fixture\screen-reader-util.exe') { throw 'Escaped executable path was corrupted.' }
if ($strings.Invoke($null,[object[]]@($data,'args')) -cne '--user-data-dir="C:\QA space"') { throw 'Quoted command arguments were corrupted.' }
if ($strings.Invoke($null,[object[]]@($data,'session')) -cne '7') { throw 'Invoking session was corrupted.' }
$envResult=$environment.Invoke($null,[object[]]@(,$data))
$expected='quotes " braces } slash \ unicode ' + [char]955 + " newline`nend"
if ($envResult['FIXTURE'] -cne $expected -or $envResult['EMPTY'] -cne '') { throw 'Environment strings were corrupted.' }
$rejected=0
foreach ($json in @('{"env":{"A":123}}','{"env":{"A=B":"v"}}','{"env":{"A":"bad\u0000value"}}','{"env":{"A\u0000B":"v"}}','{"env":[]}')) {
  $bad=$serializer.DeserializeObject($json)
  try { $null=$environment.Invoke($null,[object[]]@(,$bad)) }
  catch { $rejected++; continue }
  throw 'Malformed environment accepted.'
}
[pscustomobject]@{ compiled=$true; escapedPaths=$true; quotedArguments=$true; invokingSession=$true; environmentStrings=$true; rejectedMalformed=$rejected; launched=$false } | ConvertTo-Json
