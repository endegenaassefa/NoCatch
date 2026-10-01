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

## Defects found during package qualification

- Reopening Materials after using Continue without materials left its preview handler permanently closed. Closing now invalidates pending requests; only unloading destroys the handler. Both successful and failed late replies are guarded by the request version.
- Windows PowerShell 5.1 treated a wrapped JSON manifest array as one entry. Independent installation tests caught the issue before any real binary replacement; manifest parsing was corrected.
- Local deployment now checks every packaged file, including native DLLs and the speech runtime, and reports recovery paths if rollback fails.

Live DeepSeek calls in this packaging run repeatedly received no answer before their deadlines. A separate Windows request returned HTTP 200 and SSE keep-alive comments, and the older HTTPS client also timed out. This is consistent with DeepSeek's documented [request keep-alive mechanism](https://api-docs.deepseek.com/quick_start/rate_limit). It does not establish a service-wide outage. The packaged no-files UI stopped its spinner and showed an error after its 90-second deadline. Earlier successful source-level evaluations remain historical evidence; they do not turn these failed live attempts into passes.

## Completion record

Packaging and actual-EXE qualification are in progress. No installed-launcher completion claim is made yet.
