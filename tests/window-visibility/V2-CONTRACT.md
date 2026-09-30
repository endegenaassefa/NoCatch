# Active contract: persistent Windows root chat

This contract supersedes the root visibility-toggle behavior originally in `visibility.test.cjs`. The old root assertion that a later visibility shortcut should hide the toolbar is no longer an acceptance requirement. V1 is now preserved byte-for-byte as `historical-visibility-v1.cjs.txt`, outside Node test discovery. Its SHA256 is `4181CFF437AA0C55B946ACBF525C18203C7BF32201F97F639CA8852D93125A95`, matching the original red evidence. `v1-retirement.json` records the rename and both hashes; the original red output and metadata remain unchanged.

```powershell
node --test tests/window-visibility/root-persistent-v2.test.cjs
```

Discovery within this QA directory can also be checked by running `node --test` with `tests/window-visibility` as the working directory. It should discover only the 11 v2 checks.

After the production correction and v1 retirement, both commands passed 11/11 on 2026-09-26. `v2-green-result.txt`, `discovery-green-result.txt`, and `v2-green-evidence.json` preserve the outputs, command scope, and hashes. Discovery was verified for this QA directory; this is not a claim that every repository test was run.

## Required behavior

Windows root startup automatically displays toolbar and chat after onboarding is complete. Onboarding must still defer them until completion. Both Ctrl+Shift+V and Ctrl+Shift+C reveal chat, preserve an already-visible toolbar/chat, and never dismiss either through repeated or separate later callbacks. The deliberately selected Hide chat control can dismiss chat; it stays dismissed while idle and either shortcut can reveal it again. Ordinary Windows mode retains its previous toolbar-only startup and explicit visibility toggle.

## Independent red calibration

Run on 2026-09-26 with Node v22.23.3: exit 1, 11 checks, 8 pass and 3 fail. The failures are:

1. A separate root Ctrl+Shift+V callback after 1.2 seconds of quiet hides the toolbar/chat.
2. The first Ctrl+Shift+V callback on already-visible root chat hides it.
3. After deliberate Hide chat, Ctrl+Shift+V fails to reopen chat and instead hides the toolbar.

Startup, onboarding completion, repeating chat callbacks, separate Ctrl+Shift+C callbacks, intentional IPC dismissal/recovery, and ordinary mode pass. The sustained 30 ms visibility callback burst also passes before the separate-press assertion fails: debounce alone does not meet the new requirement.

`v2-red-result.txt` preserves TAP output. `v2-red-evidence.json` records source/test hashes before and after the command. This run changes only new files in `tests/window-visibility`; production source, installed files, and original QA assets are untouched.

## Test boundaries and limits

V2 carries forward the independently authored v1 harness so the historical test stays immutable. It executes the actual ApplicationController constructor, startup, registered Electron shortcuts, registered close-window/onboarding IPC, and full WindowManager against fake Electron outputs. Unrelated bootstrap services, setup persistence, providers, and trust validation remain fixtures.

Deliberate Hide chat is exercised at its existing `close-window` IPC boundary. Actual renderer clicks and native Electron global-key delivery are not simulated. Assertions attribute the failing action to the registered shortcut and its observed window state; no logging schema is imposed because current source has no established request-origin contract. No claim is made about the physical source of callbacks in the live practice run.

These checks do not prove Windows Z order, visibility over another application, packaged parity, or behavior inside LockDown Browser. No application or browser launches are part of this command. A source-class load boundary remains a harness maintenance dependency.
