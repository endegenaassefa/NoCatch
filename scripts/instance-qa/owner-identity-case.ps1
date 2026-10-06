param([string]$Scenario,[int]$PeerProcessId,[int]$SessionId,[string]$Source=(Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Source 'scripts\cluely-admin.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw($errors|Out-String)}
# Load production functions only, never launcher top-level actions. Native pipe
# server identity and transport remain real. OS process/token/WMI reads are fixtures.
foreach($definition in $tree.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){Invoke-Expression $definition.Extent.Text}
$ExePath='C:\Fixture\screen-reader-util.exe'
$script:Disposed=0;$script:TargetCreated=$false;$script:PeerTarget=$null
function Get-Process {
  param([int]$Id,$ErrorAction)
  if($Id -ne $PeerProcessId){throw 'Unexpected process identity request'}
  $target=[pscustomobject]@{Id=$Id;SessionId=$(if($Scenario -eq 'wrong-session'){$SessionId+1}else{$SessionId});Path=$(if($Scenario -eq 'missing-image'){$null}elseif($Scenario -eq 'wrong-image'){'C:\Impostor\screen-reader-util.exe'}else{$ExePath});ProcessName='screen-reader-util';Handle=[IntPtr]1;HasExited=($Scenario -eq 'exited-peer')}
  $target|Add-Member ScriptMethod Dispose {$script:Disposed++}
  $script:TargetCreated=$true;$script:PeerTarget=$target
  return $target
}
function Get-ProcessMode {param([int]$ProcessId)if($Scenario -eq 'native-normal'){return 'normal'};if($Scenario -eq 'native-system'){return 'system'};return 'unknown'}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction)if($Scenario -eq 'missing-process'){return $null};return [pscustomobject]@{ProcessId=$PeerProcessId;SessionId=$SessionId;ExecutablePath=$ExePath}}
function Invoke-CimMethod {
  param($InputObject,$MethodName,$ErrorAction)
  if($MethodName -ne 'GetOwnerSid'){throw 'Unexpected WMI method'}
  if($Scenario -eq 'sid-query-error'){throw 'Fixture WMI denied'}
  if($Scenario -eq 'peer-exits-during-sid'){$script:PeerTarget.HasExited=$true}
  return [pscustomobject]@{ReturnValue=$(if($Scenario -eq 'sid-failure'){2}else{0});Sid=$(if($Scenario -eq 'normal-sid'){'S-1-5-21-1-2-3-1001'}elseif($Scenario -eq 'missing-sid'){$null}else{'S-1-5-18'})}
}
$accept=$Scenario -in @('system-denied-token','native-system')
try{
  $owner=Read-SessionOwner 'status'
  if($script:TargetCreated -and $script:Disposed -ne 1){throw 'QA_REJECT: server process handle not disposed exactly once'}
  if(-not $accept){throw 'QA_REJECT: unverified peer was accepted'}
  if($owner.pid -ne $PeerProcessId -or $owner.mode -ne 'system' -or $owner.ready -isnot [bool]){throw 'QA_REJECT: wrong owner output'}
  Write-Output ('PASS '+$Scenario+': verified actual pipe peer');exit 0
}catch{
  if($script:TargetCreated -and $script:Disposed -ne 1){Write-Output ('FAIL: server process handle not disposed exactly once; original verification error: '+$_.Exception.Message);exit 1}
  if(-not $accept -and $_.Exception.Message -notmatch 'QA_REJECT|not recognized|Unexpected'){
    Write-Output ('PASS '+$Scenario+': refused unverified peer');exit 0
  }
  Write-Output ('FAIL '+$Scenario+': '+$_.Exception.Message);exit 1
}
