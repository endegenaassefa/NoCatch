# Windows OpenCluely kill watcher

This is a Windows PowerShell 5.1 recorder for a live OpenCluely versus LockDown Browser test. It watches the machine's Sysmon and Security event logs, selects events involving the verified elevated OpenCluely PID and its discovered children, and writes a source-process table. No code is installed in LockDown Browser or in the user's test apps.

## Easiest way to run it on this PC

Double-click [run-live.cmd](run-live.cmd). Approve the two planned Windows administrator prompts. The script checks a disposable process, keeps the already-running elevated OpenCluely instance, starts the kill and visual-state recorders, and opens LockDown Browser. Use a **practice test**. If both recorders remain running, they stop after LockDown Browser closes and the report opens in Notepad. If OpenCluely is not running, its launcher may need one additional administrator prompt. Both recorders have a 45-minute limit.

**Observed on this PC, 2026-09-26:** LockDown Browser's practice-question page made the menu disappear to the user, while OpenCluely's root process remained alive. The first live PowerShell watcher also exited unexpectedly before it could write `report.md`; the process that ended that watcher is not identified. Sysmon's machine log persisted and the postmortem found 161 LockDown Browser opens of OpenCluely processes with no terminate permission. This does not settle denied kill attempts or explain the visual failure. After LockDown Browser closed, a native window sample found the 513x702 chat panel visible by style but not topmost, behind a Brave window. The app received its topmost shortcut, yet its own test still reported `chat.isAlwaysOnTop=false`; hiding and showing chat did not restore topmost. The new visual recorder logs window order and placement during the next practice run; if it exits early, its last sample marks the limit of the evidence. Do not treat an alive PID or an Electron `isVisible` flag as proof the menu appeared on screen.

The launcher leaves the real OpenCluely process running. It never performs the optional final elevated kill against OpenCluely. If a preparation step fails, it does not open LockDown Browser and prints the reason. LockDown Browser may close either PowerShell recorder during the live run, so automatic report opening is not guaranteed. From PowerShell, `run-live.ps1 -Check` checks paths, Sysmon, and the current root PID without starting the test or requesting elevation.

**What it can prove:** a Sysmon Event 10 from a named source PID to a target PID with `GrantedAccess` bit `0x1` proves that source obtained `PROCESS_TERMINATE` access when the target's process generation is pinned. A later target exit is recorded separately. The scratch calibration on this host observed a new elevated PowerShell PID open a scratch target with `0x1`, then the target exited. A direct unelevated `Stop-Process -Force` was denied and the target survived. The recorder received safety fixes after that run; repeat calibration before relying on a new live run.

**What it cannot currently prove:** the denied scratch attempt did not produce a target-attributed Security 4656 event on this host. Sysmon does not record failed opens. Therefore an empty row for LockDown Browser does **not** mean it never tried to kill OpenCluely. An open with `0x1` proves capability, not that the caller invoked `TerminateProcess`; an exit after an open is temporal evidence, not sole-source attribution. The report says this explicitly.

## One-time setup

The operator approved installing Microsoft Sysmon for this machine. It is installed and running as `Sysmon64` as of 2026-09-26. The setup command is idempotent and reapplies this test's configuration. It enables Success and Failure auditing for Process Creation, Process Termination, Kernel Object, and Handle Manipulation. It downloads Sysmon from Microsoft's Sysinternals URL if needed and requires a valid Microsoft Authenticode signature before installation. This changes machine-wide logging policy and Sysmon configuration; it does not uninstall or restore a previous configuration afterward.

From **Windows PowerShell as Administrator**:

```powershell
cd C:\Users\your-user\Desktop\NoCatch
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\kill-matrix\windows\watch.ps1 Setup
```

If Sysmon is declined, use `Setup -AuditOnly` instead. The final report then marks successful-open coverage unavailable. A one-time setup is enough; do not repeat it for each capture.

## Calibrate against a disposable process

Run once from a **normal, unelevated** Windows PowerShell. One UAC prompt starts an elevated built-in `ping.exe` scratch target and the watcher. The normal shell tries `Stop-Process -Force` and records the denial; a separate elevated PowerShell then kills the scratch target. This does not touch OpenCluely.

```powershell
cd C:\Users\your-user\Desktop\NoCatch
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\kill-matrix\windows\calibrate.ps1 Run
```

Read the path it prints. `report.md` should show the direct medium denial, target alive afterward, the elevated stop, a Sysmon Event 10 with `0x1` from the separate killer PID, and target exit events. It should also say whether a target-attributed denied Security 4656 appeared. On the 2026-09-26 calibration, that last check was **false**. Do not interpret silence about other blocked attempts as proof.

## Live LockDown Browser run

1. Start the real app elevated, then check its status:

   ```powershell
   .\scripts\cluely.ps1 start
   .\scripts\cluely.ps1 status
   ```

2. In an **Administrator Windows PowerShell**, start the watcher. Leave this window open. It creates a new `capture\<UTC timestamp>` directory and prints evidence as it arrives:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\kill-matrix\windows\watch.ps1 Start
   ```

3. Wait for `Target PID ... Sysmon GUID pinned` before launching LockDown Browser. If it never appears, the report will mark an identity gap. Then launch LockDown Browser and run the practice test or interaction you want to measure. Run the installed fake apps if desired. Record approximate wall-clock times and exact actions separately so they can be matched to the event timeline. Do not run an elevated kill against real OpenCluely unless you intend to end that instance.

4. In another Windows PowerShell, stop the capture:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\kill-matrix\windows\watch.ps1 Stop
   ```

5. The first watcher window writes `report.md` and closes. Read the newest report:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\kill-matrix\windows\watch.ps1 Report
   ```

   The report command prints the file path. Open that `report.md`. Look for a LockDown Browser executable path and PID, `GRANTED`, `accessMask` containing `0x1`, and a target exit. `events.jsonl` preserves the raw named event fields, including Sysmon `SourceProcessGuid` and `TargetProcessGuid`, for more precise follow-up. If no LockDown Browser row appears, the result is **unknown**, especially for denied access.

`Stop` only ends recording. It does not stop OpenCluely or LockDown Browser. The optional final elevated kill of the real OpenCluely instance is a separate destructive step and is intentionally absent from these commands.

## Commands and files

`watch.ps1` has `Setup`, `Start`, `Stop`, `Status`, and `Report`. `Start -TargetPid <PID>` selects an explicit scratch target; with no PID, it reads `%TEMP%\cluely-root.pid` and requires the same process-name plus WMI creation-tick ownership proof as `scripts\cluely.ps1`. `Start -DurationSeconds <n>` ends automatically. The watcher keeps discovered children in `targets.json`. It polls both event logs while active. A recorder exception creates `capture-error.txt` and marks the report incomplete.

Each capture directory contains:

| File | Purpose |
|---|---|
| `run.json`, `targets.json` | Start identity, capability state, and target PID generations |
| `events.jsonl` | Raw matching Sysmon/Security event data and normalized fields |
| `interactions.log` | Merged readable timeline of granted, blocked, and exit events |
| `report.md` | Source PID → access result, target exits, calibration state, limits |
| `calibration.json`, `medium-result.json` | Direct scratch results, only for a calibration run |
| `capture-error.txt` | Recorder failure; invalidates conclusions |
| `visual-state.jsonl` | Window process IDs, Z order, bounds, topmost and visibility styles, and DWM cloak state; no pixels, titles, or exam text |
| `visual-report.md` | Counts and examples of LockDown Browser windows above and covering OpenCluely windows |

The `capture` and `tools` directories are ignored by Git. Capture evidence can contain process command lines and local paths; keep it local unless you choose to share it.

`visual-watch.ps1 -Snapshot` prints a one-time window-state sample without starting LockDown Browser. To summarize a previous visual capture, run `visual-report.ps1 -Capture <capture-directory>`. A visible-style window can still be covered by another window, and geometric coverage is evidence of placement rather than proof of what the user saw. Match the timestamps to the moment the practice questions appeared and the user pressed a shortcut. The current run's app log recorded chat switching at 15:23:31 and 15:23:35 UTC, but that log's `isVisible` field is the manager's aggregate flag, not a screen-visibility measurement.

## Interpretation and limits

- `GRANTED` means Sysmon recorded a successful open with `PROCESS_TERMINATE`. It means that process **could** terminate the target with that handle. It is not proof of a kill call.
- `BLOCKED` requires a failed Security process-handle event with an exact target PID. The current host's calibration did not verify this channel, so the live run may show no blocked rows even when medium-integrity apps are denied.
- `SURVIVED at log read` is a liveness check against the recorded PID generation. A target may exit later. Target exit events and the final process state are separate evidence.
- Other kill paths include a previously opened or inherited handle, a job object, application self-exit, or a privileged service acting for another process. Event loss and delayed event delivery are possible. The recorder does not infer a caller from an exit alone.
- Sysmon's configuration logs process creation and termination for the machine and process access to `screen-reader-util.exe` and the `ping.exe` scratch target from **all source processes**. Filtering is by target image, never by attacker identity. The recorder pins Sysmon process GUIDs to live target generations where possible and omits ambiguous events. Windows Security event 4656 needs an applicable process-object SACL; enabling audit policy alone did not make the denied calibration visible here.

Sources: [Microsoft Sysmon event definitions](https://learn.microsoft.com/en-us/sysinternals/downloads/sysmon), [Sysmon configuration](https://learn.microsoft.com/en-us/windows/security/operating-system-security/sysmon/sysmon-configuration-files), [process rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights), [Security event 4656 requirements](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4656), [Electron BrowserWindow behavior](https://www.electronjs.org/docs/latest/api/browser-window), and [Windows IsWindowVisible behavior](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindowvisible).
