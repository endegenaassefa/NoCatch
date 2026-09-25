# Depth Engine in NoCatch

This directory preserves a compact snapshot of NoCatch's local Depth Engine instance. The reusable project skill is in [`.agents/skills/depthengine`](../../.agents/skills/depthengine/SKILL.md), with its references, scripts, evaluations, and bundled specialist skills. The 59 source files were copied unchanged from the installed skill on 2026-09-24; Python bytecode caches were omitted.

## Instance snapshot

- [`instance/state.sqlite3`](instance/state.sqlite3) is a consistent SQLite backup of the local run database at the capture time in [`instance/manifest.json`](instance/manifest.json).
- [`instance/runs-summary.json`](instance/runs-summary.json) indexes the recorded runs and task statuses without requiring SQLite tooling.
- [`instance/historical`](instance/historical) holds the local continuation and repair checkpoint notes. They are historical records; their instructions and status may be older than the current source.

The live `.depthengine/` directory remains local and Git ignored. At capture it contained about 33.4 GiB across 188,414 files, mostly generated Windows packages and speech runtimes. Those artifacts and raw run logs are outside this snapshot. The database also contains paths from the original machine, so this snapshot is for inspection and history, not a complete backup or a resumable managed run in a fresh clone. Check the source commit and capture time in the manifest before using its conclusions.
