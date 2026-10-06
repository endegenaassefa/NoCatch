# Branch guide

Use **`latest/attached-navbar-chat`** for current development. It is the default branch.

| Published branch | Original local reference | Purpose |
| --- | --- | --- |
| `latest/attached-navbar-chat` | `latest/attached-navbar-chat` | **Latest integrated version and default branch.** Attached navbar/chat and current answer/materials UI. |
| `archive/hybrid-materials-beta` | `feature/hybrid-beta` | Earlier integrated materials and Windows layout beta. |
| `archive/session-materials` | `feature/session-materials` | Initial session reference-material ingestion and management. |
| `archive/semantic-material-retrieval` | `feature/semantic-materials-retrieval` | Semantic retrieval for session materials. |
| `archive/material-ingestion-playground` | `feature/ingestion-playground` | Material ingestion playground and synthetic corpus. |
| `archive/clean-slate-exam-prototype` | `experiment/clean-slate-exam` | Earlier Windows Exam/session lifecycle prototype. |
| `archive/native-shield-integration` | `feature/cluely-shield` | Earlier native helper integration baseline. |
| `archive/windows-process-lifecycle-tests` | `test/root-kill-matrix` | Windows process lifecycle measurement and calibration work. |
| `archive/previous-public-shield-snapshot` | `refs/remotes/origin/feature/cluely-shield` | Cached original remote snapshot, retained for lineage. |

Archive branches are historical snapshots. Their presence does not mean every historical experiment is supported or verified. Uncommitted changes in other worktrees were not imported.

## Public history preparation

All branch ancestry is retained. Runtime databases, installed dependency copies, machine logs, captured diagnostics and local conversation handoffs were removed throughout the publication copy. The original local Git histories were not rewritten. Commit IDs therefore differ from the local originals. Source, build manifests, synthetic fixtures and license notices were retained. Personal home-directory prefixes in selected Markdown examples were replaced with generic placeholders.

Only these named branch refs are published; local backup refs and release tags are not pushed.
