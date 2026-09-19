# Cluely Shield (root helper)

The **Cluely Shield** is a bare-Swift Mach-O helper that runs as root inside the
user's GUI session so that Respondus LockDown Browser (LDB) — which runs as the
unprivileged uid — cannot SIGKILL it during a proctored exam.

## Why it exists

During proctored exams, LockDown Browser runs a ~10-second kill loop that
SIGKILLs any non-allowlisted GUI app it can enumerate (see
[`docs/INCIDENT-2026-09-19-135148-LDB-SIGKILL.md`](../docs/INCIDENT-2026-09-19-135148-LDB-SIGKILL.md)).
Cluely's Electron main runs as the user's uid, so it is enumerable and killable.
The shield moves capture and the answer overlay into a root process that LDB
(uid 501) cannot signal.

## Status

**Day 1 — builds; gates G0/G1/G2 passed (2026-09-19); G3a kit verified locally, not yet run.**
The helper compiles and has a `--self-test`. The G0 platform smoke
(`scripts/cluely-shield-smoke.sh`) **passed 2026-09-19** — see
[`docs/G0-SMOKE-2026-09-19.md`](../docs/G0-SMOKE-2026-09-19.md). The G3a
go/no-go experiment kit (rig + canary + runbook) is at
[`docs/G3A-RUNBOOK.md`](../docs/G3A-RUNBOOK.md) — verified locally
(compiles on Swift 6.3; mock state-machine run end-to-end; expose probe and
canary live-tested; arm script dry-run) and adversarially reviewed, then
hardened (uid-501 canary spawn, Teams-agent gate, hotkey gate, quiz-live
anchor). It must still be **run against an LDB practice quiz** before any
Day 2–3 work. See
[`docs/SOLUTION-DESIGN.md`](../docs/SOLUTION-DESIGN.md) §6 for the full gate
list.

## Build

```bash
bash scripts/build-shield.sh
# equivalent to: swiftc -O shield/shield.swift -o shield/shield
```

The compiled binary `shield/shield` is gitignored — never commit it.

## Run

```bash
sudo -E ./shield/shield              # interactive: overlay + hotkey capture + socket IPC
sudo -E ./shield/shield --self-test  # one-shot capture -> luma verdict, exit 0/4
./shield/shield --answer-test IMG    # NON-root: fixture image -> DeepSeek -> print answer
./shield/shield --socket-test        # NON-root: socket IPC round-trip (30 s)
```

## Design contract (Day 1)

- `SCContentFilter` fetched **once** at startup (no per-capture enumeration).
- One overlay window created once; hotkey redraws its content in place.
- `RegisterEventHotKey` (⌘⇧Space, via Carbon) is the **primary** hotkey path —
  no TCC. `CGEventTap` is only the fallback (SecureEventInput can kill taps).
- `--self-test` captures once and prints a luma verdict (`PIXELS_OK` / `BLACK`).
- Frames never touch disk (LDB runs `cleanUpScreenShotsTimer`) — RAM only.

## Day 2 — answer pipeline, config, IPC (implemented)

- **Answer:** hotkey capture → JPEG in RAM → DeepSeek `/chat/completions`
  (`image_url` data URL, `thinking: disabled`, `max_tokens`) → overlay. Mirrors
  `src/services/deepseek.client.js` (the validated request shape).
- **Cached config/credentials:** JSON at `/var/root/.cluely-shield/config.json`
  (root-only 0600). Loaded at startup; rewritten by the socket `configure`
  command. The helper answers autonomously after the Brain quits.
- **Unix-socket IPC:** `/tmp/cluely-shield.sock`, newline-delimited JSON.
  Commands: `ping`, `configure`, `exam-mode`, `answer`, `quit`. The Brain
  (`src/services/shield-client.js`) pushes config and flips `examMode` on, then
  fully quits.
- **launchd:** `shield/com.cluely.shield.plist` + `scripts/install-shield-daemon.sh`
  (KeepAlive, auto-start, as root). See the plist's HONEST CAVEAT: the
  Terminal-sudo path is the proven one; daemon GUI-session access is unverified.

## Not yet done (Day 3 / gated)

- G3a/G3b go/no-go runs (operator + LDB practice/real exam) — the only thing
  that upgrades the design from conditional to shipped.
- A settings-pane on-screen control for exam mode (the ⌃⌥⇧E shortcut + IPC
  already work; a button is optional polish).

## Where the rest of the project lives

| Topic | Location |
|---|---|
| Design, threat model, verification gates | [`docs/SOLUTION-DESIGN.md`](../docs/SOLUTION-DESIGN.md) |
| Incident forensics (LDB SIGKILL) | [`docs/INCIDENT-*.md`](../docs/) |
| Platform smoke probe | [`research/probes/shield-smoke.swift`](../research/probes/shield-smoke.swift) |
| Smoke runner | [`scripts/cluely-shield-smoke.sh`](../scripts/cluely-shield-smoke.sh) |
| Recon / platform research | [`research/`](../research/) |
