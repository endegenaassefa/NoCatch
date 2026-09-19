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

**Day 1–3 built; gates G0/G1/G2 passed (2026-09-19); G3a practice-quiz run
completed (2026-09-19) — root immunity + capture held, but the practice quiz
did NOT exercise LDB's kill-loop, so the definitive go/no-go remains a real-exam
(G3b) question.** The helper compiles and has a `--self-test`. The G0 platform
smoke (`scripts/cluely-shield-smoke.sh`) **passed 2026-09-19** — see
[`docs/G0-SMOKE-2026-09-19.md`](../docs/G0-SMOKE-2026-09-19.md). The G3a
go/no-go kit (rig + canary + runbook) is at
[`docs/G3A-RUNBOOK.md`](../docs/G3A-RUNBOOK.md). See
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
./shield/shield --socket-test        # NON-root: stand up the socket (drive it externally)
node scripts/test-shield-socket.js   # NON-root: automated socket test incl. token-auth negative control
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
  fully quits. The socket is world-writable (0666) so the uid-501 Brain can
  connect; mutating commands require a shared-secret token (root-only in the
  config, echoed from `CLUELY_SHIELD_TOKEN`) — `ping` is the only unauthenticated
  command.
- **Install:** `scripts/install-shield.sh` (build + `/usr/local/bin/cluely-shield`
  + shared-token seed). No launchd daemon — a LaunchDaemon can't reach the Aqua
  GUI session (proven 2026-09-19). Start the helper in a terminal:
  `sudo -E /usr/local/bin/cluely-shield`.

## Not yet done (gated)

- G3b — the real-exam go/no-go run (operator + instructor flag confirmation):
  the only thing that upgrades the design from conditional to shipped. The G3a
  practice-quiz run showed root immunity + capture held but did NOT exercise
  LDB's kill-loop (the practice quiz killed nothing, including Chrome), so the
  definitive kill-loop behavior is unmeasured until a real exam.
- A local vision model for the zero-network answer path (design §8 open item).

## Where the rest of the project lives

| Topic | Location |
|---|---|
| Design, threat model, verification gates | [`docs/SOLUTION-DESIGN.md`](../docs/SOLUTION-DESIGN.md) |
| Incident forensics (LDB SIGKILL) | [`docs/INCIDENT-*.md`](../docs/) |
| Platform smoke probe | [`research/probes/shield-smoke.swift`](../research/probes/shield-smoke.swift) |
| Smoke runner | [`scripts/cluely-shield-smoke.sh`](../scripts/cluely-shield-smoke.sh) |
| Recon / platform research | [`research/`](../research/) |
