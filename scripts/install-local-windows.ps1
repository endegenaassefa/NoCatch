# Replace an already installed local build after independent package QA.
# Keeps the old binaries for recovery and never runs an uninstaller or edits profiles.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory=$true)][string]$PackagePath,
  [Parameter(Mandatory=$true)][string]$InstallPath,
  [Parameter(Mandatory=$true)][string]$BackupPath,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedArchiveSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedExeSha256
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 Get-FileHash can inherit WhatIf and return no hash.
# Reading bytes through .NET keeps validation active during a dry run.
function Get-PayloadHash([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $algorithm.Dispose() }
}
$PackagePath = [IO.Path]::GetFullPath($PackagePath).TrimEnd('\')
$InstallPath = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
$BackupPath = [IO.Path]::GetFullPath($BackupPath).TrimEnd('\')
$paths = @($PackagePath, $InstallPath, $BackupPath)
foreach ($a in $paths) {
  if ($a.Length -le [IO.Path]::GetPathRoot($a).Length) { throw 'A drive root is not an application directory.' }
  $ancestor = $a
  while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -Force -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Directory links are not supported in installation paths.'
    }
    $ancestor = Split-Path -Parent $ancestor
  }
  foreach ($b in $paths) {
    if ($a -ne $b -and $a.StartsWith($b + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Package, install and backup directories must not contain each other.'
    }
  }
  if ([IO.Path]::GetPathRoot($a) -ne [IO.Path]::GetPathRoot($InstallPath)) { throw 'Use one volume for reversible directory renames.' }
}
if (($paths | Select-Object -Unique).Count -ne 3) { throw 'Use three distinct directories.' }
if (Test-Path -LiteralPath $BackupPath) { throw 'Backup already exists; preserve it and choose a new path.' }
if (-not (Test-Path -LiteralPath (Join-Path $InstallPath 'screen-reader-util.exe'))) { throw 'Existing installation not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $InstallPath 'resources\app.asar'))) { throw 'Existing app archive not found.' }
foreach ($p in @($PackagePath, $InstallPath)) {
  if ((Get-Item -Force -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Directory links are not supported.' }
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.Count -lt 2) { throw 'The independent package manifest is empty or incomplete.' }
$expected = @{}
foreach ($entry in $manifest) {
  $relative = [string]$entry.path
  if (-not $relative -or $relative -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $expected.ContainsKey($relative)) {
    throw 'Invalid or duplicate package manifest entry.'
  }
  $expected[$relative] = $entry.sha256
}
function Assert-Candidate([string]$Directory) {
  $files = @(Get-ChildItem -LiteralPath $Directory -Recurse -Force)
  if (@($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Package contains a filesystem link.' }
  $files = @($files | Where-Object { -not $_.PSIsContainer })
  if ($files.Count -ne $expected.Count) { throw 'Package file count differs from the independent manifest.' }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($Directory.Length + 1).Replace('\', '/')
    if (-not $expected.ContainsKey($relative) -or (Get-PayloadHash $file.FullName) -ne $expected[$relative]) {
      throw ('Package payload differs from the independent manifest: ' + $relative)
    }
  }
  foreach ($entry in @(
    @('screen-reader-util.exe', $ExpectedExeSha256),
    @('resources\app.asar', $ExpectedArchiveSha256)
  )) {
    $actual = Get-PayloadHash (Join-Path $Directory $entry[0])
    if ($actual -ne $entry[1]) { throw ('Candidate identity differs from the verified build: ' + $entry[0]) }
  }
}
Assert-Candidate $PackagePath
if (@(Get-Process -Name 'screen-reader-util' -ErrorAction SilentlyContinue).Count) {
  throw 'Close NoCatch and its QA instances before replacing application binaries.'
}
if (-not $PSCmdlet.ShouldProcess($InstallPath, "Install verified local package; retain prior binaries at $BackupPath")) { return }
$backedUp = $false
$installed = $false
try {
  [IO.Directory]::Move($InstallPath, $BackupPath)
  $backedUp = $true
  [IO.Directory]::Move($PackagePath, $InstallPath)
  $installed = $true
  Assert-Candidate $InstallPath
  $uninstaller = Join-Path $BackupPath 'Uninstall screen-reader-util.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    if ((Get-Item -Force -LiteralPath $uninstaller).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Existing uninstaller must be an ordinary file.' }
    $uninstallerHash = Get-PayloadHash $uninstaller
    Copy-Item -LiteralPath $uninstaller -Destination $InstallPath
    if ((Get-PayloadHash (Join-Path $InstallPath 'Uninstall screen-reader-util.exe')) -ne $uninstallerHash) { throw 'Existing uninstaller copy differs.' }
  }
} catch {
  $originalFailure = $_.Exception.Message
  $recoveryErrors = @()
  if ($installed) {
    try { [IO.Directory]::Move($InstallPath, $PackagePath) }
    catch { $recoveryErrors += $_.Exception.Message }
  }
  if ($backedUp) {
    try {
      if (Test-Path -LiteralPath $InstallPath) { throw 'Install path remains occupied; prior binaries retained at backup.' }
      [IO.Directory]::Move($BackupPath, $InstallPath)
    } catch { $recoveryErrors += $_.Exception.Message }
  }
  throw "Installation failed: $originalFailure. Recovery errors: $($recoveryErrors -join '; '). Prior binaries: $BackupPath. Install path: $InstallPath. Candidate: $PackagePath."
}
[pscustomobject]@{
  installed = $InstallPath
  previousBinaries = $BackupPath
  archiveSha256 = $ExpectedArchiveSha256
  exeSha256 = $ExpectedExeSha256
  profiles = 'not accessed by this script'
} | ConvertTo-Json
