# Full-main calibration v3

The frozen v2 journey incorrectly required a visible onboarding window on returning launches. Production correctly creates that window lazily. This version requires four baseline pages plus visible materials for returning launches, and retains onboarding plus materials for first-run launches. All parser, encrypted store and trusted IPC assertions remain unchanged. It also selects Azure with no credentials to avoid fallback Whisper discovery.

Run with Windows Node:

```powershell
node scripts/materials-qa/supplemental-v3/run-native.cjs --electron C:\path\to\electron.exe --phase returning
node scripts/materials-qa/supplemental-v3/run-native.cjs --electron C:\path\to\electron.exe --phase first-run --project C:\build\resources\app.asar
```

The top-level portable manifest and runner remain frozen; use this entrypoint for the calibrated full-main journey. Generate fixtures with the top-level runner first. Reports appear under this directory’s ignored results folder.
