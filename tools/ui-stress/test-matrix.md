# Cluely root-exam-mode UI stress matrix (flaky-UI cases)

Every case: drive it → record timestamped screenshots/video → correlate with the
runtime log (`%USERPROFILE%\.screen-reader-util\logs\application-<date>.log`).
A case FAILS only when the expected log marker is missing or a forbidden marker
appears. Symptom without a log marker = new hypothesis, not a verdict.

## Log markers (grep these)
| Marker | Meaning |
|---|---|
| `Root visibility topmost guard blocked demotion` | guard rolled back a strip (1st + every 30 s) |
| `Root visibility topmost repair` | POLL had to repair (guard missed — bad, should be rare/absent) |
| `Root visibility shortcut` | a toggle chord actually reached the app |
| `Root visibility toggle verify mismatch` | toggle result didn't match intent (auto-forced; FAIL) |
| `Root visibility window destroyed externally; recreating` | HWND kill detected |
| `Root visibility window recreated` | recreation succeeded |
| `Global shortcut unavailable` / `Global shortcut recovered` | chord stolen/recovered |
| Snapshot `"alwaysOnTop": false` with `visible: true` | demoted and poll caught it before repair |

## Harness (tools/ui-stress)
- `probe-sync-guard.js` + `attack-topmost.ps1` — zero-frame guard validation
  (90 attacks, 22075 tight samples, PASS 2026-09-27).
- `soak-topmost.ps1` — exam-scale soak. Run 2026-09-27 (70 min): 9,816
  attacks @ 20 Hz compressed (≈ 2.7 exam-hours at LDB's real 1 Hz) + 8,418
  realistic attacks (1 Hz + random 33 Hz bursts), 1,239,098 samples,
  VERDICT=PASS (0 demoted observations). Victim guard answered 18,233/18,234
  attacks (one nested no-op; attacker-side ground truth still 0 demoted).
- Live-app attack: get hwnd from a snapshot line (`"hwnd": "1107fc"`), then
  from an **elevated** PowerShell:
  `attack-topmost.ps1 -HwndOverride <hex> -SingleRounds 30 -BurstRounds 20`
- Chat-kill simulation: `attack-topmost.ps1 -HwndOverride <chat-hex> -DestroyOnly`
  (must be elevated; this is the observed real-world kill path).

## Cases
| ID | Scenario | Drive | Expected / Evidence |
|---|---|---|---|
| F-01 | Flicker under strip bursts | Sit in practice test 3 min watching menu | Zero visible dips; log shows `blocked demotion` and NO `topmost repair`; video reviewed frame-wise |
| F-02 | Hide → quick re-summon (the reported bug) | Press toggle (hide), screenshot, press again within ~200 ms | Menu returns EVERY press; `Root visibility shortcut` ×2; no verify mismatch |
| F-03 | Held-key auto-repeat storm | Hold Ctrl+Shift+V 3 s | Contract: at most ONE hide→show blink (the OS's first auto-repeat at +500 ms is indistinguishable from a human press without native key-state), final state MUST be visible-on-top and stable — no flapping. Known residual: a 3 s hold ends visible. A native GetAsyncKeyState repeat detector would remove the blink; that is a future hardening, not a blocker |
| F-04 | Chat HWND destroyed by exam | Destroy chat hwnd (harness) mid-exam, then press toggle | Within one press (or ≤30 s poll) chat window is back; `destroyed externally; recreating` + `window recreated` |
| F-05 | Main HWND destroyed | Same, on main hwnd | Toolbar back via toggle; same markers |
| F-06 | Primary chord swallowed | Press Ctrl+Shift+V during a phase where LDB eats keys; if nothing logged, press Ctrl+Shift+Alt+V | Backup chord toggles; log shows backup accelerator |
| F-07 | Toggle intent never diverges | After EVERY toggle press, watch 600 ms | `toggle verify mismatch` must never appear |
| F-08 | Buried-but-visible summon | Strip live window (harness), then press toggle | Menu jumps to top; no hide; `blocked demotion` present |
| F-09 | Clicks during strip war | Run harness attack loop; click every menu control | Every first click lands; no dropped clicks |
| F-10 | Cold start inside exam | Start app while exam fullscreen | Main + chat visible/topmost ≤5 s; snapshot initial shows both topmost |
| F-11 | LDB self-raises (alternative flicker mechanism) | Correlate: any visible flicker where log shows NEITHER `blocked demotion` NOR `alwaysOnTop:false` | If seen → flicker is z-order (LDB raises itself), not style-strip → new countermeasure needed (topmost-band re-assert). If never seen → current mechanism explanation holds |
| F-12 | Screenshot workflow | Screenshot while menu visible; check whether menu appears in capture | If visible in capture → `WDA_EXCLUDEFROMCAPTURE` candidate feature (so user never needs to hide the menu) |
| F-13 | Backup chord doesn't collide | In a normal (non-exam) app, press Ctrl+Shift+Alt+V | Nothing happens outside root mode (handler only active in root mode) |
| F-14 | Exam next-question transitions | Watch menu across 10 question changes | No dips at transitions; guard counters increment per strip |

## Decision rules for the driving agent
1. Any symptom MUST be tied to a log marker before a fix is proposed.
2. `topmost repair` occurrences after guard install = regression (guard missed a strip).
3. Flicker with zero `blocked demotion` and zero demoted snapshots = F-11 (z-order fight), not style-strip.
4. Toggle press with no `Root visibility shortcut` line = chord never reached the app (OS-level swallow).
