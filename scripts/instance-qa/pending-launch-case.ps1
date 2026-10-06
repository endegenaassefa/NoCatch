param([ValidateSet('pending','ready-hidden','ready-visible')][string]$Scenario,[string]$Source=(Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Source 'scripts\cluely-admin.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw($errors|Out-String)}
$definition=$tree.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Confirm-AvailableSession'},$true)
Invoke-Expression $definition.Extent.Text
function Read-SessionOwner {param($Action)if($Action -ne 'activate'){throw 'Repeat must request activation'};return [pscustomobject]@{pid=101;mode='administrator';ready=($Scenario -ne 'pending')}}
function Test-VisibleWindow {param($ProcessId)return $Scenario -eq 'ready-visible'}
function Show-LaunchMessage {throw 'Same-mode repeat opened a blocking modal'}
function Write-Info {param($Message)if($Message -notmatch 'still opening' -or $Message -notmatch 'No new session'){throw 'Pending launch status is unclear'};Write-Output ('PASS '+$Scenario+': '+$Message)}
function Write-Ok {param($Message)if($Scenario -ne 'ready-visible'){throw 'Non-visible owner falsely reported ready'};Write-Output ('PASS '+$Scenario+': '+$Message)}
Confirm-AvailableSession 'administrator'
throw 'Repeat did not return an explicit launcher exit'
