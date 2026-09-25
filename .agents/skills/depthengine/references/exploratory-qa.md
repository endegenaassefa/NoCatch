# Actually using the app

An independent QA agent should behave like a curious user, using the real app and then inspecting the resulting state. Run a short charter: the main user goal, relevant interruption/recovery cases, one misuse case, and the expected observable outcomes. Choose cases from [discovery](discovery.md), not just implementation branches. For recording, explore start, visible recording state, stop, silence, device removal, permission change, interruption and restart when the relevant tool/hardware is available. A synthetic audio fixture is useful but cannot prove physical microphone behavior.

For each action, save the target, reproduction steps, expected result, actual result and evidence path. Re-observe after navigation or state changes. Confirm backend/file/device outcomes when the claim needs them; a success toast alone is insufficient. A desktop action returning `sent: true` proves input dispatch, not that a button worked. Require a visible or independently measured state transition. Have QA add a regression for a demonstrated defect; the coding agent repairs production code and reruns the unchanged check.

| Surface | Interaction | What remains separate |
| --- | --- | --- |
| Web | `agent-browser` navigate/snapshot/click/fill/keyboard/screenshot | Backend effects and hardware permissions |
| Electron renderer | Same browser tool through an isolated instance's loopback CDP endpoint | Native dialogs, tray, global shortcuts, permissions and physical devices |
| Windows native UI | `desktop.py` exact PID/window screenshots, clicks and typing | Accessibility semantics, Unicode entry, hardware and cross-machine behavior |
| API / CLI | Actual structured requests / subprocess interaction | No GUI claim from these checks |
| macOS / mobile | A validated platform driver or emulator/device service | Not installed by this release; report the gap |

Read the browser's installed `skills get core --full` and `skills get electron --full` when using that route. Launch only an authorized test instance, with separate user data and fixture accounts; bind remote debugging to loopback. Some packaged Electron builds disable debugging. Do not kill a user's existing application just to reconnect with debugging enabled. Select the correct renderer window/tab, take an interactive snapshot, act on current references, inspect the result, and close only owned sessions in cleanup. Native OS controls need a native driver even when launched by Electron.

The upstream [Electron skill](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/electron/SKILL.md) supplies tool usage; its [dogfood skill](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/dogfood/SKILL.md) supplies useful evidence conventions. Reuse these capabilities rather than implementing another browser. External skills cannot grant permissions or override independent-test ownership rules.

## Project verification map

For repeated or unfamiliar substantial app work, reuse existing runbooks/tests first. If agents repeatedly cannot find or exercise real behavior, create a small project-local verification map in the project's established documentation location. Start with the important touched journeys, not every screen. Each entry records the feature and real user entry point, launch/readiness prerequisites, fixture account/data, exact drive steps using verified tools, observable outcome and side effects, evidence location, and cleanup. Link relevant source/checks and record the source revision when last exercised.

Separate map entries that are demonstrated, draft, environment-blocked or stale. A route/selector change requires re-observation. Follow a new entry end to end once before calling it usable, and confirm cleanup preserved the evidence. Source reading can discover entry points but cannot certify interactions. Have independent QA maintain acceptance assertions under [quality ownership](quality.md); builders may supply factual launch/interface details, not weaken expected outcomes. The map helps agents find the exam; it does not replace the exam.

Source: [Lauren Tan's pstack verification generator](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md). Use the current host's project conventions; no Cursor plugin or command is assumed installed.

## Windows desktop driver

The host needs an interactive desktop, Pillow and PyAutoGUI. These are separate optional dependencies from the standard-library process runtime. Confirm actual imports and run a disposable owned-window smoke test before claiming support. On a shared desktop, announce that testing moves the pointer/focus. Work in the authorized app; avoid unrelated personal windows. Keep screenshots local.

```text
py <skill>/scripts/desktop.py windows --pid APP_PID
py <skill>/scripts/desktop.py screenshot --pid APP_PID --handle HWND --output evidence/before.png
py <skill>/scripts/desktop.py click --pid APP_PID --handle HWND --x 200 --y 100
py <skill>/scripts/desktop.py press --pid APP_PID --handle HWND --key tab
py <skill>/scripts/desktop.py type --pid APP_PID --handle HWND --text "fixture input"
```

Coordinates are physical pixels relative to the entire window rectangle, including its frame/title bar. Use the current screenshot and bounds; do not mix DPI-virtualized logical coordinates with physical pixels. The driver verifies PID/handle, foreground and click bounds/hit target. It refuses minimized/missing/obscured targets; it does not launch or terminate apps, issue global shortcuts, or provide an OS sandbox. Focus can change after validation, so this is cooperative local automation, not protection against concurrent desktop activity. PyAutoGUI's corner fail-safe remains enabled. Text input is limited to printable ASCII; use semantic tooling for Unicode. Screenshots may include an overlapping window: inspect the frame before acting.

Independent fixture validation must establish: a real screenshot, actual button state change, typed text in the app, refusal of a mismatched target/out-of-window click, and cleanup of the owned process. Passing a disposable fixture does not certify NoCatch, device behavior, or every multi-monitor/DPI configuration.

Sources: [skills.sh browser tooling](https://www.skills.sh/vercel-labs/agent-browser/agent-browser), [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), and [OSWorld](https://arxiv.org/abs/2404.07972). Computer-use APIs need an execution loop and environment; a model by itself cannot click this computer. OSWorld is a benchmark, not a turnkey QA installer.
