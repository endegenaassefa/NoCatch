# Attached navbar regression checks

Run with Node.js 18 or newer from any working directory:

```sh
node tests/attached-navbar/attached-navbar.cjs /path/to/NoCatch /path/to/fresh-evidence/core
node tests/attached-navbar/review-regressions.cjs /path/to/NoCatch /path/to/fresh-evidence/review
```

No dependency installation is required. Exit code 0 means all checks in that file passed (19 core checks and 3 supplemental checks); the evidence directory receives `boundary-results.json` with individual outcomes and SHA-256 hashes of the production modules executed. Use a separate output directory for each run.

The suite runs the complete production WindowManager and ExamLayout modules against controlled Electron window, display, shortcut and disk boundaries. It covers toolbar startup, Chat/global visibility, pointer policy, group movement, stale movement callbacks, display fitting, version-1 migration, geometry freeze, shortcut conflicts, normal geometry restoration, persistent chat ownership, voice acquisition hide intent, and delayed menu resize rejection. The supplemental suite covers hiding while the main renderer is still loading, retaining native rounding compensation across movement, and bounded menu geometry in an extreme 60-DIP work area.

Calibration: the pre-feature implementation passed existing chat persistence and normal geometry checks while failing intended attached-toolbar behaviors. A disposable variant with unconditional late voice reveal failed its focused regression while other checks passed. The menu resize race was reproduced before the revision-token fix and passed afterward. All three supplemental cases were independently reproduced before repair and passed afterward. QA source and historical evidence were retained externally.

These checks do not establish physical keyboard hold/release, Windows composition, native pointer behavior, actual monitor hotplug, real microphone/screenshot/provider behavior, or compatibility with other desktop software. Separate isolated browser and Windows verification is required for those claims. The suite never invokes an AI provider, captures a screen, or acquires a microphone.
