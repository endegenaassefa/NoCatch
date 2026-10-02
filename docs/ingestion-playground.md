# Local ingestion playground

This opt-in Windows exam surface uses NoCatch’s existing native Materials window, encrypted session manager, local E5/FTS retrieval, screenshot service, and answer orchestrator. The synthetic Harbor Systems 241 course contains ten original eight-slide PPTX decks with speaker notes and a 24-page chapter PDF. The question set and independent answer key are separate assets; only the eleven course documents are exported for import.

## Launch

The separate local installation is `%LOCALAPPDATA%\Programs\screen-reader-util-playground\screen-reader-util.exe`. Run the existing launcher with `--playground`:

```text
node scripts/launch-local-windows.cjs --playground --check
node scripts/launch-local-windows.cjs --playground
```

`--check` checks local dependencies without reading credentials. The launcher uses the dedicated `%APPDATA%\NoCatch-Ingestion-Playground` profile and forwards `--ingestion-playground`. It can open the playground without a provider key; configure the provider in Settings before requesting a model answer. Keys are never embedded in playground assets. Normal launcher behavior is unchanged without the flag. Direct EXE launches may specify an absolute `--user-data-dir` only for the default dedicated path or an isolated QA directory whose leaf matches `NoCatch-Playground-QA-[A-Za-z0-9_-]+`; normal profiles and traversal are rejected. Elevated launches are rejected. Development playground launches do not fall back to the repository `.env`.

## Run the course

1. Choose **Export course folder**. The app verifies each document against the frozen manifest and creates a new uniquely named folder under Documents. The folder contains only PPTX/PDF originals and is shown on the setup screen. These originals persist after the session.
2. Choose **Open Materials**, add all eleven files with the native picker, wait for preparation, confirm the materials consent, and start its session. The existing Materials window reports page/document errors and preparation progress. Setup also shows the actual preparation strategy and fallback state.
3. Choose **Restriction** or **Diagnostic**, choose the context, confirm the scope, and **Start exam**. A run with materials inherits that session’s exact deadline. A run without materials requires all draft/active files to be cleared first and receives a single 90-minute deadline.
4. Navigate numbered questions and type your own answers. Answers are saved only in the current run. **Finish and review** or **Exit** cancels in-flight work; Exit requires a reason. **End and clear** removes imported session copies and conversation memory and wipes screenshots, answers, and traces.

Restriction mode requests native full-screen and capture protection, disallows minimize, and prevents assessment clipboard, print, context-menu and browser navigation actions. Leaving focus hides questions and requires acknowledgment; elapsed time keeps running. NoCatch requests are blocked in this mode. Actual capture exclusion must be measured with the target Windows capture route; a restriction result is never a grounded-answer success.

Diagnostic mode permits capture and NoCatch interaction. **Capture question** sends a validated crop of the actual displayed question panel through the normal screenshot answer flow. The common screenshot entry point requires the one-use native authorization from this button; ordinary screenshot hotkeys direct you to Capture question. It freezes question navigation during the request; Finish or Exit cancels it. Large collections may require a paid transcription call followed by a paid answer call. Provider failures appear on screen. **Inspect retrieval (free)** asks the actual local manager to retrieve evidence for the question text without sending a screenshot or calling a model. It is labeled as text retrieval and does not prove screenshot reading or answer correctness.

## Review and retention

Review displays your answer, the captured question when retained, actual transcription, selected source excerpts and coordinates, returned citations, strategy/status, stage timing, and provider errors. Use **Open source** for the existing MaterialsManager source preview. Compare factual correctness, coordinate correctness, and excerpt support separately; the UI does not assign an unvalidated automatic grade.

The independent expected answer and rubric are read only after finishing or exiting. They never enter the answer pipeline, chat history, or course export. Review is capture-protected and model requests are blocked. Starting another run requires End and clear. The renderer removes review content before main re-enables diagnostic capture.

Instrumentation is active only with the playground flag. It retains at most 24 request records, 80 observable events, and 16 MiB of base64 screenshot data in memory. Oversized screenshots are explicitly omitted from review. No image bytes or API keys enter the stage trace. Evidence and imported copies are cleared at their original deadline, on material invalidation, or End and clear. Finishing/exiting keeps review available only until that original deadline. Application restart ends the exam run; existing materials can recover with their original deadline. No trace export is offered.

The on-screen **Emergency exit** remains available in the header and every modal, including focus acknowledgment, exit confirmation, close confirmation, and source preview. `Ctrl+Shift+Alt+Escape` is registered when available, with its actual registration status displayed on setup. Emergency recovery cancels work, clears the exam and imported materials, leaves full-screen, and opens Materials. Windows recovery controls remain available. Normal application quit is never trapped by the exam close confirmation.

## Scope and verification

This is a local computer-only simulator, not Respondus detection parity or OS task-switch prevention. It does not inspect/terminate third-party processes, modify registry/network settings, record webcam footage, or claim to observe all screenshot attempts. The event log records only events this window actually receives.

The independent frozen core suite covers session deadlines, mode/focus/exit ownership, immutable question state, instrumentation isolation, cancellation, and observer failure. Native Windows interaction, actual capture exclusion, provider behavior, packaging, and visual inspection require separate measured QA. Source checks alone do not establish those results.

## Measured local results — 2026-10-01

The final Windows EXE passed 25 independently authored production regressions. Actual native import processed all 11 course files: 104 pages/slides and 119 hybrid-search passages. All 12 question/source-coordinate checks passed; five GUI retrieval-only checks took 15–32 ms with the index already prepared.

Two actual screenshot answers were measured on the installed EXE using DeepSeek Flash. The same Q05 was used, with End and clear and a fresh run between paths:

| Context | First answer text | Complete answer | Independent assessment |
| --- | ---: | ---: | --- |
| 10 decks + chapter | 3.623 s | 5.589 s | All four course facts correct; both required slide coordinates cited; all four returned citations matched supporting retrieved excerpts. |
| No files | 1.166 s | 3.007 s | General duplicate-prevention advice; missing the explicit new attempt identifier and six-hour rule; ambiguous identifier terminology and additional unsupported course assumptions. |

These times start at the answer orchestrator, after screenshot capture. They are one observation per path, not percentile latency estimates or an overall accuracy benchmark. In the materials run, screenshot transcription took about 1.26 s and local retrieval took 25 ms. The live test retained the actual complete question image and source excerpts; the answer key never entered model inputs.

Windows interaction also exercised focus acknowledgment, exit reasons, clipboard/print/reload blocking, emergency clearing, source preview at wide/narrow sizes, and reopening after emergency. Capture from the tested Windows route excluded the protected exam/focus dialog; this does not establish every screenshot route or active-question capture exclusion. A full 90-minute wall-clock UI run, 1,000-page workload, and broad diagram-answer accuracy remain untested.

Actual interaction exposed and repaired three UI problems: source controls below a long preview, reopening a hidden exam, and screenshot geometry shifting when an error disappeared or a scrollbar appeared. Source previews now scroll above persistent actions; reopening preserves session state; capture measures after clearing errors and reserves scrollbar space. Fresh first capture and error retry were exercised in the final EXE.

The local delivery is a separate EXE directory and **NoCatch Ingestion Playground** Desktop shortcut. Disk-limited packaging reused verified speech-runtime files through Windows read-only hard links. Those bytes are shared with the build staging copies; the read-only attribute prevents ordinary writes but is removable. This local directory build is not a new distributable NSIS installer. The ordinary build remains `npm run build:win`.

Run the portable regressions from the repository with:

```text
node --test scripts/test-ingestion-playground.cjs scripts/test-playground-profile-emergency.cjs scripts/test-playground-capture-authorization.cjs scripts/test-playground-reveal.cjs scripts/test-playground-renderer-capture-retry.cjs
```

The full local evidence, independent grades, artifact hashes and deployment receipts are under `Documents/NoCatch-session-materials-evidence-20260929/retrieval-v2/playground-build-20261001`.
