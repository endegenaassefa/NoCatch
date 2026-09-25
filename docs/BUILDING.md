# Building qualification artifacts

These commands prepare development/qualification artifacts. They do not establish Windows/macOS feature parity, a managed sign-in service, or production readiness. Full parity remains the release requirement in [CROSS-PLATFORM-DESIGN.md](CROSS-PLATFORM-DESIGN.md).

## Toolchain and targets

- Development/CI: Node 22 and the committed npm lockfile.
- Candidate runtime: Electron 44.4.4; builder: 26.15.3.
- Build targets: Windows x64, Mac x64/arm64, and the existing Linux x64 packages.
- Electron 44 no longer supplies Windows ia32 binaries. The former target fails with a download 404 and has been removed. This changes the CPU support envelope, not the required feature set. See [Electron's breaking changes](https://www.electronjs.org/docs/latest/breaking-changes).
- Electron 44 requires macOS 13 or later; the helper uses the same deployment target. Actual oldest/newest Mac qualification and Windows ARM64 support remain outstanding. See [Electron 44](https://www.electronjs.org/blog/electron-44-0).

## Local commands

```text
npm ci
npm start
npm run test:packaging
node scripts/test-capture-routing.js
node --test scripts/test-deepseek-provider.js scripts/test-multi-skill.js
node scripts/build.js win --x64
node scripts/build.js mac
node scripts/build.js linux
node scripts/build.js --dir
node scripts/test-packaged-startup.js dist/win-unpacked/screen-reader-util.exe
node scripts/clean.js
```

Use the explicit Node build command when passing flags from PowerShell; it avoids npm/PowerShell argument-forwarding differences. `npm run build:win`, `build:mac` and `build:linux` also work without extra flags. Every build wrapper forces `--publish never`. Build-all includes macOS and therefore requires a Mac; it fails explicitly on other hosts.

Mac packaging requires Xcode command-line tools on the build machine. `beforePack` first checks public managed configuration on every platform, then compiles and verifies the correct Mac helper architecture under `resources/bin/<arch>/`; the builder bundles and signs the helper with the app. Missing compiler/helper/architecture is a build failure. The legacy shell entry point forwards to the Node compiler script. Packaged applications do not compile helpers at runtime.

`clean` removes only this checkout's `dist` directory and refuses a linked output directory. The package file list includes application assets, runtime code and the existing license. The archive check rejects known research/documentation directories, `.env` files and logs, and verifies the size and SHA-256 integrity of every unpacked payload. These checks are not a general secret scanner for arbitrary content within allowed source/assets directories. Source-side developer/forensic tools remain in the repository; their end-user distribution requirements remain part of parity qualification.

## Signed builds

Signed/release builds also require the public deployment configuration described below. `OPENCLUELY_RELEASE=1` (set by `--release`, signed CI runs and tags) rejects absent or invalid configuration on Windows, Mac and Linux, before Mac helper compilation. Signing and native qualification remain separate gates.

Provide credentials through protected environment variables/CI secrets, never source files or command-line literal values:

| Platform | Build environment |
|---|---|
| Windows | `WIN_CSC_LINK` and certificate password `WIN_CSC_KEY_PASSWORD`; `CSC_LINK`/`CSC_KEY_PASSWORD` are also accepted locally |
| Mac | `CSC_LINK`, `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Mac API-key alternative, local | `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, plus signing certificate variables |

Run `node scripts/build.js win --release` or `node scripts/build.js mac --release`. Certificate passwords may be empty only when the actual certificate permits it. Signed builds check required inputs before packaging and force code signing; bad credentials fail rather than producing a release that merely looks signed. Mac hardened runtime, JIT/audio entitlements and the embedded helper's signature need validation on a real signed Mac build. This environment has not performed that validation.

CI maps `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` repository secrets to the Mac environment names above, and uses `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` for Windows. Apple account secret names match their environment names. Unsigned PR/manual builds receive no signing credentials. Signed manual runs and version tags require the credentials; absent credentials intentionally block completion.

## Public managed configuration

The operator supplies `managed-config.json` in the project root before packaging. It is git-ignored but explicitly included in `app.asar`. Use [managed-config.example.json](../managed-config.example.json) as a schema reference, replacing every placeholder with the operator's provisioned values. Its `.invalid` addresses are deliberately nonfunctional; the example is not copied or packaged automatically. No deployed service is assumed by this implementation.

Only these properties are accepted:

| Property | Contract |
|---|---|
| `issuer` | HTTPS OIDC issuer, exactly matching discovery metadata, including any trailing slash |
| `clientId` | Nonempty public/native PKCE client ID, never a client secret |
| `apiBaseUrl` | HTTPS managed API base URL; the loader normalizes it and removes its trailing slash |
| `audience` | Nonempty API audience registered with the identity provider |
| `scopes` | Array of OAuth scope tokens including `openid`; duplicate scopes are normalized |
| `loopbackPorts` | Optional array of 1–8 integer callback ports: `0` for an ephemeral port, or `1024`–`65535`; defaults to `[0]` |

Both URLs reject credentials, query strings, fragments, whitespace and non-HTTPS schemes. Unknown properties, including provider keys, `clientSecret` or nested credential objects, invalidate the whole file. Provider credentials belong only on the server; signing credentials belong in the protected build environment. Validation checks the public schema, not service availability or arbitrary secrets pasted into otherwise valid public values. Do not put secrets anywhere in this file.

CI accepts a repository **variable** named `OPENCLUELY_MANAGED_CONFIG_JSON`, containing the complete public JSON object. The workflow passes it as environment data to `node scripts/prepare-managed-config.js`, which validates before writing and does not print supplied values. With no variable, unsigned builds can proceed without a file; signed/manual release and tag builds fail. Locally, create the file with the operator's values, then run the same preparation command to validate it, or provide that environment variable to the command. Development `NOCATCH_MANAGED_*` overrides do not satisfy packaging checks and are ignored by packaged applications.

Every packaging mode rejects an invalid file when present. An unsigned development build with no file remains valid and reports “Managed service is not configured in this build.” Its managed sign-in stays unavailable. `afterPack` extracts and validates the configuration from the actual archive, regardless of source-file contents, and requires it in release mode. To inspect an archive independently, run `node scripts/verify-package.js <path-to-app.asar>`; set `OPENCLUELY_RELEASE=1` in that command's environment to require the deployment file. Public schema validation and local fixture checks establish neither working identity/provider endpoints nor signed/native release qualification.

## Artifact validation and release behavior

```text
node scripts/release-artifacts.js verify dist win
node scripts/release-artifacts.js verify dist mac
node scripts/release-artifacts.js verify dist linux
node scripts/release-artifacts.js collect artifacts release
```

Validation requires every configured architecture's installer/archive, nonempty channel metadata, existing referenced payloads and matching SHA-512 hashes. Update metadata must cover every architecture's NSIS installer, Mac ZIP or Linux AppImage; foreign-platform and duplicate entries are rejected. Collection refuses duplicate filenames, stale-version artifacts and a nonempty destination, retains blockmaps/update YAML and produces SHA256SUMS.txt. Inputs are flat builder output or one CI-job folder level; unpacked application frameworks are not release artifacts.

PRs and unsigned manual runs build/upload qualification artifacts. Version tags sync package/lock versions, require signed Windows/Mac builds and create a **draft** release only after all three build jobs and artifact checks pass. The workflow does not publish a completed product automatically. Update metadata is preserved for future updater integration; the application still has no new updater implementation from this change.

## Remaining gates

Real Mac build/sign/notarization and helper execution; interactive native feature tests; Windows signed installation/upgrades; supported OS boundary tests; managed identity/AI service; packaged local speech; settings migration; and complete P01-P21 parity evidence. A passing build or mocked compiler test satisfies none of those runtime requirements by itself.

The Windows startup smoke test runs the actual packaged main process and five renderers with a temporary profile. It removes provider keys from the child environment, sets Electron userData before main executes and creates an empty userData `.env`, which the current resolver prefers over its working-directory fallback. It asserts credentials remain absent after config loads. A local inspector connection suppresses window display; it checks the exact packaged page paths, preload bridges, load failures and uncaught renderer exceptions through the startup window, then quits and removes the profile. It does not test focus/visibility behavior, capture accuracy, permissions, AI requests or speech. The inspector is bound to loopback only and exists only for the explicitly launched test process.

## Observed checks (2026-09-22, Windows x64)

- `node scripts/build.js win --x64`: completed, producing NSIS installer and portable executable. Authenticode reports `NotSigned`; these are qualification artifacts.
- Packaging tests: 19 passed. Existing capture-routing tests: 56 passed. Existing provider/skill tests: 35 passed.
- Artifact verification: four Windows files including metadata/blockmap, with matching update hashes.
- Archive verification: 11 required files, known exclusions and unpacked payload integrity passed.
- Packaged startup: `onboarding.html`, `settings.html`, `llm-response.html`, `chat.html` and `index.html`; five preload bridges; no observed startup load/preload errors or uncaught renderer exceptions; credentials absent.
- Main-process syntax, lockfile dependency declarations, workflow structure and `git diff --check` passed.

No CI run, Mac/Linux build, installed-app upgrade or signed/notarized runtime check was performed in this session. The fresh Codex review and corrections are recorded in [CROSS-PLATFORM-REVIEW.md](CROSS-PLATFORM-REVIEW.md).
