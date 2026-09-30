# NoCatch: Windows testing and repair queue

The desktop **NoCatch Windows Test** shortcut uses the existing direct DeepSeek configuration, a separate local test profile, the bundled CPU speech runtime, and the cached `small` speech model. Recording starts only after a microphone action. No provider credential is included in the package.

## Automated verification

The 2026-09-24 repair task covers structured credential logging, microphone readiness/health, screenshot answer instructions, microphone progress/toggle behavior, and truthful shortcut availability. The expanded native replay checks actual shortcut effects, controlled screenshot answers from real DeepSeek, audio lifecycle ordering, settings persistence, failure/cancellation, restart and cleanup. Source tests alone do not establish these native outcomes.

Evidence and current completion status: `C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-repairs-20260924/REPORT.md`. Independent QA's repeatable automation instructions are in that directory's `qa/README.md`. Preserve previous trials and use a new result directory for each run. The user does not need to operate the test controls; desktop automation requires an interactive Windows session without concurrent app interaction.

The previous audit remains at `C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-parity-audit-20260924`. Its27/29 results and credential finding are historical baseline evidence. Its screenshot checks covered capture/preview, and native shortcut delivery did not establish every shortcut's effect. Use the repair report for the expanded checks and exact tested package.

Accepted local candidate: `.depthengine/repairs-20260924/package-v10/win-unpacked`. The **NoCatch Windows Test** desktop launcher selects this package. The frozen [six-stage acceptance run](../../../Documents/DepthEngine/evidence/nocatch-repairs-20260924/qa/acceptance-v3/run-20260924-224700/report.json) passed on this Windows host: native screenshot visibility 4/4, exact movement 9/9, shortcuts 18/18, two primary replays 53/53 each, and small speech 11/11. The package remains unsigned.

The complete native run is automated from WSL with the evidence directory's `qa/acceptance-v3/run.py --candidate <win-unpacked>` command. Each primary replay pauses at its `STRESS_STAGE_READY` gate until rapid checks have been announced and the marker is written. The runner requires an interactive Windows desktop and exclusive control of the app. See the [repair report](../../../Documents/DepthEngine/evidence/nocatch-repairs-20260924/REPORT.md) for exact hashes, commands, failed trials and scope.

Normal walkthroughs require visible, stable controls for at least two seconds, a controlled screenshot fixture visible before capture, and the completed DeepSeek answer followed by at least three seconds of reading time. Separate announced stress scenarios deliberately exercise fast cancellation and failures. Checks must observe the native window and final response, not merely successful key delivery or intermediate streaming text.

The dependency-only check below opens no app and reads no credentials. A passing result checks required files, not the provider key or application behavior.

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Users\your-user\Documents\DepthEngine\launchers\NoCatch-Windows-Test.cjs' --check
```

## User controls

- **Ctrl+Shift+C:** open Chat.
- **Ctrl+Shift+S:** capture a screenshot for analysis. Show only content intended for the configured provider.
- **Ctrl+Shift+R**, available **Alt+R**, or the microphone button: start/stop speech; a second action during startup cancels it.
- **Ctrl+,**: Settings.
- **Ctrl+Up / Ctrl+Down:** select the previous/next skill while interaction is on. With interaction off, **Ctrl+arrow keys** move the bound windows; Ctrl+Left/Right intentionally do nothing while interaction is on. **Ctrl+Shift+I** or **Alt+A** changes interaction mode.
- The shortcut menu shows registration failures and unsupported platform actions. Another instance or application can reserve a global chord; a configured chord alone is not proof that Windows registered it.

## What is next

Mac/Windows parity precedes payments:

1. **Windows privileged-mode feasibility/status/lifecycle (P18/P19)** is the next Stage1 platform milestone. See [Windows privileged-mode work](WINDOWS-PRIVILEGED-MODE.md) and the original [cross-platform plan](CROSS-PLATFORM-DESIGN.md). Windows Administrator status alone does not activate or qualify the existing Mac root-mode behavior. Implement missing capability and permission recovery after the feasibility decision.
2. Qualify ordinary feature journeys and clean installation on Windows and Mac: permission denial/regrant, model preparation, default/custom paths, restart and uninstall.
3. Deploy and qualify managed sign-in/AI and signed distribution.
4. Resolve paid-session duration, then implement server-enforced paid sessions/account restrictions and notes ingestion.

Physical microphone acquisition/release, generated-speech transcription, and human spoken-sentence accuracy are distinct evidence. Mac execution, native permission changes, clean-machine installation and actual Windows privileged-mode behavior remain unqualified in this repair task. This is an unsigned development build.
