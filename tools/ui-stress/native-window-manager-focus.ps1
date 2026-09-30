$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$fixture = Join-Path $PSScriptRoot 'native-window-manager-probe.cjs'
$out = Join-Path $env:TEMP ('nc-native-focus-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null
$process = Start-Process -FilePath $exe -ArgumentList @('--no-sandbox', $fixture, $root, $out, 'chat', 'guard', '--focus-test') -WorkingDirectory $root -PassThru -Wait
$file = Join-Path $out 'fixture.json'
if (-not (Test-Path $file)) { throw "Focus fixture did not report; exit=$($process.ExitCode)" }
$data = Get-Content $file -Raw | ConvertFrom-Json
$stages = @($data.events | Where-Object { $_.event -in @('owner-ready','showWindow-main','showWindow-chat-screenshot','toggleVisibility-main-active','toggleVisibility-chat-active','switchToWindow-chat') })
$byName = @{}
foreach ($stage in $stages) { $byName[$stage.event] = $stage }
$pass = $process.ExitCode -eq 0 -and $data.errors.Count -eq 0 -and
  @($stages | Where-Object { $_.event -eq 'owner-ready' -and $_.ownerFocused }).Count -eq 5 -and
  $byName['showWindow-main'].ownerFocused -and $byName['showWindow-chat-screenshot'].ownerFocused -and
  $byName['toggleVisibility-main-active'].mainFocused -and
  $byName['toggleVisibility-chat-active'].chatFocused -and
  $byName['switchToWindow-chat'].chatFocused
$result = [pscustomobject]@{ pass = [bool]$pass; exit = $process.ExitCode; output = $out; stages = $stages; errors = $data.errors }
$result | ConvertTo-Json -Depth 5
if (-not $pass) { exit 1 }
