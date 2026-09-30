# V4.1: a fresh loss after successful repair

This additive regression preserves frozen v4. The previous implementation remembered every topmost attempt for two seconds, including successful attempts. A fresh external topmost loss 100 ms after success therefore ignored delivered shortcuts and remained unrepaired beyond one second.

```powershell
node --test tests/window-visibility/topmost-v41.test.cjs
```

## Acceptance

- Starting with visible main/chat windows, a delivered Ctrl+Shift+V first repairs both successfully.
- If both lose topmost again 100 ms later, either Ctrl+Shift+V or Ctrl+Shift+C immediately repairs both without advancing observer time.
- In an independent case without a delivered shortcut, the existing observer repairs the fresh loss within one second.
- Each distinct successful recovery requires one native call per affected window, with no hide/show/focus.
- Native no-op and throwing failures still share a per-window retry cooldown of at least two seconds across observer and repeated shortcuts. Seventy alternating callbacks over 2.1 seconds must produce one initial attempt and one retry per window.

## Red calibration

On 2026-09-26, Node v22.23.3: **5 checks, 3 fail, 2 pass, exit 1**. The immediate V, immediate C, and one-second observer cases fail because the first success retains its cooldown. Both native-failure retry controls pass.

`v41-red-result.txt` preserves TAP output. `v41-red-evidence.json` records command, runtime, and source/test hashes before and after the run. Production and all previously frozen tests were left unchanged while authoring.

The test carries the real controller/WindowManager seam into a new file and injects loss or native refusal only at the fake Electron boundary. Virtual time makes 100 ms, one-second, and two-second requirements deterministic. It does not prove native Z order, actual browser coverage, or recovery while the real main-process event loop is blocked.
