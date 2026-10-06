param([string]$Scenario, [string]$Source = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$tokens = $null; $errors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Source 'scripts\cluely-admin.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Initialize-ProcessProbe', 'Get-ProcessArguments', 'Get-InstalledMainProcesses', 'Invoke-Stop')) {
  $definition = $tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
  if (-not $definition) { throw ('Missing actual production boundary: ' + $name) }
  Invoke-Expression $definition.Extent.Text
}
# Every mutation boundary below is a fixture; production selection and Stop body
# run unchanged. No real process, file, mutex, UAC or GUI operation is called.
$SessionId = 7; $ExePath = 'C:\Fixture\screen-reader-util.exe'; $PidFile = 'fixture.pid'; $FromElevated = $true
$script:Killed = @(); $script:Disposed = @(); $script:Targets = @{}; $script:Entries = @()
$baseTicks = [long]639265625976246260
$delta = switch ($Scenario) { 'valid-0' { 0 }; 'valid-1' { 1 }; 'valid-9' { 9 }; 'wrong-time' { 10 }; default { 0 } }
$expectFailure = $Scenario -in @('wrong-time','wrong-path','wrong-session','unknown-qa','missing-path','missing-command')
function Add-Fixture([int]$Number, [string]$CommandLine, [int]$Parent = 0) {
  $entry = [pscustomobject]@{ ProcessId=$Number; ParentProcessId=$Parent; SessionId=7; ExecutablePath=$ExePath; CommandLine=$CommandLine; CreationDate=[datetime]::new($baseTicks, [DateTimeKind]::Utc) }
  $target = [pscustomobject]@{ Id=$Number; Handle=1; Path=$ExePath; SessionId=7; StartTime=[datetime]::new(($baseTicks + $delta), [DateTimeKind]::Utc); HasExited=$false }
  $target | Add-Member ScriptMethod Kill { $script:Killed += $this.Id; $this.HasExited=$true }
  $target | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $this.HasExited }
  $target | Add-Member ScriptMethod Dispose { $script:Disposed += $this.Id }
  $script:Targets[$Number]=$target; $script:Entries += $entry
}
Add-Fixture 101 'C:\Fixture\screen-reader-util.exe'
Add-Fixture 102 'C:\Fixture\screen-reader-util.exe --type=renderer' 101
Add-Fixture 103 'C:\Fixture\screen-reader-util.exe C:\Fixture\resources\app.asar\src\materials\search-worker.js' 101
Add-Fixture 104 'C:\Fixture\screen-reader-util.exe C:\Fixture\other-worker.js' 101
Add-Fixture 201 'C:\Fixture\screen-reader-util.exe --ingestion-playground'
Add-Fixture 202 'C:\Fixture\screen-reader-util.exe --type=renderer' 201
Add-Fixture 301 'C:\Fixture\screen-reader-util.exe --cluely-qa-instance --user-data-dir=C:\QA'
Add-Fixture 302 'C:\Fixture\screen-reader-util.exe --type=renderer' 301
Add-Fixture 303 'C:\Fixture\screen-reader-util.exe C:\Fixture\resources\app.asar\src\materials\search-worker.js' 301
Add-Fixture 203 'C:\Fixture\screen-reader-util.exe C:\Fixture\resources\app.asar\src\materials\search-worker.js' 201
Add-Fixture 401 'C:\Fixture\screen-reader-util.exe C:\Fixture\resources\app.asar\src\materials\search-worker.js' 999
Add-Fixture 501 'C:\Fixture\screen-reader-util.exe --cluely-qa-instance --user-data-dir=C:\QA-High'
Add-Fixture 502 'C:\Fixture\screen-reader-util.exe C:\Fixture\resources\app.asar\src\materials\search-worker.js' 501
Add-Fixture 601 'C:\Fixture\screen-reader-util.exe --cluely-qa-instance --user-data-dir=C:\QA-System'
Add-Fixture 602 'C:\Fixture\screen-reader-util.exe --type=renderer' 601
Add-Fixture 701 'C:\Fixture\screen-reader-util.exe --cluely-qa-instance'
Add-Fixture 702 'C:\Fixture\screen-reader-util.exe --type=renderer' 701
function Get-ProcessMode { param([int]$ProcessId) if ($Scenario -eq 'unknown-qa' -and $ProcessId -eq 301) { return 'unknown' }; if ($ProcessId -in @(501,502)) { return 'administrator' }; if ($ProcessId -in @(601,602)) { return 'system' }; return 'normal' }
Add-Fixture 105 'C:\Runtime\python.exe worker.py' 101
Add-Fixture 305 'C:\Runtime\python.exe worker.py' 301
Add-Fixture 905 'C:\Other\other.exe worker.py' 999
foreach($number in @(105,305,905)){
  $image=if($number -eq 905){'C:\Other\other.exe'}else{'C:\Runtime\python.exe'}
  $script:Targets[$number].Path=$image
  ($script:Entries | Where-Object ProcessId -eq $number).ExecutablePath=$image
}
if ($Scenario -eq 'missing-path') { ($script:Entries | Where-Object ProcessId -eq 101).ExecutablePath=$null }
if ($Scenario -eq 'missing-command') { ($script:Entries | Where-Object ProcessId -eq 101).CommandLine=$null }
if ($Scenario -eq 'wrong-path') { $script:Targets[101].Path='C:\Other\screen-reader-util.exe' }
if ($Scenario -eq 'wrong-session') { $script:Targets[101].SessionId=8 }
function Test-IsAdmin { return $true }
function Enter-LaunchTransaction {}
function Get-CimInstance { param($ClassName,$Filter) return @($script:Entries | Where-Object { -not $script:Targets[[int]$_.ProcessId].HasExited }) }
function Get-Process { param($Id,$ErrorAction) return $script:Targets[[int]$Id] }
function Read-SessionOwner { return $null }
function Remove-Item { param($Path,[switch]$Force,$ErrorAction) }
function Write-Ok {
  param($Message)
  if ($expectFailure) { throw 'Stop unexpectedly accepted a changed process identity.' }
  if (($script:Killed | Sort-Object) -join ',' -ne '101,102,103,104,105,501,502,601,602,701,702') { throw ('Incorrect Stop scope: ' + ($script:Killed -join ',')) }
  if (@($script:Disposed | Sort-Object -Unique).Count -ne 11) { throw 'Stop did not dispose the opened target handles.' }
  Write-Output ('PASS ' + $Scenario + ': actual Stop terminated only production owner and child; QA/playground preserved')
}
try { Invoke-Stop }
catch {
  if ($expectFailure -and $_.Exception.Message -match 'process changed|Cannot verify a possible isolated QA process|Windows could not identify an existing OpenCluely process' -and $script:Killed.Count -eq 0) {
    Write-Output ('PASS ' + $Scenario + ': changed identity rejected before any kill'); exit 0
  }
  Write-Output ('FAIL ' + $Scenario + ': ' + $_.Exception.Message); exit 1
}
