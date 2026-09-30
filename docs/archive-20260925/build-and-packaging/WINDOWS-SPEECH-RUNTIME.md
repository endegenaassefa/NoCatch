# Windows speech runtime

Windows x64 packages include a private CPython 3.13.2 runtime, CPU PyTorch and Whisper dependencies under `resources/speech-runtime/windows-x64`. Customers do not run pip or activate a virtual environment. The selected model is separate from this runtime; the default remains `small`.

Build inputs are pinned by URL, version and SHA-256 in `resources/speech-runtime/payload.lock.json`. The reviewed output inventory is `resources/speech-runtime/payload.manifest.json`; its exact digest is pinned in `src/core/whisper-runtime-manifest.json`. The builder checks every regenerated file against that inventory. Packaging checks every byte before and after copying the runtime outside ASAR. Application startup checks the pinned manifest and critical interpreter/package files; it does not hash every large tensor DLL synchronously.

## Build locally on Windows

Use a build environment with Windows x64 CPython 3.13.2, pip 25.3 and setuptools 78.1.0. These requirements are enforced before building. Run from the project root:

```powershell
py -3.13 scripts/build-windows-speech.py
node scripts/build.js win --x64
```

The builder downloads verified upstream archives into `.depthengine/speech-runtime-downloads` and writes `.depthengine/speech-runtime/windows-x64`. It refuses to overwrite an existing output and requires at least 3 GiB of free space before staging. Packaging needs additional space for the unpacked app and installers. No model is included in this payload.

An already verified build payload can instead be staged with:

```powershell
node scripts/stage-windows-speech.js C:\path\to\windows-x64
```

Staging validates the reviewed inventory, copies into a temporary directory, checks the copy, then replaces the previous staged runtime. A failed copy or verification retains the previous runtime. Runtime updates require an intentional reviewed lock, expected inventory and digest update; changing only the payload manifest cannot satisfy the package gate.

## Selection and isolation

Packaged Windows treats an empty command or the shipped `whisper` default as the included runtime. A deliberate non-default command or `WHISPER_PYTHON` selects the existing custom-runtime path. Source development and other operating systems retain their existing behavior. Runtime locations are recalculated from `process.resourcesPath` on each launch, including portable launches.

The embedded `python313._pth` restricts Python imports to the bundled ZIP/root/site-packages. The child environment removes inherited Python configuration and sets no-user-site, no-bytecode and UTF-8 options. Actual native QA checks module provenance and post-run inventory; this is not an operating-system sandbox. The included CPU worker does not fall back to the filename CLI, which would otherwise need ffmpeg. Explicit custom runtimes retain their previous fallback behavior.

The inventory retains upstream license and notice files, including app-local Microsoft C++ runtime files. An optional Numba TBB backend is not supplied; the supported speech path does not select it. This local engineering artifact has not been cleared for customer distribution or signed.

## Prepare a voice model

In Settings, choose Local Whisper, leave the command at `whisper`, choose Auto or CPU, and click **Prepare model**. The default `small` download is 483,617,219 bytes (about 461.2 MiB). Preparation checks the official size and SHA-256, then actually loads the model with the included CPU engine before marking it ready. Downloaded bytes remain in a temporary file until validation succeeds. CUDA requires a custom runtime.

Settings shows progress and supports Cancel and Retry. Closing Settings leaves preparation running; reopening observes the same operation. Quitting cancels preparation and waits for its worker to exit. The recording service also waits for its owned speech children before application exit. A file-cleanup failure reports an error and the next attempt retries cleanup before downloading again.

On later launches, the app checks an existing checkpoint without downloading it. An unprepared model leaves the microphone unavailable; starting a recording does not silently download a model. A changed cached checkpoint is verified again. Custom runtimes retain their existing setup behavior.

## Current qualification boundary

Evidence is recorded under `Documents/DepthEngine/evidence/nocatch-bundled-speech-20260924`. Native Windows evidence includes official default-small preparation, CPU warmup, cached validation with the download API blocked, synthetic WAV transcription, and confirmed child exit. This does not establish physical microphone behavior or clean-machine installation. Empty PATH on the developer computer is useful isolation evidence but does not establish a clean Windows VM result. Deep installation paths also need installer qualification after a relocated QA copy exposed Windows path-length limits.
