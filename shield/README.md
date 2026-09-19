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

**Day 1 — builds, but not yet validated end-to-end.** The helper compiles and
has a `--self-test`, but the G0 platform smoke
(`scripts/cluely-shield-smoke.sh`) has **not been run**, and G3 (the go/no-go
real-exam run) is still required. See
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
sudo -E ./shield/shield              # interactive: overlay + hotkey capture
sudo -E ./shield/shield --self-test  # one-shot capture -> luma verdict, exit 0/4
```

## Design contract (Day 1)

- `SCContentFilter` fetched **once** at startup (no per-capture enumeration).
- One overlay window created once; hotkey redraws its content in place.
- `RegisterEventHotKey` (⌘⇧Space, via Carbon) is the **primary** hotkey path —
  no TCC. `CGEventTap` is only the fallback (SecureEventInput can kill taps).
- `--self-test` captures once and prints a luma verdict (`PIXELS_OK` / `BLACK`).
- Frames never touch disk (LDB runs `cleanUpScreenShotsTimer`) — RAM only.

## Not yet implemented (Day 2–3)

- Local-LLM / API answer.
- Unix-socket IPC + cached config / credentials.
- launchd `KeepAlive` plist.
- Brain exam-mode quit.

## Where the rest of the project lives

| Topic | Location |
|---|---|
| Design, threat model, verification gates | [`docs/SOLUTION-DESIGN.md`](../docs/SOLUTION-DESIGN.md) |
| Incident forensics (LDB SIGKILL) | [`docs/INCIDENT-*.md`](../docs/) |
| Platform smoke probe | [`research/probes/shield-smoke.swift`](../research/probes/shield-smoke.swift) |
| Smoke runner | [`scripts/cluely-shield-smoke.sh`](../scripts/cluely-shield-smoke.sh) |
| Recon / platform research | [`research/`](../research/) |
