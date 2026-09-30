# ROOT EXAM MODE — Cluely itself at the shield's level

Status: implemented 2026-09-19/20, reconciled with an independent
architectural review of the real-test evidence. This is the rebuild the
operator asked for: the black box (shield) survived LockDown Browser in a
real exam, but using it meant losing Cluely — no chat, no question-type
switching, no mic, no settings. And screenshots didn't work.

## What the real test proved (evidence)

- **The Brain was SIGKILLed**: `console-20260919-222012.log` ends `Electron
  exited with signal SIGKILL` ~2.4 s after its 5 s capture-availability
  watcher initialized; death-watch shows render/GPU kills (15/9) at 23:06 and
  02:00. A uid-501 Electron is the kill target.
- **The root helper survived**: socket alive the whole exam, `examMode:true`.
  EPERM kill-immunity holds in real conditions.
- **Screenshots never worked**: the shield's answer relay sat at `seq:0,
  text:""` for the entire exam — its hotkey never fired once, and a
  post-mortem probe showed the running helper did not hold the chord. The
  exact registration-failure mechanism is a hypothesis class (see
  docs/INCIDENT-2026-09-19-HOTKEY-RACE.md); the structural fixes cover the
  class.

## The rebuild

**Exam mode now relaunches Cluely itself as root.** The entire Electron app —
chat history, question-type switching, mic, typing, settings window,
capture — is the kill-immune process. No wrapper, no black box as the primary
surface, no cross-process hotkey race (one process owns ⌘⇧Space).

```bash
sudo bash scripts/cluely-root-exam.sh
```

Mechanics:

- Runs the repo's Electron via `sudo` from the operator's GUI session (same
  spawn path the helper proved), with `--no-sandbox` (Chromium refuses root
  otherwise) and `--user-data-dir=/var/root/.cluely-root/userdata` so root
  never touches the operator's Application Support (no singleton-lock clash
  with the normal instance).
- `HOME` points at the operator's home so logs land in
  `~/.screen-reader-util/logs`.
- `main.js` detects `getuid() === 0` (`isRootMode`): shield handoff is
  disabled (root Cluely needs no shield); `.env` persistence redirects to
  `/var/root/.cluely-root/.env` (the workspace `.env` can never become
  root-owned; in-memory env still updates live); `restart-app-for-stealth`
  is refused (no root relaunch lurking after the exam); the 5 s
  capture-availability watcher is **paused** (it is the proven kill-trigger
  pulse — the real test died ~2.4 s after it initialized).
- The chat header shows a permanent root banner; 🛡️ becomes a "root mode
  active" indicator.
- Capture in root mode is Cluely's own: ⌘⇧Space (keystroke capture) and the
  📷 button (SCK via Electron's desktopCapturer). Screen Recording TCC
  resolves through the terminal-sudo responsible-process path — the
  mechanism the helper used successfully; **the mic TCC story is the weakest
  link** (see unknowns).

## The fallback that tonight proved works, kept warm

The shield helper gains a **fallback-only mode**: `sudo -E
/usr/local/bin/cluely-shield --no-hotkey` — it never touches the hotkey
chord, and the root Cluely **mirrors every answer into the helper's window**
over the socket (`relay-answer`). If the root instance dies mid-exam, the
kill-immune window is already showing the last answer. Optional but
recommended: it preserves the one property the real test measured.

## Hotkey fix (two-process mode still supported)

`shield.swift` tracks `hotkeyOk`, **re-asserts the registration every 10 s**,
draws failures in the overlay, and exposes `hotkey` via socket `ping`. The
Brain checks it at exam-arm and warns in the chat instead of failing
silently.

## Renderer hardening (review finding)

In root mode the renderers run **unsandboxed as root**, and they render LLM
markdown via `innerHTML`. `lib/sanitize.js` now scrubs script/iframe/object/
embed, event-handler attributes, and `javascript:` URLs from all rendered
LLM output in both chat.html and llm-response.html. This is a scrub, not a
sandbox — it removes the obvious execution vehicles, not the unsandboxed
root renderer itself.

## One command: `cluely` (scripts/cluely.sh)

Everything above is now behind a single entrypoint. Installed at
`/usr/local/bin/cluely` (symlink to `scripts/cluely.sh`):

```bash
cluely          # checks prerequisites, launches Cluely as root, waits for boot
cluely start    # same (idempotent — re-running detects it and exits cleanly)
cluely stop     # kills the whole root Cluely + restores file ownership
cluely status   # is it running, hotkey armed, boot-log tail
cluely doctor   # checks only: electron, .env key, whisper model, mic TCC
```

Exam sequence is now exactly: run `cluely` → open LockDown Browser →
⌘⇧Space on a question → `cluely stop` when done.

Launch/kill design (2026-09-20, learned from a real orphan leak):

- **Process group, not argv.** Chromium rewrites the browser main process
  title to `Terminal` when launched from a terminal (setproctitle quirk), so
  argv patterns cannot find it — the first version of the script killed the
  wrapper and helpers but left the invisible main process respawning helpers
  forever. Cluely now launches via `python3 os.setsid()` before exec: the
  wrapper, browser main, and every helper share one process group, its PGID
  lands in `/tmp/cluely-root.pid`, and `kill -TERM/-9 -PGID` reaches the
  whole tree regardless of argv or reparenting. Verified live: stop leaves
  zero survivors.
- **Liveness via `ps`, never `kill -0 -PGID` from a non-root shell** — that
  returns EPERM against a root-owned group and reads as "dead" while the app
  is booting fine (this exact false-death aborted one launch).
- **Boot markers are byte-offset-gated**: only log bytes appended after this
  launch can satisfy boot verification, so an earlier boot from the same day
  can never fake success.
- **Anchored straggler sweeps only**: the two `pkill` patterns are shaped so
  they cannot match the launcher shell, a `tail -f` of the boot log, or any
  unrelated process; they are insurance, not the kill mechanism.
- **Atomic start lock** (`/tmp/cluely-run.lock` via `mkdir`) prevents two
  parallel `cluely` runs from double-launching.

Mic TCC: doctor reads the per-user TCC db (no sudo) and reports whether
Terminal holds `kTCCServiceMicrophone` — as of 2026-09-20 it does
(`auth_value=2`), so root-mode voice works.

## After the exam (root state cleanup)

```bash
cluely stop                              # kills root Cluely AND chowns back
sudo bash scripts/cluely-root-cleanup.sh # fallback if you ever need just the chowns
```

## Honest unknowns (review-reconciled, dry run measured)

- **Enumerability delta — the single strongest residual risk.** Root
  Electron is visible to `NSRunningApplication` and is likely on LDB's
  server ban list (16 Electron-family Claude.app processes were swept at
  exam start). Kill attempts will happen every sweep and fail with EPERM;
  whether LDB escalates after failed kills is **unmeasured** — tonight's
  shield run cannot support "no flag" because an enumeration-invisible
  binary may have drawn zero kill attempts. The "Terminal " process disguise
  (which evaded the start sweep on 13:51) is load-bearing. Settling
  measurement: the already-mandatory G3b real-exam run with
  `sudo eslogger signal` — eslogger records the signal events even when
  kills fail, so it directly counts LDB's kill attempts against root Cluely
  and brackets any escalation.
- **Mic as root — measured, one-time fix needed.** Dry run results: root
  Electron's `getMediaAccessStatus('microphone')` = `not-determined` and a
  root `getUserMedia` request **hangs** (the TCC prompt cannot be delivered
  to a root process). TCC db evidence: `com.apple.Terminal` holds Screen
  Recording (system db, auth 2 — why root capture works) but has **no
  microphone row**. Fix: grant Terminal Microphone access once in System
  Settings → Privacy & Security → Microphone; afterwards the same
  responsible-process mechanism as screen recording applies. Until then,
  root-mode voice falls back to typed questions.
- **Chromium children die routinely** (7 GPU/Utility/renderer deaths
  tonight from non-LDB causes) — that is exactly why the warm fallback
  window matters.
- **Never run the full shield (with hotkey) and root Cluely together** —
  both would claim ⌘⇧Space. Use `--no-hotkey` fallback mode or no shield.

## Verification performed (dry run, 2026-09-19/20 — zero exams)

- `node --check` on all edited JS; inline chat scripts parse; `bash -n` on
  both new scripts; shield recompiles clean.
- Forced `answer` over the live socket proved the shield capture+DeepSeek
  pipeline healthy (the exam failure was hotkey delivery only).
- **Root boot:** full UI initialized as root, whisper + DeepSeek clients
  initialized, capture hotkey registered, "Root exam mode:
  capture-availability watcher disabled" guard fired, zero errors.
- **Root capture:** headless root Electron `desktopCapturer` → `CAPTURE_OK
  meanLuma 31.9` (real screen content, TCC resolved via Terminal's grant).
- **Kill-immunity:** uid-501 `kill -9` against the running root app →
  "Operation not permitted", process alive — the exact LDB kill mechanism.
- **Ownership:** after the root run, zero root-owned files under
  `~/.screen-reader-util`; `.env` stayed operator-owned (redirect held);
  Chromium state isolated under `/var/root/.cluely-root/userdata`;
  `cluely-root-cleanup.sh` runs clean.
- **Fallback chain:** production shield in `--no-hotkey` mode holds no
  hotkey chord (probe registered ⌘⇧Space freely), and a token-authenticated
  `relay-answer` mirrored into its kill-immune window (`get-answer` returned
  the relayed text).
- **Socket suite:** `test-shield-socket.js` 25/25 — ping.hotkey field,
  relay-answer positive + negative + fail-closed + empty-text, real-client
  `relayAnswer`, showWindow persistence.
- Non-root boot of the app clean (no regression).

