# Session materials acceptance checks

These tests were independently authored and frozen before implementation. `SOURCE-HASHES.json` records byte-identical copies; `original-manifests/` preserves their original hashes. Production code is exercised through the public manager, shared context, HTTP server, provider-routing, actual main/controller methods, and real Electron renderers. External providers are fixtures; no live account or API spending is required.

From the repository root, with Node 24 or newer:

```sh
python3 -m pip install python-pptx reportlab Pillow
node scripts/materials-qa/run.cjs fixtures
node scripts/materials-qa/run.cjs hashes
node scripts/materials-qa/run.cjs test
node scripts/materials-qa/run.cjs regression
```

The generator creates 18 small PPTX/PDF and malformed fixtures. Generated fixture hashes are checked against `expected-fixtures.json`. If library versions produce different bytes, review the differences rather than replacing expected hashes automatically. Fixtures, temporary files, sparse size-limit files, and results are ignored by Git. Test commands store their output and exit status under `results/`.

`test` runs 103 material and integration cases. `regression` runs the seven inherited regression suites. The tests include actual PPTX relationship order, notes, tables, image gaps, PDF pages, consent, exact deadlines, encrypted recovery, cancellation, account switching, prompt/context budgets, transient managed output, and SQLite restart behavior.

## Native Windows journeys

Run with Windows Node and a standalone Electron 44 binary. Use the Electron development executable, not an installed application executable. Each harness creates its own disposable profile under its `results/` directory.

```powershell
node scripts/materials-qa/run.cjs native-materials --electron C:\path\to\electron.exe
node scripts/materials-qa/run.cjs native-chat --electron C:\path\to\electron.exe
node scripts/materials-qa/run.cjs native-main --electron C:\path\to\electron.exe --phase first-run
node scripts/materials-qa/run.cjs native-main --electron C:\path\to\electron.exe --phase returning
```

The materials journey uses the real page, preload, manager, workers, and OS safeStorage; file-picker selection is deterministic. The chat journey drives the real renderer with IPC events and checks localStorage under a delayed startup-status race, Markdown rendering, source output, and invalidation. Chat v3 calibrates visible Markdown text while preserving raw and normalized storage secrecy assertions.

The full-main journey loads production `main.js` and exercises its actual trusted IPC handlers. Its bootstrap redirects app paths, Node home/temp APIs, cwd, and writes to QA results; strips credentials; disables network, real screen capture, and global shortcut registration; never starts recording; and replaces OS privilege detection before production code can access an elevated live profile. It does not establish elevated behavior, actual file-picker UI, or provider correctness. Disposable profiles are retained for inspection.

## Packaged material runtime

```powershell
node scripts/materials-qa/run.cjs archive C:\build\resources\app.asar
node scripts/materials-qa/run.cjs native-main --electron C:\path\to\electron.exe --project C:\build\resources\app.asar --phase first-run
```

Archive checks require the materials UI, parser worker, PDF runtime/worker, parser packages, and unpacked Windows native canvas payload. Running full-main against the archive checks actual archive worker/dependency resolution. This does not establish normal packaged-executable startup, installer behavior, signing, or release readiness.
