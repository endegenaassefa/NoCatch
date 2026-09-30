# Cross-platform design review

Scope update: the user subsequently required every existing feature on both operating systems before release. The earlier suggestion to exclude incompatible features is not adopted. The current proposal is [CROSS-PLATFORM-DESIGN.md](CROSS-PLATFORM-DESIGN.md); missing or unproven required capabilities block release rather than being silently deferred. Findings below remain the historical independent review of the earlier proposal.

Reviewer: fresh Codex process using the Depth Engine isolated reviewer controls.

Only a neutral task, acceptance criteria, proposed design artifact and selected raw repository files were supplied. No conversation history, compaction, saved memory, previous review or author rationale was supplied. The process was ephemeral, with user configuration, project instructions, memory, host skills and tools disabled. Reviewer completion and absence of tool activity were checked. These are CLI isolation controls, not a separate operating-system security boundary; provider/system context is not fully inspectable.

Scope: design and source review. No packaged builds, backend calls or runtime tests were executed by the reviewer.

## Independent reviewer findings

## Overall assessment

The design is directionally compatible with the application, but **not yet an actionable release plan**. It correctly distinguishes proposals from tested behavior. The supplied implementation contradicts several desired outcomes; no execution evidence establishes that the proposed replacements work.

## Material findings and corrections

1. **“Core experience” is undefined and conflicts with existing advertising.**  
   The README advertises screen-share invisibility, focusless input and root-based exam operation. Keystroke capture explicitly returns `false` outside macOS; calling `setContentProtection(true)` does not establish invisibility across capture applications. Standard-user operation cannot simply inherit the README’s root-mode promise.  
   **Correction:** Define the supported feature matrix and explicitly retire or exclude incompatible promises. Validate shortcuts, focus, full-screen/workspace behavior and capture protection separately per OS.  
   **Evidence:** [README.md], [main.js lines 245-305], [src/managers/window.manager.js lines 620-675].

2. **Implementation sequencing puts the proof before its prerequisites.**  
   Step 1 demands clean-machine sign-in, voice and AI response, while step 2 introduces the managed backend and packaged dependencies needed to achieve that. Deferring the Electron upgrade also risks redoing platform validation.  
   **Correction:** First decide supported targets and upgrade feasibility; then build a minimal packaged vertical slice with authentication, managed AI and hosted transcription. Run clean-machine acceptance against that slice before broad adapter extraction.  
   **Evidence:** [Proposed design artifact], [package.json], [src/core/whisper-installer.js lines 235-360].

3. **Managed service architecture remains materially underspecified.**  
   Existing onboarding checks provider keys, not user sessions. No backend implementation or service output is supplied. “Authentication” and “provider failure handling” leave session expiry/revocation, interrupted streams, retry charging, quotas and service outages undecided. Hosted audio also conflicts with the current macOS permission description promising local transcription.  
   **Correction:** Specify desktop/backend contracts, authentication recovery, session-storage failure behavior, request deduplication, upload limits, retention/deletion and matching consent language. Replace provider-key onboarding rather than merely adding sign-in.  
   **Evidence:** [src/core/first-run.js], [package.json], [Proposed design artifact].

4. **Recovery promises lack a concrete state model.**  
   A completion sentinel and key-presence check cannot represent independently recoverable permissions, authentication and downloads. The installer reports failures but directs users to install Python or manually delete a broken environment. Persisting permission completion would also become stale after OS-level revocation.  
   **Correction:** Specify per-feature states, capability rechecks, skip/retry actions, settings-return/relaunch handling, offline and expired-session recovery, and download integrity, cancellation, disk-space and partial-install cleanup. Keep chat/screenshots usable after microphone denial.  
   **Evidence:** [src/core/first-run.js], [src/core/whisper-installer.js lines 235-360], [onboarding.js lines 350-402].

5. **The existing shared capture path has concrete correctness and privacy counterexamples.**  
   Equal-resolution displays can select the wrong source because matching uses dimensions, not display identity. Capture defaults to the left half; a crop failure falls back to the full image, potentially exposing content outside the requested region if subsequently uploaded.  
   **Correction:** Match display identity, define coordinate/scaling semantics, validate bounds and fail closed on requested-region failure. Test identical monitors, mixed DPI, rotation and disconnected displays; make the selected region visible to users.  
   **Evidence:** [src/services/capture.service.js].

6. **Release configuration does not deliver the proposed distribution.**  
   CI has no macOS job, disables signing discovery and contains no supplied runtime test gate. Windows signing is disabled; macOS hardened runtime is disabled. The configured Windows installer name is `screen-reader-util-Setup-…`, but release selection requires `OpenCluely-Setup-…`, so those installers would be omitted. Windows architecture variants also share an installer filename, creating a collision risk. Update metadata is deliberately discarded.  
   **Correction:** Align artifact names and architecture suffixes, require every expected artifact, add macOS builds and signing/notarization verification, and choose an updater with its required published metadata and recovery policy.  
   **Evidence:** [package.json], [.github/workflows/release.yml].

7. **Support and settings preservation need explicit migration decisions.**  
   Packaging lists macOS x64/arm64 and Windows x64/ia32, but the proposal never commits to minimum OS versions or CPU support. Helper architecture compatibility is unproven. Although userData persistence is partly implemented, `resolveEnvPath()` can prefer a working-directory `.env` even in packaged operation; the comment’s development-only intent is not enforced. Renaming the product also needs a stable storage identity or migration.  
   **Correction:** Fix the support matrix, bundle compatible helpers and runtimes, restrict project configuration discovery to development, and specify settings/schema/credential migration. Gate releases on standard-user installation, prior-version upgrades, interrupted updates and settings preservation.  
   **Evidence:** [package.json], [main.js lines 1-62], [main.js lines 190-213], [main.js lines 245-305].

## Criteria disposition

| Criterion | Assessment |
|---|---|
| Same core experience, minimal setup | **Refuted for supplied implementation; unproven for proposal.** macOS-only input and developer dependency setup remain. |
| Sign-in and product-provided AI | **Refuted for existing onboarding; unproven for proposal.** Provider keys remain required; no backend evidence supplied. |
| Architecture fits existing application | **Supported in direction, incomplete in detail.** Shared capture and renderer microphone paths provide reuse opportunities; platform contracts need definition. |
| Recoverable onboarding | **Unproven.** Error reporting exists, but end-to-end recovery is not demonstrated. |
| Validated distribution, upgrades and preservation | **Unproven, with concrete release defects.** Installer configuration is not validation evidence. |
| Distinguish design from implementation/testing | **Supported.** The proposal explicitly disclaims packaged cross-platform implementation or test results. |

**Limitations:** Assessment uses only the supplied excerpts. No tests were executed, no evidence authenticity was verified, and omitted backend, helper, permission or updater code cannot be assumed either present or absent.

## Disposition after source verification

The reviewer identified material omissions; the initial design is not a release-ready specification. Keep the shared Electron architecture, with these corrections:

1. Define an explicit supported OS/CPU and feature matrix before promising parity. The current macOS-only input helper and documented root workflow are not evidence of equivalent standard-user Windows behavior. Existing feature promises require explicit decisions and platform verification.
2. Correct implementation order: decide runtime/platform targets and prove upgrade feasibility; implement a minimal packaged authentication + managed AI + hosted speech path; then test that path on clean machines before broader extraction and polishing. Establish signing and identity early enough to exercise real permission behavior.
3. Replace provider-key readiness checks with independent session and capability states. Specify expiry, revocation, offline recovery, request deduplication, quota handling, upload bounds and retention/deletion. Change the current microphone permission text before enabling cloud transcription; it currently promises local Whisper processing.
4. Recheck permissions at use and after OS changes. Persist onboarding progress without treating historical permission grants as current truth. Add specific retry/skip/resume paths and integrity verification for optional local models.
5. Correct capture selection using display identity and explicit coordinate/scaling rules. Reject invalid regions and crop failures instead of allowing unintended full-screen output. Source inspection confirms the existing dimension-based match and full-image fallback; no runtime reproduction was performed.
6. Correct release artifact names and architecture suffixes, fail on missing expected artifacts, add macOS jobs, verify signing/notarization and preserve required updater artifacts. Source inspection confirms that the configured Windows installer name does not match the release filter and that update metadata is omitted.
7. Specify settings and credential migrations with stable application/storage identity. Restrict working-directory configuration discovery to development; the current resolver has no packaged/development guard.

Revised acceptance: every advertised feature works on each supported packaged OS/CPU target under a standard user account, without developer tools. Validate first response, microphone denial/regrant, session expiry, network interruption, monitor identity/scaling, interrupted optional downloads, prior-version upgrades and preserved settings. These are required checks, not completed test results.

No application implementation was changed as part of this review.

## Full-parity design review

A fresh Codex process reviewed the full-parity design and raw source excerpts. No conversation, saved memory or prior review was supplied. The same ephemeral, instruction-disabled, tool-disabled controls were applied; completion without tool activity was verified. This was artifact review, not a runtime test.

## Assessment

The proposal largely satisfies the **design intent**, but is not yet a complete execution specification. It explicitly rejects reduced-feature releases and appropriately leaves difficult platform behavior release-blocking.

### Material findings

1. **Advanced-mode feasibility needs a sharper observable requirement.**  
   P18 requires defining root mode’s outcome, but Stage 1 has no explicit threat/compatibility matrix for deciding success. Preserving launcher commands is different from keeping chat, microphone, capture and settings operational when another application terminates ordinary processes. The source describes elevating the entire app; the proposal forbids that architecture without yet establishing an equivalent outcome. This is an **acknowledged unresolved blocker**, not proof of contradiction or impossibility.  
   **Evidence:** `docs/CROSS-PLATFORM-DESIGN.md`, P18 and feasibility gates; `README.md`; `docs/ROOT-EXAM-MODE.md lines 1-60`.

2. **Managed-service recovery contracts remain materially incomplete.**  
   The answer API specifies replay and idempotency well, but live speech lacks a transport/authentication contract, acknowledgement/backpressure rules, reconnect semantics and session termination rules. Cancellation also needs terminal-state precedence when completion races cancellation. Session revocation specifies stopping *new* requests, leaving active streams and account-switch delivery unspecified. These omissions can cause duplicate transcripts or delivery into the wrong active session. Specify these before Stage 2 integration.  
   **Evidence:** `docs/CROSS-PLATFORM-DESIGN.md`, managed API table, request recovery rules and setup/recovery table.

3. **The inventory does not yet establish complete settings parity.**  
   Appendix A lists surfaces but explicitly defers their mapping. For example, `whisperCommand` is an existing editable setting with no explicit disposition under the private-runtime architecture. “Compatible advanced BYOK” also leaves compatibility undefined, particularly for Azure speech credentials/region versus managed speech. Define which observable behaviors remain and which implementation-specific controls are replaced; listing a control is not a preservation decision.  
   **Evidence:** `docs/CROSS-PLATFORM-DESIGN.md`, P08/P20 and Appendix A; `main.js lines 2587-2621`.

4. **Packaging prerequisites should be explicit stage dependencies.**  
   Stage 1 requires packaged baseline evidence and signed identity; Stage 2 requires packaged, developer-tool-free round trips. However, the stage table does not explicitly schedule the prerequisite CI, signing/notarization and helper-resource work described elsewhere. Existing packaging cannot simply be assumed adequate: Mac CI is absent, signing is disabled, and helper fallback invokes a compiler. Put minimum packaging infrastructure before those validation exits—not solely under later distribution qualification.  
   **Evidence:** `docs/CROSS-PLATFORM-DESIGN.md`, build section and stages; `package.json`; `.github/workflows/release.yml lines 17-38` and `86-107`; `main.js lines 245-305`.

### Criteria disposition

| Criterion | Disposition |
|---|---|
| Full feature scope before release | **Supported as a requirement**; inventory completeness remains unproven. |
| Managed sign-in, minimal setup, no developer tools | **Supported by the proposed design**, not demonstrated implementation. |
| Preserve transcription, providers/settings and advanced modes | **Partially supported**; settings dispositions and advanced outcomes remain unresolved. |
| Honest platform limits and blockers | **Supported.** Universal capture invisibility is **refuted** by the supplied official excerpts, and the proposal correctly acknowledges this. |
| Coherent architecture, recovery, migration and sequencing | **Partially supported**, with the contract and dependency gaps above. |
| Separate observations, proposals and unperformed tests | **Supported.** The document does not claim packaged qualification occurred. |

**Limitations:** Only supplied excerpts were assessed. Referenced source files and historical logs were not supplied in full; no test execution or evidence-authenticity verification was possible. Existing source defects that the proposal expressly addresses are not, by themselves, defects in this proposed design.

### Corrections incorporated after review

- Added an observable advanced-mode workflow and versioned scenario matrix. Continued full-interface operation is distinct from a surviving fallback window. Native feasibility remains unresolved.
- Specified live speech authentication, sequencing, acknowledgement, bounded buffering, interruption/reconnect, terminal events and transcript deduplication. Added cancellation/completion precedence, session revocation and account-switch boundaries.
- Mapped all 18 existing form controls to explicit preservation contracts, including custom Whisper commands and Azure direct credentials/region. Managed sign-in remains the default.
- Added Stage 0 for target/runtime selection, signed installers, CI, artifact naming and architecture-correct bundled helpers before packaged acceptance tests.

These edits address design omissions. They do not establish actual OS compatibility, service availability or complete release qualification.

## Stage 0 packaging implementation review

A fresh Codex process reviewed the packaging files and raw command-output excerpts without inherited conversation, saved memory, user configuration, host skills or previous reviews. Tools were disabled and completion without tool activity was verified. This was a static evidence-packet review, not independent execution or an OS security boundary.

The reviewer found the following gaps. Corrections were checked against source and targeted tests:

- **Update coverage:** Metadata could omit an architecture's update archive or reference another platform's valid payload. Validation now requires every configured architecture's update format and rejects foreign-platform and duplicate entries. Tests exercise missing arm64 ZIP metadata, a Windows entry in Mac metadata and duplicate entries.
- **Credential isolation:** The reviewer questioned whether the empty profile `.env` blocked working-directory fallback. Inspection of `main.js:resolveEnvPath` shows it prefers an existing userData `.env`; the debugger sets that path before main executes. The comment now describes the actual mechanism, environment removal handles case differences and the smoke test asserts credentials remain absent after config loads. The production resolver's broader migration behavior remains future work.
- **Renderer correctness:** Load completion alone missed ordinary renderer exceptions and wrong page paths. The smoke now observes uncaught renderer exceptions and asserts all five exact packaged page paths, as well as their preload bridges. This is startup coverage, not full interaction testing.
- **Unpacked resources:** ASAR listings alone did not prove unpacked payloads existed. The after-pack check now verifies every unpacked file's size and SHA-256 integrity. A real temporary ASAR test rejects same-size corruption and deletion. The existing project license is explicitly included. Known private-file patterns are excluded; arbitrary content in allowed source directories is not claimed to be secret-scanned.
- **Missing platform evidence:** Mac/Linux builds, real Mac compilation, signing/notarization and installation were not performed in this Windows environment. These remain explicit qualification gates; CI configuration is not execution evidence.

The reviewer supported the structural command portability, draft-only release policy and explicit full-feature release gate. It did not establish cross-platform runtime readiness. The Windows build and startup checks were rerun after the relevant corrections; results and remaining work are recorded in BUILDING.md and the implementation report.
