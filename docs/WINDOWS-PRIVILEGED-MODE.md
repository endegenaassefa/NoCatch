# Windows privileged-mode work: P18/P19

Status: next Stage 1 milestone after the 2026-09-24 defect repairs and automated replay. Not implemented or qualified on Windows.

## What the user expects

The Mac launcher ran the full application as root. The requested Windows outcome includes working chat/history, typing, microphone transcription, screenshot-to-answer, settings, mode status, and orderly start/stop/recovery. A surviving helper or a last-answer window alone does not meet this requirement.

The original [cross-platform plan](CROSS-PLATFORM-DESIGN.md) places P18/P19 in Stage 1 feasibility and Stage 3 implementation. They are required before full release, before payments, and should be investigated before broad native feature work. Stage 0 signing and Mac native qualification still have open gates.

## Current gap

`main.js` detects Mac root through `process.getuid() === 0`. Windows does not expose that Unix identity check. Running the executable as Administrator therefore does not activate the existing root-mode guards or demonstrate equivalent behavior. No Windows privileged helper/lifecycle implementation is currently packaged.

Elevation, media permissions, desktop interaction, and process survival are separate properties. Windows Administrator status alone cannot establish all four. The current design calls for keeping the networked GUI at normal privilege and using narrowly authorized helper operations when evidence establishes a need. If this cannot preserve the full required workflow, P18/P19 stay blocked; they cannot be marked complete by substituting a weaker outcome.

## Next build, in order

1. **Status and doctor:** report the actual Windows process token/elevation, integrity level and session, GUI/helper state, versions and separate permission/operation health. A missing implementation must report unavailable, never a synthetic `root: true`.
2. **Owned application lifecycle prototype:** implement one instance, fresh readiness handshake, authenticated local IPC, exact owned-process tracking, graceful stop and bounded cleanup. Reject stale PID/log evidence and leave unrelated processes alone. Use a documented native process-group mechanism once compatibility with Electron is exercised.
3. **Required privileged operations:** identify which real operation needs elevation; implement its explicit consent/cancellation flow and narrow helper authority. Do not silently elevate the full app or treat consent cancellation as success.
4. **Full workflow scenarios:** automatically replay chat, input, microphone, capture and settings before/after start, stop, restart, helper loss and conflicting modes. Record OS/build, application build, privilege, permissions, action and observed result. Qualify packaged Mac behavior separately.

A diagnostic or helper prototype is a milestone, not full privileged-mode parity. Any stronger survival claim needs a named interacting process/version and observed evidence.

## Verified environment and boundaries

The read-only native probe on 2026-09-24 reported Windows 11 Pro build 26200 x64, interactive Console session 1, with the probe unelevated. No elevation, service installation or process-security experiment ran in this repair task.

Microsoft documents [token information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class), [process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights), [interactive services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and [named-pipe access controls](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights). These support implementation choices; they do not certify this app.

Research and exact source references: `C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-repairs-20260924/privilege/privilege.md`.
