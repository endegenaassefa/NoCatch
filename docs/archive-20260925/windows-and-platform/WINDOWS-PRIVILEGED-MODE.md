# Windows privileged-mode work: P18/P19

Status (2026-09-25): a local Windows elevated-mode prototype is built and running on this computer. It is not qualified for release or for use with LockDown Browser. The previously accepted ordinary Windows test build remains separate and unchanged.

## What the current prototype does

`scripts/cluely.ps1` offers `doctor`, `start`, `status`, and `stop`. Its `start` path asks Windows for Administrator consent, launches a separate packaged candidate, and waits for fresh application and elevated-mode boot log markers. The app checks its own Windows integrity level, uses a separate profile under `C:\ProgramData\CluelyRoot`, and pauses its recurring screen-capture availability check. The intended user flow is to start the app, open Chat with Ctrl+Shift+C, use text or the Ctrl+Shift+S screenshot action, and stop the elevated process afterward. Microphone and answer behavior in this elevated build have not been replayed end to end.

Independent QA checked the local candidate against `.depthengine/windows-privileged-20260925/ACCEPTANCE.md`. The unelevated `doctor`, ordinary non-root boot, elevated boot log and watcher guard, syntax checks, five integrity parser cases, and the two hashes of the preserved v10 build passed. Ctrl+Shift+C opened a visible Chat window. An isolated browser check of the packaged Chat page rendered its root banner when the preload reported root mode. The elevated app is still running; idle status, full stop and cleanup, repeat-stop behavior, and the live elevated renderer's banner contents have not been checked. All app windows enable screen content protection, so an operating-system screenshot cannot establish that banner's visibility. The local `INDEPENDENT-REVIEW.md` and `renderer-qa/RESULT.md` retain the evidence and limits.

The prototype has three material defects to resolve before any promotion:

1. The root profile currently inherits `BUILTIN\Users` Write permission, and the unsigned candidate under the user's Desktop is also writable by the ordinary account. An elevated Electron process must not load profile or program bytes that a lower-privilege process can change. Restrict and verify those trust boundaries, or use a narrower privileged helper design.
2. The launcher can identify a reused pidfile PID as its own when another matching process exists. Its fallback sweep also matches same-name processes with an unreadable command line. `stop` must prove exact process ownership before terminating anything.
3. The Chat banner gives the macOS shortcut on Windows and says LockDown Browser cannot kill the app. Windows uses Ctrl+Shift+S for capture, and survival against LockDown Browser has not been measured. Change the copy to report only verified behavior.

The new build is unsigned. The working `NoCatch Windows Test` desktop shortcut still selects the accepted v10 ordinary build, not this prototype.

## What the user expects

The Mac launcher ran the full application as root. The requested Windows outcome includes working chat/history, typing, microphone transcription, screenshot-to-answer, settings, mode status, and orderly start/stop/recovery. A surviving helper or a last-answer window alone does not meet this requirement.

The original [cross-platform plan](CROSS-PLATFORM-DESIGN.md) places P18/P19 in Stage 1 feasibility and Stage 3 implementation. They are required before full release, before payments, and should be investigated before broad native feature work. Stage 0 signing and Mac native qualification still have open gates.

## Current gap

`main.js` now checks the Windows process integrity SID and activates the existing root-mode guards for a High-integrity token. That verifies a local boot path, not the full product workflow or survival under another application. There is no Windows privileged helper with narrowly scoped authority.

Elevation, media permissions, desktop interaction, and process survival are separate properties. Windows Administrator status alone cannot establish all four. The current design calls for keeping the networked GUI at normal privilege and using narrowly authorized helper operations when evidence establishes a need. If this cannot preserve the full required workflow, P18/P19 stay blocked; they cannot be marked complete by substituting a weaker outcome.

## Remaining work, in order

1. **Secure program and profile paths, then the process lifecycle:** remove ordinary-user write access to bytes loaded by the elevated process. Make status and stop prove the exact executable and process identity, handle stale PIDs, and leave unrelated processes alone. Then verify idle status, stop, cleanup, restart and repeated commands.
2. **Replace the banner claim and verify it:** use the Windows shortcut in Windows copy and state only measured behavior. Check the rendered Chat UI directly because screen capture protection can omit it from screenshots.
3. **Decide the privilege boundary:** identify which real operation needs elevation and use explicit consent and narrow helper authority where possible. The current whole-app elevation is only a prototype; a networked renderer at High integrity increases the effect of a renderer or profile compromise.
4. **Replay the full workflow:** exercise chat, input, microphone, capture and settings before/after start, stop, restart, helper loss and conflicting modes. Record OS/build, application build, privilege, permissions, action and observed result. Qualify packaged Mac behavior separately.

A diagnostic or helper prototype is a milestone, not full privileged-mode parity. Any stronger survival claim needs a named interacting process/version and observed evidence.

## Verified environment and boundaries

The read-only native probe on 2026-09-24 reported Windows 11 Pro build 26200 x64, interactive Console session 1, with the probe unelevated. That earlier repair task ran no elevation or process-security experiment. The 2026-09-25 prototype subsequently ran an elevated app on this same host; LockDown Browser interaction remains unmeasured.

Microsoft documents [token information](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class), [process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights), [interactive services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and [named-pipe access controls](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights). These support implementation choices; they do not certify this app.

Research and exact source references: `C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-repairs-20260924/privilege/privilege.md`.
