# Local Windows package: session materials

Branch: `feature/semantic-materials-retrieval`.

## What retrieval does

Import extracts text and speaker notes, keeping the document and page/slide identity. PDF pages can be rendered and embedded PowerPoint images retained. Files are prepared before the 90-minute session starts.

Small collections that fit 48 pages and 64,000 serialized characters are sent whole. Larger collections are split into overlapping passages. The pinned, quantized `Xenova/e5-small-v2` model runs locally and converts passages into 384-number vectors representing meaning. SQLite FTS5 supplies exact-word matches. Every question runs both searches; reciprocal rank fusion combines their rankings. Selected original excerpts and nearby passages fit within the same bounded context budget.

The shared answer orchestrator supplies the evidence automatically. DeepSeek or Qwen receives the question, bounded conversation history, source excerpts and, when supported, selected source images. Source buttons use validated document/page identities. General reasoning is allowed and visibly distinguished when course evidence is unavailable. Citation identity checks cannot guarantee every claim is supported.

Without files, the answer takes the existing direct path. With files, the local index supplies fresh evidence for each question; the answer model does not permanently memorize the uploads. Image-only facts are not semantically indexed. PowerPoint shapes, full slide layout and SmartArt can be missing; PDF export gives better visual fidelity.

## Rebuild locally

Use native Windows Node from this checkout. Dependencies must include the Windows x64 optional packages for canvas, Sharp and ONNX. Install from the lockfile on Windows for a clean build.

Stage the pinned speech runtime using the existing project command:

```powershell
node scripts/stage-windows-speech.js <verified-runtime-directory>
npm run test:packaging
node scripts/build.js win --dir --config.directories.output=dist/session-materials
node scripts/build.js win nsis --prepackaged dist/session-materials/win-unpacked --config.directories.output=dist/session-materials
```

The build validates the speech manifest and the archive, including unpacked payload hashes and private-file exclusions. It always sets publishing to `never`. This local build is unsigned.

The complete app folder contains `screen-reader-util.exe`, `resources/app.asar`, native libraries and the speech runtime. Keep that folder intact; the EXE alone is not a portable single-file distribution.

## Qualification and local rollout

Qualification uses an isolated Windows profile and the complete packaged app. It must exercise actual packaged PDF rendering, semantic search in successive child processes, the rendered materials flow, end/clear and cleanup. A source checkout or a small test ASAR with external dependencies does not qualify the complete package.

The packaging evidence for this run is stored outside the repository under `Documents/NoCatch-session-materials-evidence-20260929/retrieval-v2/package-20261001`. The independent QA agent owns its acceptance checks. See the completion record below for the exact artifact, checks and launcher target once rollout is complete.

Existing settings and API keys belong in the user's profile and are never included in the package. Replacing application binaries must preserve those profiles. Retain the prior installed binaries until the new launch is verified; recovery restores the prior binaries and launcher target.

`scripts/install-local-windows.ps1` performs a local binary replacement. Its caller supplies the independently generated complete file manifest, expected EXE/ASAR hashes, and separate package/install/backup directories on one volume. Run it with `-WhatIf` first. It rejects modified or extra payloads, linked directories, an occupied backup and running app processes. It uses exact directory renames, retains the existing uninstaller without executing it, and attempts restoration on failure. The candidate folder is consumed by a successful installation. It does not access app profiles or establish the authenticity of a caller-supplied manifest.

The public pinned E5 weights are cached per profile. New machines may download them during preparation; failed model loading produces a visible keyword-search fallback. On this machine the public cache was seeded and hash-verified before rollout.

## Desktop launcher

`scripts/launch-local-windows.cjs` targets the installed EXE under `%LOCALAPPDATA%/Programs/screen-reader-util`. It uses the existing `NoCatch-Clean-Slate-Exam` profile by default. `--check` verifies dependencies without reading keys or launching. The optional `--model-dir` argument retains this machine's existing public Whisper model cache in manual recording mode.

The saved profile's provider and key take priority. A key from the normal app profile is an in-memory fallback only when its normalized endpoint matches; it is never copied into the package or written into the new profile. This prevents the former launcher from forcing DeepSeek after a user selects Qwen. The regular installed-app shortcut remains independent of this development checkout.

## Defects found during package qualification

- Reopening Materials after using Continue without materials left its preview handler permanently closed. Closing now invalidates pending requests; only unloading destroys the handler. Both successful and failed late replies are guarded by the request version.
- Windows PowerShell 5.1 treated a wrapped JSON manifest array as one entry. Independent installation tests caught the issue before any real binary replacement; manifest parsing was corrected.
- The real installation preflight exposed two Windows-specific issues: hidden AppData ancestors required `Get-Item -Force`, and a fresh PowerShell process suppressed `Get-FileHash` under `-WhatIf`. Read-only .NET hashing now verifies the complete payload during dry runs. Independent regressions reproduce both failures against the original code.
- Local deployment now checks every packaged file, including native DLLs and the speech runtime, and reports recovery paths if rollback fails.

Live DeepSeek calls in this packaging run repeatedly received no answer before their deadlines. A separate Windows request returned HTTP 200 and SSE keep-alive comments, and the older HTTPS client also timed out. This is consistent with DeepSeek's documented [request keep-alive mechanism](https://api-docs.deepseek.com/quick_start/rate_limit). It does not establish a service-wide outage. The packaged no-files UI stopped its spinner and showed an error after its 90-second deadline. Earlier successful source-level evaluations remain historical evidence; they do not turn these failed live attempts into passes.

## Completion record

The complete Windows application was built from runtime commit `ba24f29` and installed locally on October 1, 2026. The deployment helper verifies all 16,021 independently hashed package files before and after the directory swap. The regular installed-app shortcut targets the new binaries. The existing **NoCatch Clean Slate Exam** desktop shortcut now runs the versioned local wrapper through its existing VBS launcher.

| Artifact | Location / identity |
| --- | --- |
| Installed EXE | `C:\Users\your-user\AppData\Local\Programs\screen-reader-util\screen-reader-util.exe` |
| EXE SHA256 | `e7fc71f92ab925514a67c4abdc1fda72a8bb9396c60f90088f66ae2f6367777c` |
| Installed ASAR SHA256 | `33f9bb9f718a1a49fd131a56a3e5aa95ab2af682dcaf811ef6aaeaa5f2cec602` |
| Installer | `dist/session-materials/OpenCluely-Setup-1.0.0-x64.exe` (417,134,340 bytes) |
| Installer SHA256 | `16ccce02465e107b9ba4e40eb31d46743202cd5731e7ede9e92bc73194dfcef2` |

Independent checks passed for the complete archive, actual packaged PDF rendering, two consecutive E5 semantic-search processes, and the Windows EXE journey: skip materials, reopen, native file picker, import a 49-page PDF, prepare hybrid search, start the session, preview an original page, close/reopen, end/clear and quit. Cleanup confirmed no remaining synthetic material/session rows or owned processes. Additional checks covered launcher provider routing (10), deployment/rollback including calibrated Windows failures (8), and preview lifecycle handling (3 positive cases plus broken controls). Existing packaging regressions passed 33/33.

After installation, QA launched the actual existing Desktop shortcut. Native Windows UI Automation confirmed the visible **Session materials** window and its **Add files** and **Continue without materials** controls. The running installed EXE/ASAR hashes matched the qualified package. QA then opened Settings and invoked Quit; no installed app processes remained. This ordinary shortcut check used no debugging port, question submission or microphone action.

Both final packaged live-answer attempts timed out at 90 seconds; errors appeared and spinners cleared. Successful live answers, the 5–10 second response target, Qwen with a real key, and a six-person real-course beta remain unqualified. The NSIS installer was built but its fresh-machine installation UI was not exercised; this machine uses the verified local directory replacement.

All four existing `.env` and setup-state files had identical hashes before installation, after installation, and after the actual shortcut launch/quit. The normal and Clean Slate profiles remain separate. Public E5 cache files were added; original course files were not modified. Reproducible old build outputs were removed for space, with the deletion inventory retained in `space-cleanup.json` in the evidence directory.

### Recovery

Prior installed binaries remain at `C:\Users\your-user\AppData\Local\Programs\screen-reader-util.previous-materials-20261001`. Close every app process before recovery. Rename the current `screen-reader-util` directory to a new unused path, then rename that retained previous directory back to `screen-reader-util`. Do not run an uninstaller or delete the profile directories. Restore the original VBS from the evidence directory's `rollback/NoCatch-Clean-Slate-Exam.vbs` if returning the Clean Slate shortcut to its old build. The old Clean Slate build and original launcher CJS are retained.

The raw qualification record is `qa/results/qualification.json`; `install-whatif-v3.log` and `install-result.json` record the successful real preflight and installation. Earlier failed preflights and provider requests are preserved alongside them.
