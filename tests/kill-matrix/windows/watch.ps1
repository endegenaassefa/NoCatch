param(
  [Parameter(Position = 0)]
  [ValidateSet('Setup', 'Start', 'Stop', 'Status', 'Report')]
  [string]$Command = 'Status',
  [int]$TargetPid = 0,
  [string]$Capture = '',
  [string]$SysmonExe = '',
  [switch]$AuditOnly,
  [int]$DurationSeconds = 0,
  [string]$StopWhenProcessExit = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$CaptureRoot = Join-Path $Here 'capture'
$ActiveFile = Join-Path $CaptureRoot 'active.json'
$PidFile = Join-Path $env:TEMP 'cluely-root.pid'
$SysmonLog = 'Microsoft-Windows-Sysmon/Operational'

function Write-Ok([string]$Message) { Write-Host ('[OK]   ' + $Message) }
function Write-Warn([string]$Message) { Write-Host ('[WARN] ' + $Message) -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host ('[FAIL] ' + $Message) -ForegroundColor Red }
function Test-IsAdmin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Require-Admin {
  if (-not (Test-IsAdmin)) { throw 'Open Windows PowerShell as Administrator and retry.' }
}
function Append-Json([string]$Path, $Value) {
  Add-Content -LiteralPath $Path -Value (ConvertTo-Json -InputObject $Value -Depth 8 -Compress) -Encoding UTF8
}
function Save-Json([string]$Path, $Value) {
  [System.IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
}
function Save-Active($Value) {
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes((ConvertTo-Json -InputObject $Value -Depth 8))
  $stream = [System.IO.File]::Open($ActiveFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

# Copied without changing the identity test from scripts/cluely.ps1. Never
# trust a bare PID or a process with the right name but a reused PID.
function Get-PidFileValue {
  if (-not (Test-Path $PidFile)) { return 0 }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw -match 'PID=(\d+)') { $raw = $Matches[1] }
  $n = 0
  if ([int]::TryParse($raw, [ref]$n)) { return $n }
  return 0
}
function Get-PidFileCreated {
  if (-not (Test-Path $PidFile)) { return '' }
  $line = Select-String -Path $PidFile -Pattern '^CREATED=(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value }
  return ''
}
function Get-ProcessCreatedWmi([int]$ProcessId) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction SilentlyContinue
  if (-not $p) { return '' }
  $created = $p.CreationDate
  if ($created -is [datetime]) { return $created.ToUniversalTime().Ticks.ToString() }
  try {
    return ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created)).ToUniversalTime().Ticks.ToString()
  } catch {
    return ''
  }
}
function Test-PidFileOwnsProcess([int]$ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne 'screen-reader-util') { return $false }
  $created = Get-PidFileCreated
  if ($created -eq '') { return $false }
  $wmi = Get-ProcessCreatedWmi $ProcessId
  if ($wmi -eq '') { return $false }
  return $wmi -eq $created
}

function Convert-Number($Value) {
  if ($null -eq $Value -or [string]$Value -eq '') { return 0L }
  $s = [string]$Value
  try {
    if ($s -match '^0x([0-9a-fA-F]+)$') { return [Convert]::ToInt64($Matches[1], 16) }
    return [Convert]::ToInt64($s)
  } catch { return 0L }
}
function Get-EventFields($Event) {
  $xml = [xml]$Event.ToXml()
  $fields = @{}
  foreach ($entry in @($xml.Event.EventData.Data)) {
    if ($entry -is [System.Xml.XmlElement] -and $entry.Name) { $fields[[string]$entry.GetAttribute('Name')] = [string]$entry.InnerText }
  }
  return $fields
}
function Get-Field($Fields, [string]$Name) {
  if ($Fields.ContainsKey($Name)) { return [string]$Fields[$Name] }
  return ''
}
function Test-TargetAlive([int]$ProcessId, [string]$CreatedTicks) {
  if (-not $CreatedTicks) { return $false }
  return (Get-ProcessCreatedWmi $ProcessId) -eq $CreatedTicks
}
function Test-EventGeneration($Event, [string]$CreatedTicks) {
  $createdUtc = [datetime]::new([long]$CreatedTicks, [System.DateTimeKind]::Utc)
  return $Event.TimeCreated.ToUniversalTime() -ge $createdUtc.AddMilliseconds(-100)
}
function Get-SysmonReady {
  try { return [bool](Get-WinEvent -ListLog $SysmonLog -ErrorAction Stop).IsEnabled }
  catch { return $false }
}
function Get-InitialGuid([int]$ProcessId, [string]$CreatedTicks) {
  if (-not (Get-SysmonReady)) { return '' }
  $createdUtc = [datetime]::new([long]$CreatedTicks, [System.DateTimeKind]::Utc)
  try {
    $events = @(Get-WinEvent -FilterHashtable @{LogName = $SysmonLog; Id = 1; StartTime = $createdUtc.AddSeconds(-3).ToLocalTime(); EndTime = $createdUtc.AddSeconds(3).ToLocalTime()} -ErrorAction Stop)
    $matches = @()
    foreach ($ev in $events) {
      $f = Get-EventFields $ev
      if ([int](Convert-Number (Get-Field $f 'ProcessId')) -ne $ProcessId) { continue }
      $eventUtc = [datetimeoffset]::Parse((Get-Field $f 'UtcTime')).UtcDateTime
      if ([math]::Abs(($eventUtc - $createdUtc).TotalMilliseconds) -le 100) { $matches += (Get-Field $f 'ProcessGuid').ToLowerInvariant() }
    }
    if ($matches.Count -eq 1) { return $matches[0] }
  } catch { }
  return ''
}

function Invoke-Setup {
  Require-Admin
  New-Item -ItemType Directory -Path $CaptureRoot -Force | Out-Null
  $commands = @(
    'Process Creation', 'Process Termination', 'Kernel Object', 'Handle Manipulation'
  )
  foreach ($subcategory in $commands) {
    $output = & auditpol.exe /set /subcategory:$subcategory /success:enable /failure:enable 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('auditpol failed for ' + $subcategory + ': ' + ($output | Out-String)) }
    Write-Ok ('Audit enabled: ' + $subcategory)
  }
  Write-Warn 'A process needs a matching audit SACL before denied opens appear as Security 4656. Calibration checks this.'
  if ($AuditOnly) {
    Write-Warn 'Sysmon declined: audit-only mode. Successful process opens may be invisible.'
    return
  }
  if (-not $SysmonExe) {
    $toolDir = Join-Path $Here 'tools'
    New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
    $zipPath = Join-Path $toolDir 'Sysmon.zip'
    Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/Sysmon.zip' -OutFile $zipPath -UseBasicParsing
    Expand-Archive -LiteralPath $zipPath -DestinationPath $toolDir -Force
    $SysmonExe = Join-Path $toolDir 'Sysmon64.exe'
  }
  if (-not (Test-Path -LiteralPath $SysmonExe)) { throw ('Sysmon executable missing: ' + $SysmonExe) }
  $signature = Get-AuthenticodeSignature -LiteralPath $SysmonExe
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw ('Sysmon signature is not valid Microsoft code: ' + $signature.Status)
  }
  $service = Get-Service -Name 'Sysmon64','Sysmon' -ErrorAction SilentlyContinue | Select-Object -First 1
  $config = Join-Path $Here 'sysmon.xml'
  if ($service) { & $SysmonExe -c $config }
  else { & $SysmonExe -accepteula -i $config }
  if ($LASTEXITCODE -ne 0 -or -not (Get-SysmonReady)) { throw 'Sysmon install/configuration did not produce an enabled Operational log.' }
  Write-Ok ('Sysmon active; config: ' + $config)
}

function Get-RootTargets([int]$RootPid, [string]$RootCreated) {
  $known = @{}
  $known[[string]$RootPid] = [pscustomobject]@{ pid = $RootPid; created = $RootCreated; image = 'screen-reader-util.exe'; guid = '' }
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($proc in $all) {
      $id = [string]$proc.ProcessId
      $parent = [string]$proc.ParentProcessId
      if ($known.ContainsKey($id) -or -not $known.ContainsKey($parent)) { continue }
      $created = Get-ProcessCreatedWmi ([int]$proc.ProcessId)
      if (-not $created -or [long]$created -lt [long]$known[$parent].created) { continue }
      $known[$id] = [pscustomobject]@{ pid = [int]$proc.ProcessId; created = $created; image = [string]$proc.Name; guid = '' }
      $changed = $true
    }
  }
  return $known
}

function Get-EventsSince([string]$Log, [int[]]$Ids, [datetime]$From, [string]$RunDir) {
  # Get-WinEvent interprets StartTime as wall-clock local time even when a
  # DateTime is UTC. Passing UTC here silently queries hours in the future.
  try { return @(Get-WinEvent -FilterHashtable @{ LogName = $Log; Id = $Ids; StartTime = $From.ToLocalTime() } -ErrorAction Stop) }
  catch {
    if ($_.FullyQualifiedErrorId -notmatch 'NoMatchingEventsFound') {
      Add-Content -LiteralPath (Join-Path $RunDir 'capture-warnings.log') -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Log + ': ' + $_.Exception.Message)
    }
    return @()
  }
}
function Process-Event($Event, [string]$Channel, $Targets, $Seen, [string]$RunDir) {
  $identity = $Channel + ':' + $Event.RecordId
  if ($Seen.ContainsKey($identity)) { return }
  $Seen[$identity] = $true
  $run = Read-Json (Join-Path $RunDir 'run.json')
  $startedUtc = [datetimeoffset]::Parse([string]$run.startedUtc).UtcDateTime
  if ($Event.TimeCreated.ToUniversalTime() -lt $startedUtc) { return }
  $f = Get-EventFields $Event
  $eventId = [int]$Event.Id
  $target = 0
  $source = 0
  $sourceImage = ''
  $access = 0L
  $kind = ''
  $verdict = ''
  $note = ''
  if ($Channel -eq 'sysmon') {
    if ($eventId -eq 10) {
      $target = [int](Convert-Number (Get-Field $f 'TargetProcessId'))
      if (-not $Targets.ContainsKey([string]$target)) { return }
      $targetIdentity = $Targets[[string]$target]
      if (-not (Test-EventGeneration $Event $targetIdentity.created)) { return }
      $eventGuid = (Get-Field $f 'TargetProcessGuid').ToLowerInvariant()
      if ($targetIdentity.guid) {
        if ($eventGuid -ne $targetIdentity.guid) { return }
      } elseif ((Test-TargetAlive $target $targetIdentity.created) -and $eventGuid) {
        $targetIdentity.guid = $eventGuid
        Write-Ok ('Target PID ' + $target + ' Sysmon GUID pinned: ' + $eventGuid)
      } else { return }
      $source = [int](Convert-Number (Get-Field $f 'SourceProcessId'))
      $sourceImage = Get-Field $f 'SourceImage'
      $access = Convert-Number (Get-Field $f 'GrantedAccess')
      $kind = 'process-access'
      if (($access -band 1) -eq 1) { $verdict = 'GRANTED' }
      else { $note = 'Opened target without PROCESS_TERMINATE.' }
    } elseif ($eventId -eq 5) {
      $target = [int](Convert-Number (Get-Field $f 'ProcessId'))
      if (-not $Targets.ContainsKey([string]$target)) { return }
      $targetIdentity = $Targets[[string]$target]
      if (-not (Test-EventGeneration $Event $targetIdentity.created)) { return }
      if (-not $targetIdentity.guid -or (Get-Field $f 'ProcessGuid').ToLowerInvariant() -ne $targetIdentity.guid) { return }
      $kind = 'target-exit'
    } elseif ($eventId -eq 1) {
      $source = [int](Convert-Number (Get-Field $f 'ProcessId'))
      $commandLine = Get-Field $f 'CommandLine'
      $parent = [int](Convert-Number (Get-Field $f 'ParentProcessId'))
      if (-not $Targets.ContainsKey([string]$source) -and -not $Targets.ContainsKey([string]$parent) -and $commandLine -notmatch '(?i)cluely|screen-reader|taskkill') { return }
      $sourceImage = Get-Field $f 'Image'
      $kind = 'process-create'
    }
  } else {
    if ($eventId -eq 4689) {
      $target = [int](Convert-Number (Get-Field $f 'ProcessId'))
      if (-not $Targets.ContainsKey([string]$target)) { return }
      if (-not (Test-EventGeneration $Event $Targets[[string]$target].created)) { return }
      if (-not (Test-TargetAlive $target $Targets[[string]$target].created)) { return }
      $kind = 'target-exit'
    } elseif ($eventId -eq 4656 -or $eventId -eq 4663) {
      if ((Get-Field $f 'ObjectType') -ne 'Process') { return }
      $access = Convert-Number (Get-Field $f 'AccessMask')
      if (($access -band 1) -ne 1) { return }
      $source = [int](Convert-Number (Get-Field $f 'ProcessId'))
      $sourceImage = Get-Field $f 'ProcessName'
      $objectName = Get-Field $f 'ObjectName'
      # A Security 4656 often has no target PID. Never attribute a blank or
      # merely similar object name to Cluely.
      foreach ($key in $Targets.Keys) {
        if ($objectName -eq $key -or $objectName -eq ('0x{0:x}' -f [int]$key)) { $target = [int]$key; break }
      }
      if ($target -and (-not (Test-TargetAlive $target $Targets[[string]$target].created) -or -not (Test-EventGeneration $Event $Targets[[string]$target].created))) { $target = 0 }
      $failed = @($Event.KeywordsDisplayNames) -join ' ' -match 'Audit Failure'
      $kind = 'process-handle-request'
      if ($failed -and $target) { $verdict = 'BLOCKED' }
      elseif (-not $target) { $note = 'Security event has no trustworthy target PID; left unattributed.' }
    } elseif ($eventId -eq 4688) {
      $source = [int](Convert-Number (Get-Field $f 'NewProcessId'))
      $commandLine = Get-Field $f 'CommandLine'
      if (-not $Targets.ContainsKey([string]$source) -and $commandLine -notmatch '(?i)cluely|screen-reader|taskkill') { return }
      $sourceImage = Get-Field $f 'NewProcessName'
      $kind = 'process-create'
    }
  }
  if (-not $kind) { return }
  $alive = $null
  if ($target -and $Targets.ContainsKey([string]$target)) { $alive = Test-TargetAlive $target $Targets[[string]$target].created }
  $row = [ordered]@{
    timeUtc = $Event.TimeCreated.ToUniversalTime().ToString('o'); channel = $Channel
    eventId = $eventId; recordId = [long]$Event.RecordId; kind = $kind
    sourcePid = $source; sourceImage = $sourceImage; targetPid = $target
    accessMask = ('0x{0:x}' -f $access); verdict = $verdict; aliveAtRead = $alive
    note = $note; fields = $f
  }
  Append-Json (Join-Path $RunDir 'events.jsonl') $row
  if ($verdict -or $kind -eq 'target-exit') {
    $line = '{0} {1} {2} PID {3} -> PID {4} access={5} alive={6} [{7}:{8}]' -f $row.timeUtc, $verdict, $kind, $source, $target, $row.accessMask, $alive, $Channel, $row.recordId
    Add-Content -LiteralPath (Join-Path $RunDir 'interactions.log') -Value $line -Encoding UTF8
    Write-Host $line
  }
}

function Invoke-Start {
  Require-Admin
  if (Test-Path $ActiveFile) { throw ('Another capture is active: ' + $ActiveFile) }
  if ($TargetPid -gt 0) {
    $rootCreated = Get-ProcessCreatedWmi $TargetPid
    if (-not $rootCreated) { throw ('Scratch target PID not live: ' + $TargetPid) }
    $mode = 'scratch'
  } else {
    $TargetPid = Get-PidFileValue
    if ($TargetPid -le 0 -or -not (Test-PidFileOwnsProcess $TargetPid)) { throw 'No proven elevated OpenCluely pidfile owner.' }
    $rootCreated = Get-PidFileCreated
    $mode = 'cluely'
  }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
  $runDir = Join-Path $CaptureRoot $stamp
  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
  $start = (Get-Date).ToUniversalTime()
  $state = [ordered]@{ capture = $runDir; mode = $mode; rootPid = $TargetPid; rootCreated = $rootCreated; watcherPid = $PID; startedUtc = $start.ToString('o'); sysmon = (Get-SysmonReady); auditOnly = $AuditOnly.IsPresent; stopWhenProcessExit = $StopWhenProcessExit }
  try {
    Save-Json (Join-Path $runDir 'run.json') $state
    New-Item -ItemType File -Path (Join-Path $runDir 'events.jsonl'),(Join-Path $runDir 'interactions.log') -Force | Out-Null
    Write-Ok ('Recording ' + $mode + ' PID ' + $TargetPid + ' into ' + $runDir)
    if (-not $state.sysmon) { Write-Warn 'Sysmon unavailable. Successful process opens will not be reliably visible.' }
    $seen = @{}
    $targets = @{}
    $initialGuid = Get-InitialGuid $TargetPid $rootCreated
    $targets[[string]$TargetPid] = [pscustomobject]@{ pid = $TargetPid; created = $rootCreated; image = $mode; guid = $initialGuid }
    if ($initialGuid) { Write-Ok ('Target PID ' + $TargetPid + ' Sysmon GUID pinned: ' + $initialGuid) }
    if (-not $initialGuid -and $state.sysmon) { Write-Warn 'Target Sysmon GUID not yet known; event attribution waits for a live-identity access.' }
    $from = $start.AddSeconds(-2)
    Save-Active $state
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $runDir 'capture-error.txt'), $_.Exception.ToString())
    throw
  }
  $observedStopProcess = $false
  $stopProcessGoneAt = $null
  try {
    while (-not (Test-Path (Join-Path $runDir 'stop.request'))) {
      if ($mode -eq 'cluely' -and (Test-TargetAlive $TargetPid $rootCreated)) {
        $current = Get-RootTargets $TargetPid $rootCreated
        foreach ($key in $current.Keys) {
          if (-not $targets.ContainsKey($key) -or $targets[$key].created -ne $current[$key].created) { $targets[$key] = $current[$key] }
        }
      }
      $batch = @()
      foreach ($ev in (Get-EventsSince $SysmonLog @(1,5,10) $from $runDir)) { $batch += [pscustomobject]@{ channel = 'sysmon'; event = $ev } }
      foreach ($ev in (Get-EventsSince 'Security' @(4656,4663,4688,4689) $from $runDir)) { $batch += [pscustomobject]@{ channel = 'security'; event = $ev } }
      foreach ($item in ($batch | Sort-Object @{ Expression = { $_.event.TimeCreated } }, @{ Expression = { $_.event.RecordId } })) {
        Process-Event $item.event $item.channel $targets $seen $runDir
      }
      Save-Json (Join-Path $runDir 'targets.json') @($targets.Values)
      if ($StopWhenProcessExit) {
        $present = [bool](Get-Process -Name $StopWhenProcessExit -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($present) { $observedStopProcess = $true; $stopProcessGoneAt = $null }
        elseif ($observedStopProcess) {
          if (-not $stopProcessGoneAt) { $stopProcessGoneAt = (Get-Date).ToUniversalTime() }
          elseif (((Get-Date).ToUniversalTime() - $stopProcessGoneAt).TotalSeconds -ge 8) {
            Set-Content -LiteralPath (Join-Path $runDir 'stop-reason.txt') -Value ($StopWhenProcessExit + ' exited')
            break
          }
        } elseif (((Get-Date).ToUniversalTime() - $start).TotalSeconds -ge 120) {
          Set-Content -LiteralPath (Join-Path $runDir 'stop-reason.txt') -Value ($StopWhenProcessExit + ' never appeared within 120 seconds')
          break
        }
      }
      if ($DurationSeconds -gt 0 -and ((Get-Date).ToUniversalTime() - $start).TotalSeconds -ge $DurationSeconds) {
        Set-Content -LiteralPath (Join-Path $runDir 'stop-reason.txt') -Value ('duration limit ' + $DurationSeconds + ' seconds')
        break
      }
      Start-Sleep -Milliseconds 900
    }
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $runDir 'capture-error.txt'), $_.Exception.ToString())
    throw
  } finally {
    $end = (Get-Date).ToUniversalTime()
    ("$end") | Set-Content -LiteralPath (Join-Path $runDir 'ended.txt')
    try {
      $activeAtEnd = Read-Json $ActiveFile
      if ($activeAtEnd -and [string]$activeAtEnd.capture -eq $runDir -and [int]$activeAtEnd.watcherPid -eq $PID) {
        Remove-Item -LiteralPath $ActiveFile -Force -ErrorAction SilentlyContinue
      }
    } catch { }
    Invoke-Report $runDir
  }
}

function Invoke-Report([string]$RunDir) {
  if (-not $RunDir) {
    $runs = @(Get-ChildItem $CaptureRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    if ($runs.Count -eq 0) { throw 'No capture exists.' }
    $RunDir = $runs[0].FullName
  }
  try { $meta = Read-Json (Join-Path $RunDir 'run.json') } catch { $meta = $null }
  if (-not $meta) {
    [System.IO.File]::WriteAllText((Join-Path $RunDir 'report.md'), '# INCOMPLETE CAPTURE' + [Environment]::NewLine + 'Missing or unreadable run.json. The watcher failed before a usable capture began.')
    Write-Warn ('Incomplete report: ' + (Join-Path $RunDir 'report.md'))
    return
  }
  $reportStart = [datetimeoffset]::Parse([string]$meta.startedUtc).UtcDateTime
  try { $targetIdentities = @(Read-Json (Join-Path $RunDir 'targets.json')) } catch { $targetIdentities = @() }
  $rootIdentity = @($targetIdentities | Where-Object { $_.pid -eq $meta.rootPid -and $_.created -eq $meta.rootCreated } | Select-Object -First 1)
  $rootGuidPinned = $false
  $rootGuidStatus = 'unknown (capture predates GUID tracking)'
  if ($rootIdentity.Count -gt 0 -and $rootIdentity[0].PSObject.Properties['guid']) {
    $rootGuidPinned = [bool]$rootIdentity[0].guid
    $rootGuidStatus = [string]$rootGuidPinned
  }
  $rows = @()
  $badRows = 0
  foreach ($line in (Get-Content -LiteralPath (Join-Path $RunDir 'events.jsonl') -ErrorAction SilentlyContinue)) {
    if ($line) {
      try {
        $item = $line | ConvertFrom-Json -ErrorAction Stop
        if ([datetimeoffset]::Parse([string]$item.timeUtc).UtcDateTime -ge $reportStart) { $rows += $item }
      } catch { $badRows++ }
    }
  }
  $attempts = @($rows | Where-Object { $_.verdict -eq 'GRANTED' -or $_.verdict -eq 'BLOCKED' })
  $exits = @($rows | Where-Object { $_.kind -eq 'target-exit' })
  $unknown = @($rows | Where-Object { $_.kind -eq 'process-handle-request' -and $_.targetPid -eq 0 })
  try { $calibration = Read-Json (Join-Path $RunDir 'calibration.json') } catch { $calibration = $null; $badRows++ }
  $captureError = Test-Path (Join-Path $RunDir 'capture-error.txt')
  $captureWarnings = Test-Path (Join-Path $RunDir 'capture-warnings.log')
  $ended = Test-Path (Join-Path $RunDir 'ended.txt')
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('# Windows kill-attempt report')
  $lines.Add('')
  $lines.Add(('Capture: `{0}`; target: {1} PID {2}; start UTC: {3}.' -f $RunDir, $meta.mode, $meta.rootPid, $meta.startedUtc))
  $lines.Add(('Sysmon available at start: **{0}**. Security process requests without a target PID: **{1}**.' -f $meta.sysmon, $unknown.Count))
  if (Test-Path (Join-Path $RunDir 'stop-reason.txt')) { $lines.Add(('Stop reason: {0}.' -f ((Get-Content -LiteralPath (Join-Path $RunDir 'stop-reason.txt') -Raw).Trim()))) }
  $lines.Add(('Root target Sysmon GUID pinned: **{0}**.' -f $rootGuidStatus))
  if ($rootGuidStatus -eq 'False' -and $meta.sysmon) { $lines.Add('**IDENTITY GAP:** no Sysmon GUID was tied to the live root PID. Events seen only after its exit may be omitted to avoid PID-reuse misattribution.') }
  if ($captureError) { $lines.Add('**INCOMPLETE CAPTURE:** watcher failed. See `capture-error.txt`; do not use this run for conclusions.') }
  if (-not $ended) { $lines.Add('**INCOMPLETE CAPTURE:** no clean end marker. The watcher may still be running or may have stopped abruptly.') }
  if ($badRows -gt 0) { $lines.Add(('**INCOMPLETE CAPTURE:** {0} malformed event rows could not be read.' -f $badRows)) }
  if ($captureWarnings) { $lines.Add('**EVENT LOG QUERY WARNINGS:** see `capture-warnings.log`; some events may be missing.') }
  $lines.Add('')
  $lines.Add('| Source process | PID | Attempt | Target PID | Result | Evidence |')
  $lines.Add('|---|---:|---|---:|---|---|')
  foreach ($a in $attempts) {
    $after = @($exits | Where-Object { $_.targetPid -eq $a.targetPid -and [datetime]$_.timeUtc -ge [datetime]$a.timeUtc -and ([datetime]$_.timeUtc - [datetime]$a.timeUtc).TotalSeconds -le 10 })
    $result = [string]$a.verdict
    if ($result -eq 'GRANTED' -and $after.Count -gt 0) { $result = 'GRANTED; target exited within 10 s (causation unproven)' }
    elseif ($result -eq 'GRANTED' -and $a.aliveAtRead -eq $true) { $result = 'GRANTED; SURVIVED at log read' }
    elseif ($result -eq 'BLOCKED' -and $a.aliveAtRead -eq $true) { $result = 'BLOCKED; SURVIVED at log read' }
    $image = ([string]$a.sourceImage).Replace('|','\|')
    $lines.Add(('| `{0}` | {1} | {2} | {3} | {4} | {5} {6} |' -f $image, $a.sourcePid, $a.kind, $a.targetPid, $result, $a.channel, $a.recordId))
  }
  if ($attempts.Count -eq 0) { $lines.Add('| No attributable attempt recorded | | | | UNKNOWN | |') }
  $lines.Add('')
  $lines.Add(('Target exit events recorded: **{0}**.' -f $exits.Count))
  if ($calibration) {
    $lines.Add('')
    $lines.Add('## Scratch calibration')
    $lines.Add('')
    $lines.Add(('Medium Stop-Process: {0}; target alive afterward: {1}.' -f $calibration.mediumResult, $calibration.aliveAfterMedium))
    $lines.Add(('Elevated Stop-Process: {0}; target alive afterward: {1}.' -f $calibration.elevatedResult, $calibration.aliveAfterElevated))
    if ([string]$calibration.elevatedResult -match '^SUCCEEDED' -and $calibration.aliveAfterElevated -eq $false) { $lines.Add('Controlled elevated calibration verdict: **KILLED**.') }
    $deniedLogged = @($attempts | Where-Object { $_.verdict -eq 'BLOCKED' -and $_.targetPid -eq $calibration.targetPid }).Count -gt 0
    $killerPid = 0
    if ([string]$calibration.elevatedResult -match 'PID (\d+)') { $killerPid = [int]$Matches[1] }
    $grantedLogged = @($attempts | Where-Object { $_.verdict -eq 'GRANTED' -and $_.sourcePid -eq $killerPid -and $_.targetPid -eq $calibration.targetPid }).Count -gt 0
    $lines.Add(('Target-attributed denied audit event: **{0}**. Separate elevated killer Sysmon access: **{1}**.' -f $deniedLogged, $grantedLogged))
    if (-not $deniedLogged) { $lines.Add('**Denied-attempt logging is not verified on this machine. Other apps that are denied may leave no attributable event.**') }
  }
  $lines.Add('')
  $lines.Add('## Limits')
  $lines.Add('')
  $lines.Add('- Sysmon Event 10 records successful opens only. PROCESS_TERMINATE (0x1) means a handle could terminate; it does not prove TerminateProcess was called.')
  $lines.Add('- Security 4656 requires an auditing SACL on the target process. This setup only enables audit policy; calibration must prove denied attempts reach Security before absence can be interpreted.')
  $lines.Add('- Security process events without an exact target PID are kept as unattributed raw evidence. They cannot prove an attempt against this target.')
  $lines.Add('- Process exit after an open is temporal evidence, not proof of which process caused it. Graceful exit, job termination, and other paths can bypass this view.')
  $lines.Add('- Polling, event-log loss, PID reuse, a stopped Sysmon service, or an attacker with administrator rights may leave gaps. A missing entry is never proof of no attempt.')
  $lines.Add('- Evidence covers only the listed target PID and descendants discovered while the recorder ran. Run the scratch calibration before drawing conclusions.')
  $lines.Add('')
  $lines.Add('Raw rows: `events.jsonl`; merged timeline: `interactions.log`; target identities: `targets.json`.')
  [System.IO.File]::WriteAllLines((Join-Path $RunDir 'report.md'), $lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok ('Report: ' + (Join-Path $RunDir 'report.md'))
}

try {
  switch ($Command) {
    'Setup' { Invoke-Setup }
    'Start' { Invoke-Start }
    'Stop' {
      $active = Read-Json $ActiveFile
      if (-not $active) { throw 'No active capture.' }
      if ($Capture -and [System.IO.Path]::GetFullPath($Capture) -ne [System.IO.Path]::GetFullPath([string]$active.capture)) { throw 'The requested capture is not active; refusing to stop another watcher.' }
      New-Item -ItemType File -Path (Join-Path $active.capture 'stop.request') -Force | Out-Null
      Write-Ok ('Stop requested for ' + $active.capture)
    }
    'Status' {
      $active = Read-Json $ActiveFile
      if ($active) { Write-Ok ('Active: ' + $active.capture + ' (watcher PID ' + $active.watcherPid + ')') }
      else { Write-Warn 'No active capture.' }
      if (Test-IsAdmin) { Write-Host ('Sysmon Operational enabled: ' + (Get-SysmonReady)) }
      else { Write-Warn 'Run Status as Administrator to check Sysmon log access.' }
    }
    'Report' { Invoke-Report $Capture }
  }
} catch {
  Write-Fail $_.Exception.Message
  exit 1
}
