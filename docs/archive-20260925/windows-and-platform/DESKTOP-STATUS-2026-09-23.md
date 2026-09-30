# Mac and Windows desktop status — 2026-09-23

Current Windows test instructions: [Windows testing](WINDOWS-TESTING.md). The included CPU speech runtime and model preparation were completed after the earlier repairs below; see [Windows speech runtime](WINDOWS-SPEECH-RUNTIME.md). Historical references below to unfinished self-contained Windows speech are superseded by that implementation.

Direct website downloads are the intended distribution. Keep the shared Electron app, qualify Windows x64 first and test Mac on the user's Mac later. No App Store listing is required. This is an internal development build, not a customer-ready release.

## Changes in this repair

- Chat and screenshot requests own their timers, capture status, stream and errors. Fast replies stop thinking indicators; current failures are visible and retryable; capture cannot erase an unrelated typed stream; failures from cleared requests cannot erase newer replies.
- Local speech honors the selected runtime and explicit device during fallback. Timeout, cancellation/reconfiguration and transport failures keep ownership until confirmed process exit. Audio files survive live readers and worker-to-CLI fallback, with cleanup on late close.
- Existing dirty changes and historical tests were preserved. A separately authored worker test replaces an incorrect fake-process assumption that kill acknowledgement equals confirmed exit.

## Qualification

Independent QA owns 69 checks: 23 speech/runtime/lifecycle gates, 30 packaged Windows core gates, and 16 overlap gates. Real Electron main/preload/renderers are exercised with synthetic audio and controlled capture/provider boundaries. Final results and source identity are in the local evidence folder listed below; a test plan or static review is not a passing result.

Run the normal unsigned build on Windows with `node scripts/build.js win --x64 --config.directories.output=.depthengine/core-evidence/package`. Publishing is disabled by the build script. Mac packaging requires a Mac or the configured macOS CI job.

Remaining: physical microphone/transcription quality, live managed login/models, self-contained local speech installation, and Mac Intel/Apple Silicon qualification. Local Whisper currently requires a suitable Python/Whisper installation. The follow-up repair prevents recording warmup from overlapping a cancelled CLI awaiting close; 27 independent speech gates passed. Concurrent recognizeFromFile also allows overlap but has no repository callers. These limitations prevent a customer-readiness or universal process-exclusion claim.

## Windows-first follow-up

The user confirmed $70 for one fixed-duration session, with duration still undecided, and no passing/sharing accounts. This replaces the earlier proposed transfer policy. Windows core features take priority over payment/account restrictions. Device binding and a single server-controlled active session are proposed future enforcement; they are not implemented or a guarantee of human identity.

Native Windows testing exercised Ctrl+Shift+C to open Chat, typed input/Enter with a live DeepSeek answer, Ctrl+, to open Settings, and Ctrl+Shift+S capturing a controlled desktop document with a correct live image answer. A real Windows Whisper worker also transcribed generated speech; this is separate from a physical microphone test. The development direct-key path is not a paid entitlement boundary.

The follow-up also checks generation ownership before a queued recording stop touches shared capture, preventing a cancelled stop from interrupting a replacement session. All 29 speech gates passed, including timeout recovery without extra cancellation. Direct-mode DeepSeek screenshots now work in setup as well as Chat; the managed-service image restrictions are unchanged. All 10 setup gates passed, and the real Windows setup preview/consent/answer flow returned the correct live answer.

The full Windows microphone-button → Chromium synthetic audio device → real Whisper → transcript → Chat path passed. This uses generated speech, not a physical microphone. The isolated speech environment uses this machine's existing Python dependencies and does not prove a self-contained customer installation.

Follow-up evidence, exact source versions and completion status live in `C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-windows-core-20260923-followup`. Speech repair run: `2f0bdade33364f0ab30b745dcb6574f2`; setup repair run: `1208bf5e8d08460984159333b103366f`; final package qualification run: `5ecadb5d061c404e93bd6b965f493f43`. Read its canonical status for the final package result. Test profiles and provider credentials must not be distributed.

## Later product stages

1. Qualify all four ordinary desktop features on both OSes.
2. Qualify one server-backed AI/login path; keep operator API keys off the device.
3. Choose the fixed session duration, then add server-enforced $70 sessions, idempotent activation and cost caps. Duration and pause/recovery policy remain undecided.
4. Add bounded note ingestion: parse/index once, retrieve relevant excerpts with citations, separate OCR and resource limits.
5. Sign and qualify direct-download installers, then run a small paid pilot.

Installed Electron code is inspectable. Keep proprietary service logic on the server and reconcile existing license metadata before distribution. Notes ingestion, paid passes, checkout and a public download site were not implemented here.

## Local handoff

The next scoped Windows repair is `ced295ab69164cda88cae87e45387a78`, with evidence at `C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-windows-next-20260923`. It preserves a requested idle model release when warmup outlasts the idle timer, without unloading a restarted capture. Setup checks operation ownership after preview, answer, Sample and input-mode progress saves; stale save errors cannot overwrite cancellation, and a Discard save failure remains visible. Independent QA owns 54 lifecycle/setup gates, the preserved 69 packaged Windows gates, and eight rendered setup checks. Read that run's canonical status and completion report for final results. The interim run `4a37b2a839d8432d84c765cf4dd0a83d` was canceled before execution to adopt independently reproduced adjacent cases without changing frozen tests.

Clean Windows voice installation is still unfinished. The installation audit recommends a private complete Python runtime with pinned CPU dependencies, selected-model preparation in Settings, and explicit cancellation/retry ownership. No runtime payload or customer provisioning UI was added in this scoped repair. `install-discovery.md` records the source gaps, official references, and clean-machine acceptance criteria. Physical microphone qualification remains separate from synthetic input tests.

Planning/research: C:/Users/your-user/Documents/DepthEngine/plans/NoCatch-2026-09-23.md, NoCatch-models-notes-2026-09-23.md, NoCatch-native-test-handoff.md.

Evidence, frozen independent QA, isolated reviews, checkpoint and runtime continuation: C:/Users/your-user/Documents/DepthEngine/evidence/nocatch-core-20260923. Do not publish this internal evidence folder or runtime authentication context. Final scoped run: 8e6a3aabd1ed47f6ad8332763454ded5. Historical runs were not resumed or replenished.
