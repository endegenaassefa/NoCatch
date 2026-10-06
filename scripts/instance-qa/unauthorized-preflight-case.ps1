param([ValidateSet('administrator','system')][string]$RequestedMode,[string]$Source=(Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Source 'scripts\cluely-admin.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw($errors|Out-String)}
$definition=$tree.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Confirm-AvailableSession'},$true)
Invoke-Expression $definition.Extent.Text
$FromElevated=$false
function Read-SessionOwner {param($Action)throw [UnauthorizedAccessException]::new('Fixture cannot query SYSTEM process path')}
function Test-IsAdmin {return $false}
function Invoke-ElevatedCommand {param($Mode)
  $expected=if($RequestedMode -eq 'system'){'system'}else{'start'}
  if($Mode -ne $expected){throw 'Wrong elevation route'}
  Write-Output ('PASS '+$RequestedMode+': authorization requested before any launch');exit 0
}
function Get-InstalledMainProcesses {throw 'Unreadable owner treated as absent'}
function Start-Process {throw 'Unexpected direct process launch'}
Confirm-AvailableSession $RequestedMode
throw 'Unauthorized owner check did not request elevation'
