# NoCatch

A desktop reading and study assistant built from [OpenCluely](https://github.com/TechyCSR/OpenCluely). Ask questions by text, screen capture, or configured voice input, and use uploaded reference materials in your answers.

## Latest version

**Use `latest/attached-navbar-chat`.** It is this repository’s default branch and contains the newest integrated interface. Branches under `archive/` preserve earlier development snapshots; they are not the recommended starting point.

The latest Windows Exam layout brings back the compact navbar and attaches the chat below it:

- Start with **Capture · Chat · Materials · More**.
- Open or collapse chat with **Ctrl+Shift+C**.
- Move the navbar and open chat together with **Ctrl+Shift+arrow keys**.
- Hide or restore the previous arrangement with **Ctrl+Shift+V**.
- Mouse and trackpad dragging are locked in this layout. Normal layout retains ordinary window controls.
- Answer style, code language, panel placement and settings are available from **More**.

Chat retains its draft, reading position and ongoing answer when collapsed. Reference sources stay attached to the answer that used them. Voice controls appear when voice is configured.

## Run from source

Use Node.js 22 and the platform prerequisites in [the build guide](docs/archive-20260925/build-and-packaging/BUILDING.md).

```sh
git clone --branch latest/attached-navbar-chat https://github.com/endegenaassefa/NoCatch.git
cd NoCatch
npm ci
npm start
```

Complete setup in the app using your own provider configuration. Optional local speech dependencies require separate setup; installing JavaScript dependencies alone does not install the speech runtime.

## Branches and history

See [BRANCHES.md](BRANCHES.md) for the purpose and original name of every published branch. Public history retains development ancestry while omitting runtime databases, machine recordings, dependency copies and local handoff data. Those exclusions do not remove your local originals. Older branches represent committed snapshots, not uncommitted work in separate worktrees.

## Verification

The attached-navbar change passed **22 module checks** and **59 browser checks**, including chat visibility, retained drafts, movement geometry, stale callbacks, narrow layouts and a constrained-height menu. Five existing asynchronous chat-preservation checks also passed. Portable regression scripts and their coverage are in [tests/attached-navbar](tests/attached-navbar/README.md).

Isolated Windows checks exercised toolbar startup, chat attachment, pointer drag locking, menu expansion and restoration, and native group movement through the production handler. **Physical keyboard hold/release remains unverified**: synthetic key input did not reach the shortcut handler, and the manual trial was not completed. Native checks used one display at 125% scaling; no monitor hotplug, microphone, provider or restricted-browser compatibility claim is made.

This repository publishes source. No new installer or binary release accompanies this branch.

## Attribution and license

Based on [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely), with NoCatch changes for materials, answer presentation, Windows layout and lifecycle handling. Original notices and contributor history are retained. See [LICENSE](LICENSE) for Apache-2.0 terms and the notices accompanying bundled third-party assets.
