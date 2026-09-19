const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, globalShortcut, session, ipcMain } = require("electron");
// Depth Engine de-0002 E9: pure mid-capture key routing (gate chain + refusal validator).
const captureRouting = require("./src/capture-routing");

// sendInputEvent keyCode strings for the editing gate; map gains PageUp/PageDown
// (E8 pass-11 trace 15: "the map gains PageUp/PageDown").
const SEND_KEY_MAP = {
  48: "Tab", 51: "Backspace", 115: "Home", 116: "PageUp",
  117: "Delete", 119: "End", 121: "PageDown",
  123: "Left", 124: "Right", 125: "Down", 126: "Up",
};
const NAV_KEYS = { 123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp" };

function sendModifiersFromFlags(flags) {
  const mods = [];
  if (flags & captureRouting.FLAG_COMMAND) mods.push("command");
  if (flags & captureRouting.FLAG_SHIFT) mods.push("shift");
  if (flags & captureRouting.FLAG_OPTION) mods.push("option");
  if (flags & captureRouting.FLAG_CONTROL) mods.push("control");
  return mods;
}

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    // On packaged macOS builds, process.cwd() may be inside a read-only .app
    // bundle. Fall back to userData so .env writes never fail.
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      return path.join(process.cwd(), ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). The overlay UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// ── Death-visibility instrumentation (2026-09-18 14:41:38.8 incident) ──
// The app once exited with code 1 leaving zero trace (no will-quit log, no
// crash report, no signal message from the npm shim). These hooks write a
// dedicated death-watch log so any future silent death self-diagnoses.
// NOTE: process.on("SIGINT"/"SIGTERM") handlers do NOT fire in Electron main
// on this machine (Chromium owns the signal disposition; validated 2026-09-18
// by smoke test). Signal deaths are captured by cluely-safe-start.sh instead:
// the shim prints "exited with signal X" into the tee'd console log.
const DEATH_LOG = path.join(require("os").homedir(), ".screen-reader-util", "logs", "death-watch.log");
function _deathNote(msg) {
  try { fs.appendFileSync(DEATH_LOG, new Date().toISOString() + " " + msg + "\n"); } catch (_) { /* never crash the app over a log write */ }
}
process.on("exit", (code) => { _deathNote("process exit event, code=" + code); });
app.on("render-process-gone", (_event, _wc, details) => {
  _deathNote("render-process-gone reason=" + (details && details.reason) + " exitCode=" + (details && details.exitCode));
});
app.on("child-process-gone", (_event, details) => {
  _deathNote("child-process-gone type=" + (details && details.type) + " reason=" + (details && details.reason) + " exitCode=" + (details && details.exitCode));
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    // Persisted user preferences: saved to .env on every change and read
    // back here so skill/language/icon/gap survive restarts (previously
    // they were in-memory only and reset on every launch).
    const validSkills = ["behavioral", "dsa", "mcq", "ood", "programming", "system-design"];
    this.activeSkill = validSkills.includes(process.env.ACTIVE_SKILL)
      ? process.env.ACTIVE_SKILL
      : "dsa";
    const validLanguages = ["cpp", "c", "python", "java", "javascript"];
    this.codingLanguage = validLanguages.includes(process.env.CODING_LANGUAGE)
      ? process.env.CODING_LANGUAGE
      : "cpp";
    this.appIcon = ["terminal", "activity", "settings"].includes(process.env.APP_ICON)
      ? process.env.APP_ICON
      : null;
    const persistedGap = Number(process.env.WINDOW_GAP);
    this.windowGap = Number.isFinite(persistedGap) ? persistedGap : null;
    this.speechAvailable = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".sru-firstrun-completed"),
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Terminal" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  /**
   * Keystroke-capture mode (macOS).
   *
   * Design (ADR-worthy, see plan): chat/settings/onboarding are focusable:false
   * panels, so clicks can never make them the macOS key window (which would
   * blur the proctored page). The trade-off is that they can never receive
   * real keyboard input — so a global hotkey toggles this mode, under which a
   * CGEventTap helper process swallows ALL keystrokes system-wide and reports
   * them to us; we inject them into the target window with
   * webContents.sendInputEvent (which bypasses OS focus entirely).
   *
   * Enter sends/commits and exits the mode; Esc cancels and exits.
   * While the mode is OFF the event tap does not exist at all, so keystrokes
   * meant for the exam page are never touched.
   */
  _captureMode = false;
  _captureHelper = null;
  _captureTarget = null; // 'chat' | 'settings' | 'onboarding'
  _captureHotkey = null;
  _paletteOpen = false;
  _captureReady = false;
  _captureStartId = 0;
  _pendingTimer = null;
  _hotkeyUnregisteredForCapture = false;
  _beepRiskEvents = 0;
  _hoBHandlers = null; // render-process-gone / did-finish-load pair (Q077(5))

  getCaptureHotkey() {
    return String(process.env.CAPTURE_MODE_HOTKEY || "CommandOrControl+Shift+Space").trim();
  }

  resolveCaptureHelperPath() {
    const path = require("path");
    const fs = require("fs");
    const candidates = [
      // Packaged app: electron-builder copies resources/bin → Contents/Resources/bin
      path.join(process.resourcesPath || "", "bin", "keystroke-capture"),
      // Dev: built into the repo by scripts/build-capture-helper.sh
      path.join(__dirname, "resources", "bin", "keystroke-capture"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // Dev convenience: compile on first use if swiftc is available.
    try {
      const { spawnSync } = require("child_process");
      const out = path.join(__dirname, "resources", "bin", "keystroke-capture");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const result = spawnSync(
        "swiftc",
        ["-O", path.join(__dirname, "scripts", "keystroke-capture", "main.swift"), "-o", out],
        { timeout: 120000 }
      );
      if (result.status === 0 && fs.existsSync(out)) return out;
    } catch (_) { /* fall through */ }
    return null;
  }

  startCaptureMode() {
    if (process.platform !== "darwin") {
      logger.warn("Keystroke capture mode is macOS-only (CGEventTap)");
      return false;
    }
    if (this._captureMode) return true;

    const helperPath = this.resolveCaptureHelperPath();
    if (!helperPath) {
      logger.error("keystroke-capture helper binary not found and could not be compiled");
      windowManager.broadcastToAllWindows("capture-mode-error", {
        message: "Capture helper missing — run scripts/build-capture-helper.sh (requires Xcode CLT).",
      });
      return false;
    }

    // Decide the target window: the last Cluely window the user clicked into,
    // or chat by default. The window must be visible so the user sees input.
    const validTargets = ["chat", "settings", "onboarding"];
    if (!validTargets.includes(this._captureTarget)) {
      this._captureTarget = "chat";
    }
    const targetWindow = windowManager.getWindow(this._captureTarget);
    if (!targetWindow || targetWindow.isDestroyed()) {
      this._captureTarget = "chat";
    }
    windowManager.showWindow(this._captureTarget);
    // Re-fetch after the fallback: targetWindow above may be stale/destroyed.
    const captureWindow = windowManager.getWindow(this._captureTarget);

    try {
      const { spawn } = require("child_process");
      this._captureHelper = spawn(helperPath, [], { stdio: ["ignore", "pipe", "pipe"] });
      this._captureMode = true;
      this._captureReady = false;
      this._paletteOpen = this._captureTarget === "chat"; // Q058: palette only for the chat target

      // Q051 pending gate: identity-keyed 1s timeout until EVENT_TAP_READY.
      const startId = ++this._captureStartId;
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        if (startId === this._captureStartId && this._captureMode && !this._captureReady) {
          logger.warn("Capture helper did not report READY within 1s — stopping (Q051)");
          this.stopCaptureMode();
          windowManager.broadcastToAllWindows("capture-mode-error", {
            message: "Capture helper did not start in time. Check Input Monitoring permission, then retry.",
          });
        }
      }, 1000);

      // Q080 fold: the share GUARD flag (refuses llm-panel/settings/onboarding
      // shows — guards only, NOT the hide-all screen-share flow) + the A5
      // session-scoped geometry freeze (keyed on capture-active; boundary named L-0067).
      windowManager.setScreenBeingShared(true);
      windowManager.setGeometryFrozen(true);

      // A2 pin: the capture hotkey is unregistered during capture — the tap is
      // the only key path. Re-registered after helper exit + restoration (Q079(4)).
      if (this._captureHotkey && globalShortcut.isRegistered(this._captureHotkey)) {
        globalShortcut.unregister(this._captureHotkey);
        this._hotkeyUnregisteredForCapture = true;
      }

      // HOLE B (Q077(5)): renderer gone → stop fail-visible; reload → re-broadcast.
      const targetWc = captureWindow.webContents;
      const onGone = () => {
        if (this._captureMode) {
          logger.warn("Renderer process gone mid-capture — stopping capture (Q077(5))");
          this.stopCaptureMode();
          windowManager.broadcastToAllWindows("capture-mode-error", {
            message: "The chat window crashed — capture stopped.",
          });
        }
      };
      const onLoaded = () => {
        if (this._captureMode) {
          windowManager.broadcastToAllWindows("capture-mode-changed", {
            active: true, target: this._captureTarget, paletteOpen: this._paletteOpen,
          });
        }
      };
      targetWc.on("render-process-gone", onGone);
      targetWc.on("did-finish-load", onLoaded);
      this._hoBHandlers = { wc: targetWc, onGone, onLoaded };

      let stderrBuf = "";
      this._captureHelper.stderr.on("data", (chunk) => {
        stderrBuf += String(chunk);
        if (stderrBuf.includes("EVENT_TAP_READY")) {
          this._captureReady = true;
          if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
          logger.info("Capture helper READY — routing armed");
        }
        if (stderrBuf.includes("EVENT_TAP_RESTORATION_POSTED")) {
          logger.info("Helper posted modifier restoration (Q063(3))");
        }
        if (stderrBuf.includes("EVENT_TAP_ORPHANED")) {
          logger.warn("Capture helper detected orphaned parent and exited (Q031 watchdog)");
        }
        if (stderrBuf.includes("EVENT_TAP_CREATE_FAILED")) {
          logger.error("Event tap creation failed — Input Monitoring permission not granted");
          this.stopCaptureMode();
          windowManager.broadcastToAllWindows("capture-mode-error", {
            message:
              "macOS blocked global key capture. Grant Input Monitoring to this app in System Settings → Privacy & Security → Input Monitoring (it appears as its disguise name), then retry.",
          });
        }
      });

      this._captureHelper.stdout.on("data", (chunk) => {
        for (const line of String(chunk).split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt && evt.t === "secure") {
              // Q067: secure input detected mid-capture → stop fail-visible.
              logger.warn("Secure input detected mid-capture — stopping (Q067)");
              this._beepRiskEvents += 1;
              this.stopCaptureMode();
              windowManager.broadcastToAllWindows("capture-mode-error", {
                message: "Secure input field detected — capture stopped.",
              });
              continue;
            }
            this.handleCapturedKey(evt);
          } catch (_) { /* skip malformed lines */ }
        }
      });

      this._captureHelper.on("exit", (code) => {
        if (this._captureMode) {
          // Helper died unexpectedly (or we killed it in stopCaptureMode).
          logger.warn("keystroke-capture helper exited", { code });
          this._captureMode = false;
          this._captureHelper = null;
          windowManager.broadcastToAllWindows("capture-mode-changed", {
            active: false,
            target: this._captureTarget,
          });
        }
        // Q079(4) re-arm ordering: the helper posts the flagsChanged restoration
        // BEFORE exiting; re-register the capture hotkey only now, after it is gone.
        if (this._hotkeyUnregisteredForCapture) {
          this._hotkeyUnregisteredForCapture = false;
          this.registerCaptureHotkey();
        }
      });

      windowManager.broadcastToAllWindows("capture-mode-changed", {
        active: true,
        target: this._captureTarget,
        paletteOpen: this._paletteOpen,
      });
      logger.info("Keystroke capture mode ON", { target: this._captureTarget, hotkey: this.getCaptureHotkey() });
      return true;
    } catch (error) {
      logger.error("Failed to start capture helper", { error: error.message });
      this._captureMode = false;
      this._paletteOpen = false;
      windowManager.setScreenBeingShared(false);
      windowManager.setGeometryFrozen(false);
      return false;
    }
  }

  stopCaptureMode() {
    if (this._pendingTimer) { clearTimeout(this._pendingTimer); this._pendingTimer = null; }
    this._captureStartId++; // invalidate any in-flight pending gate
    this._captureReady = false;
    this._paletteOpen = false;
    windowManager.setScreenBeingShared(false);
    windowManager.setGeometryFrozen(false);
    if (this._hoBHandlers) {
      try {
        this._hoBHandlers.wc.removeListener("render-process-gone", this._hoBHandlers.onGone);
        this._hoBHandlers.wc.removeListener("did-finish-load", this._hoBHandlers.onLoaded);
      } catch (_) { /* window already gone */ }
      this._hoBHandlers = null;
    }
    if (!this._captureMode) {
      this._captureMode = false;
      this._captureHelper = null;
      return false;
    }
    const wasActive = true;
    const target = this._captureTarget;
    if (this._captureHelper) {
      try { this._captureHelper.kill("SIGTERM"); } catch (_) { /* already dead */ }
    }
    this._captureHelper = null;
    this._captureMode = false;
    // The helper posts its modifier restoration (flagsChanged, cleared mask)
    // in its SIGTERM path BEFORE exiting; the capture hotkey re-registers in
    // the helper 'exit' handler — the Q079(4) re-arm ordering.
    windowManager.broadcastToAllWindows("capture-mode-changed", { active: false, target, paletteOpen: false });
    logger.info("Keystroke capture mode OFF", { target, beepRiskEvents: this._beepRiskEvents });
    return wasActive;
  }

  toggleCaptureMode() {
    if (this._captureMode) {
      this.stopCaptureMode();
    } else {
      this.startCaptureMode();
    }
    return this._captureMode;
  }

  /**
   * Route a swallowed key from the event tap into the capture-target window
   * via sendInputEvent (bypasses OS focus — the window is focusable:false).
   * The disposition comes from the pure gate chain in src/capture-routing.js
   * (Depth Engine de-0002 contract: family → exit-equality → drop → editing →
   * palette → normal; L-0052..L-0067).
   */
  handleCapturedKey(keyEvent) {
    if (!this._captureMode || !keyEvent || keyEvent.t !== "down") return;
    // Q051 pending gate: nothing routes until the helper reported READY.
    if (!this._captureReady) return;

    const win = windowManager.getWindow(this._captureTarget);
    if (!win || win.isDestroyed()) {
      this.stopCaptureMode();
      return;
    }
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) {
      this.stopCaptureMode();
      return;
    }

    const action = captureRouting.routeCapturedKey(keyEvent, { paletteOpen: this._paletteOpen });
    const code = Number(keyEvent.code) || 0;
    const flags = Number(keyEvent.flags) || 0;

    switch (action.action) {
      case "palette-toggle":
        this._paletteOpen = !this._paletteOpen;
        windowManager.broadcastToAllWindows("capture-mode-changed", {
          active: true, target: this._captureTarget, paletteOpen: this._paletteOpen,
        });
        break;
      case "skill-set":
        this.applySkillFromChord(action.digit);
        break;
      case "exit-capture":
        this.stopCaptureMode();
        break;
      case "palette-commit":
        // Q077(1): commit selection + close palette + KEEP capture ON + refocus.
        wc.send("palette-key", { key: "Enter" });
        this._paletteOpen = false;
        windowManager.broadcastToAllWindows("capture-mode-changed", {
          active: true, target: this._captureTarget, paletteOpen: false,
        });
        break;
      case "palette-nav":
        wc.send("palette-key", { key: NAV_KEYS[code] || "ArrowDown" });
        break;
      case "palette-tab":
        wc.send("palette-key", { key: "Tab" });
        break;
      case "palette-key":
        // Q050/Q052: letters are gated from the draft while the palette is
        // open — delivered on the separate palette-key channel instead.
        wc.send("palette-key", { key: action.char });
        break;
      case "editing": {
        const keyCode = SEND_KEY_MAP[code];
        if (!keyCode) break;
        const modifiers = sendModifiersFromFlags(flags);
        wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        break;
      }
      case "type":
        wc.sendInputEvent({ type: "char", keyCode: action.char });
        break;
      case "send-exit":
        // Q077(1): bare Enter, palette closed — forward-and-stop send gesture.
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        this.stopCaptureMode();
        break;
      case "drop":
      case "consume-silent":
      default:
        // A7 audit counter: every consumed key that could otherwise have
        // reached a responder chain (and raised NSBeep) is counted.
        this._beepRiskEvents += 1;
        break;
    }
  }

  /**
   * A3 chord switch: ⌃⌥⌘+digit → skill. The Q033-correct 4-step path.
   */
  applySkillFromChord(digit) {
    const skills = ["behavioral", "dsa", "mcq", "ood", "programming", "system-design"];
    this.applySkillByName(skills[Number(digit) - 1], { source: `chord-${digit}` });
  }

  /**
   * Shared 4-step skill switch (Q033): activeSkill + sessionManager + .env
   * persistence + broadcast. Used by the chord and the palette entry.
   */
  applySkillByName(skill, context = {}) {
    if (!skill || typeof skill !== "string") {
      logger.warn("applySkillByName: no skill", { context });
      return;
    }
    this.activeSkill = skill;
    try { sessionManager.setActiveSkill(skill); } catch (error) {
      logger.warn("sessionManager.setActiveSkill failed", { error: error.message });
    }
    try { this.persistEnvUpdates({ ACTIVE_SKILL: skill }); } catch (error) {
      logger.warn("Skill persist to .env failed", { error: error.message });
    }
    windowManager.broadcastToAllWindows("skill-changed", { skill });
    logger.info("Skill set", { skill, ...context });
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    // macOS: run as an accessory app so clicking overlay windows never
    // activates the app (which would steal focus from the proctored page).
    // The app has no Dock icon. Keyboard input works without ever leaving
    // this policy: every overlay window is a non-activating panel (or
    // focusable:false) and panels accept typing by becoming key WITHOUT
    // activating the app. WindowManager passes skipTransformProcessType
    // to setVisibleOnAllWorkspaces() so Electron's DockShow() transform
    // cannot silently revert this policy back to 'regular'.
    if (
      process.platform === "darwin" &&
      config.get("stealth.hideFromDock") !== false
    ) {
      try {
        app.setActivationPolicy("accessory");
        logger.info(
          "Activation policy set to 'accessory' (stealth.hideFromDock)"
        );
      } catch (error) {
        logger.warn("Failed to set accessory activation policy", {
          error: error.message,
        });
      }
    }

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    // Apply persisted preferences that were read in the constructor:
    // window gap and the disguised app icon/name survive restarts now.
    try {
      if (this.windowGap !== null && windowManager.setWindowGap) {
        windowManager.setWindowGap(this.windowGap);
      }
      if (this.appIcon && this.updateAppIcon) {
        this.updateAppIcon(this.appIcon);
      }
    } catch (error) {
      logger.warn("Failed to apply persisted preferences", { error: error.message });
    }

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Startup stealth self-check: report the state of each privacy flag.
      // Deferred so windows finish showing and always-on-top re-assertion
      // has run at least once before we query live state.
      setTimeout(() => {
        try {
          const allWindows = Array.from(windowManager.windows.values()).filter(
            (w) => w && !w.isDestroyed()
          );
          const contentProtection = allWindows.length > 0; // setContentProtection(true) applied at creation
          const alwaysOnTop =
            allWindows.length > 0 && allWindows.every((w) => w.isAlwaysOnTop());
          // Click-through capability is wired when the manager exposes the
          // toggle (Cmd+Shift+I / Alt+A). Windows start interactive by design,
          // so we report the feature as active rather than the current toggle.
          const clickThrough =
            typeof windowManager.setInteractive === "function" &&
            typeof windowManager.toggleInteraction === "function";
          const processDisguise = process.title === "Terminal ";
          logger.info(
            `[STEALTH] contentProtection=${contentProtection}, alwaysOnTop=${alwaysOnTop}, clickThrough=${clickThrough}, processDisguise=${processDisguise}`
          );
        } catch (e) {
          logger.warn("Stealth self-check failed", { error: e.message });
        }
      }, 1500);

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;
    
    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        const platformUA = process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
        details.requestHeaders['User-Agent'] = platformUA;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    
    // NOTE: the previous setCertificateVerifyProc that blindly trusted
    // generativelanguage.googleapis.com (callback(0) = trust any cert) was
    // REMOVED. Disabling TLS verification is a network-level stealth and
    // security liability; default certificate verification now applies to
    // every host.
    
    logger.debug('Network configuration applied');
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalizeForComparison = (value) => process.platform === "win32"
          ? value.toLowerCase()
          : value;
        const page = normalizeForComparison(pagePath);
        const root = normalizeForComparison(appRoot + path.sep);
        return page.startsWith(root);
      } catch (_) {
        return false;
      }
    };

    // Electron exposes camera/microphone access as the single `media`
    // permission. The requested device type is provided separately in details.
    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) {
          return false;
        }
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }

        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted
        });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+Q": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Cluely Shield exam-mode handoff: configure the root helper, then quit
      // the Brain (⌘⇧⌥E). Deliberately a 4-key chord so it never collides with
      // an exam's own shortcuts.
      "CommandOrControl+Shift+Alt+E": () => this.enterShieldExamMode(),
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });

    // Keystroke-capture hotkey (configurable via CAPTURE_MODE_HOTKEY).
    // Registered separately so a settings change can unregister/re-register
    // it live without touching the static shortcut map.
    this.registerCaptureHotkey();
  }

  registerCaptureHotkey() {
    if (process.platform !== "darwin") return;
    try {
      if (this._captureHotkey) {
        globalShortcut.unregister(this._captureHotkey);
      }
      this._captureHotkey = this.getCaptureHotkey();
      const success = globalShortcut.register(this._captureHotkey, () => this.toggleCaptureMode());
      logger.info("Capture hotkey registered", {
        accelerator: this._captureHotkey,
        success,
      });
    } catch (error) {
      logger.warn("Failed to register capture hotkey", { error: error.message });
    }
  }

  // ── Cluely Shield exam-mode handoff ─────────────────────────────────────
  // Push the cached DeepSeek config/credentials to the root helper over the
  // Unix socket, flip examMode on, then fully quit the Brain. From this point
  // the root helper is the only capture/answer agent and LDB (uid 501) cannot
  // kill it (EPERM proven in G0). The Brain must NOT stay dormant — it quits.
  async enterShieldExamMode(opts = {}) {
    try {
      const shieldClient = require("./src/services/shield-client");
      const apiKey = config.getApiKey("DEEPSEEK");
      // Never quit the Brain without a key: an empty-key helper cannot answer
      // and there is no Brain left to fix it. Fail loud and stay alive instead.
      if (!apiKey) {
        logger.error("Shield exam mode aborted: no DeepSeek API key");
        return { ok: false, error: "no DeepSeek API key configured" };
      }
      const reply = await shieldClient.configureExamMode({
        apiKey,
        model: opts.model || config.get("llm.deepseek.model") || "deepseek-flash",
        baseUrl: opts.baseUrl || config.get("llm.deepseek.baseUrl") || "https://api.deepseek.com",
        prompt: opts.prompt || shieldClient.DEFAULT_PROMPT,
        maxTokens: opts.maxTokens || config.get("llm.deepseek.generation.maxOutputTokens") || 4096
      });
      logger.info("Shield exam mode: helper configured; quitting Brain", reply);
      // One tick so any caller's IPC reply/ack fires, then quit everything.
      // Use app.exit(0), not app.quit(): app.quit() waits for every window to
      // close, and this app's windows can block the close (closable:false /
      // overlay windows), which left the Brain running with the button stuck
      // on "Entering exam mode…". The helper has already persisted the config,
      // so a hard exit is exactly what exam mode wants — the Brain fully gone.
      setTimeout(() => app.exit(0), 150);
      return { ok: true, examMode: reply.examMode };
    } catch (error) {
      logger.error("Shield exam mode handoff failed", { error: error.message });
      return { ok: false, error: error.message };
    }
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      windowManager.handleRecordingStarted();
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));

    // NOTE: the old copy-to-clipboard handler was REMOVED deliberately —
    // writing answer code to the system clipboard is a proctor tell
    // (clipboard watchers see the snippets), and the Copy buttons that
    // used it were removed from chat.html and llm-response.html.

    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    // Orphaned preload channels from the R2 audit — now handled.
    ipcMain.handle("get-llm-session-history", () => {
      try {
        return sessionManager.getFullConversationHistory();
      } catch (error) {
        logger.warn("get-llm-session-history failed", { error: error.message });
        return [];
      }
    });

    ipcMain.handle("format-session-history", () => {
      try {
        const events = sessionManager.getFullConversationHistory();
        return events
          .map((event) => {
            const role = event && event.role ? event.role : "event";
            const content = event && event.content ? String(event.content) : JSON.stringify(event || {});
            return `${role.toUpperCase()}: ${content}`;
          })
          .join("\n\n");
      } catch (error) {
        logger.warn("format-session-history failed", { error: error.message });
        return "";
      }
    });

    ipcMain.handle("hide-settings", () => {
      windowManager.hideSettings();
      return { success: true };
    });

    // Keystroke-capture target tracking: the last Cluely window the user
    // clicked into an input field. window-loaded / toggle-* channels from
    // preload's api.send are handled here too (they were orphans).
    ipcMain.on("input-target-focused", (event) => {
      try {
        const { BrowserWindow } = require("electron");
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        for (const [type, candidate] of windowManager.windows.entries()) {
          if (candidate === win && ["chat", "settings", "onboarding"].includes(type)) {
            if (this._captureTarget !== type) {
              this._captureTarget = type;
              logger.debug("Capture target updated", { target: type });
            }
            return;
          }
        }
      } catch (error) {
        logger.warn("input-target-focused handler failed", { error: error.message });
      }
    });

    ipcMain.on("toggle-recording", () => {
      this.toggleSpeechRecognition();
    });

    // ── de-0002 E9: capture palette channels ──
    ipcMain.on("toggle-capture-mode", () => {
      this.toggleCaptureMode();
    });

    ipcMain.on("palette-set-skill", (_event, data) => {
      this.applySkillByName(data && data.skill);
    });

    ipcMain.on("hide-llm-response", () => {
      windowManager.hideLLMResponse();
    });

    ipcMain.on("show-shortcuts-popover", () => {
      const mainWin = windowManager.getWindow("main");
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("toggle-shortcuts-popover");
      }
    });

    ipcMain.on("toggle-interaction-mode", () => {
      windowManager.toggleInteraction();
    });

    ipcMain.on("window-loaded", () => {
      // No-op by design: the channel exists for renderer lifecycle logging.
      logger.debug("Renderer reported window loaded");
    });

    ipcMain.handle("get-capture-mode", () => {
      return { active: this._captureMode, target: this._captureTarget };
    });

    // ── Cluely Shield (root helper) IPC ─────────────────────────────────
    // Exam-mode handoff: push cached config/credentials to the root helper
    // over the Unix socket, then FULLY quit the Brain (design F7/A3 — exam
    // mode = Brain quits, not dormant). After this, the only capture agent is
    // the root helper, which LDB (uid 501) cannot SIGKILL.
    ipcMain.handle("shield-ping", async () => {
      try {
        const shieldClient = require("./src/services/shield-client");
        return { ok: await shieldClient.ping() };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle("shield-status", async () => {
      try {
        const shieldClient = require("./src/services/shield-client");
        return await shieldClient.status();
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle("shield-exam-mode", async (_event, opts = {}) => {
      return await this.enterShieldExamMode(opts);
    });

    ipcMain.handle("shield-answer", async () => {
      try {
        const shieldClient = require("./src/services/shield-client");
        return await shieldClient.answerNow();
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle("shield-quit", async () => {
      try {
        const shieldClient = require("./src/services/shield-client");
        return await shieldClient.quit();
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });

    ipcMain.handle("synthetic-input", async (event, command) => {
      // TEST-HARNESS ONLY: synthesize real OS input (mouse clicks/keys) for
      // the automated stealth matrix. Disabled unless the app is launched
      // with CLUELY_TEST_HARNESS=1 so production launches carry no remote
      // input surface. Keyboard synthesis needs the Accessibility grant on
      // this app; mouse synthesis needs no permission.
      if (process.env.CLUELY_TEST_HARNESS !== "1") {
        logger.warn("synthetic-input blocked: CLUELY_TEST_HARNESS not set");
        return { success: false, reason: "test harness disabled" };
      }
      try {
        const helperPath = this.resolveCaptureHelperPath();
        if (!helperPath) return { success: false, reason: "helper missing" };
        const { spawn } = require("child_process");
        const child = spawn(helperPath, ["post"], { stdio: ["pipe", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout.on("data", (chunk) => { stdoutBuf += String(chunk); });
        child.stderr.on("data", (chunk) => { stderrBuf += String(chunk); });
        child.stdin.write(JSON.stringify(command || {}) + "\n");
        child.stdin.end(); // helper exits on stdin EOF
        child.on("error", (error) => {
          logger.warn("synthetic-input helper error", { error: error.message });
        });
        // Wait for the helper to exit so we can return its output (e.g. the
        // "where" probe) for permission diagnostics.
        const output = await new Promise((resolve) => {
          child.on("exit", () => resolve({ stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() }));
          setTimeout(() => resolve({ stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() + " (timeout)" }), 5000);
        });
        return { success: true, command, ...output };
      } catch (error) {
        logger.warn("synthetic-input failed", { error: error.message });
        return { success: false, reason: error.message };
      }
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    ipcMain.handle("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    ipcMain.handle("install-whisper", async (event) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      }
    });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(modelName || 'small', {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      windowManager.windows.forEach((win, type) => {
        if (!win.isDestroyed() && win.webContents === webContents) {
          win.hide();
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "dsa",
      "ood",
      "mcq",
      "system-design",
      "behavioral",
      "programming",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['dsa', 'ood'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa', 'ood'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Route speech UI events according to the user's response-target setting.
    sessionManager.addUserInput(fragment, 'speech');
    this.sendToVoiceResponseWindows("transcription-received", { text: fragment });

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa', 'ood'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer progressively to the configured speech target.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMLoading();
      }
      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      this.sendTranscriptionLLMResponseToVoiceTargets(llmResult);
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isTranscriptionResponse: true
        });
      }

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the target replaces the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.sendTranscriptionLLMResponseToVoiceTargets(fallbackResult);
        if (this.shouldShowVoiceOverlay()) {
          windowManager.showLLMResponse(fallbackResult.response, {
            skill: this.activeSkill,
            processingTime: fallbackResult.metadata.processingTime,
            usedFallback: true,
            isTranscriptionResponse: true
          });
        }
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  sendToChatWindow(channel, data) {
    const chatWindow = windowManager.getWindow("chat");
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.warn("Chat window unavailable for speech event", { channel });
      return;
    }
    chatWindow.webContents.send(channel, data);
  }

  getVoiceResponseTarget() {
    const configured = String(process.env.WHISPER_RESPONSE_TARGET || 'both').trim().toLowerCase();
    return ['chat', 'overlay', 'both'].includes(configured) ? configured : 'both';
  }

  shouldShowVoiceOverlay() {
    return ['overlay', 'both'].includes(this.getVoiceResponseTarget());
  }

  sendToVoiceResponseWindows(channel, data) {
    const target = this.getVoiceResponseTarget();
    if (target === 'chat' || target === 'both') {
      this.sendToChatWindow(channel, data);
    }
    if (target === 'overlay' || target === 'both') {
      const responseWindow = windowManager.getWindow("llmResponse");
      if (responseWindow && !responseWindow.isDestroyed()) {
        responseWindow.webContents.send(channel, data);
      }
    }
  }

  sendTranscriptionLLMResponseToVoiceTargets(llmResult) {
    const data = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };
    this.sendToVoiceResponseWindows("transcription-llm-response", data);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop.
      // Every window access is guarded against destruction: the historical
      // "Object has been destroyed" crash (18 rapid restarts in the Sep 17
      // forensics) came from calling isVisible() on destroyed windows here.
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window && !window.isDestroyed() && window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    if (this._captureHelper) {
      try { this._captureHelper.kill("SIGTERM"); } catch (_) { /* already dead */ }
      this._captureHelper = null;
    }
    this._captureMode = false;
    speechService.shutdown();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
      });
    }
    return this._whisperInstaller;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,

      speechProvider: speechService.provider || "whisper",
      azureKey: process.env.AZURE_SPEECH_KEY || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "small",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "auto",
      whisperDevice: process.env.WHISPER_DEVICE || "auto",
      whisperCaptureMode: process.env.WHISPER_CAPTURE_MODE ||
        (process.env.WHISPER_MANUAL_CAPTURE === "true" ? "manual" : "vad"),
      whisperResponseTarget: process.env.WHISPER_RESPONSE_TARGET || "both",
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      geminiKey: process.env.GEMINI_API_KEY || "",
      llmProvider: process.env.LLM_PROVIDER || "gemini",
      deepseekKey: process.env.DEEPSEEK_API_KEY || "",
      captureHotkey: this.getCaptureHotkey(),

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots.
      const envUpdates = {};
      if (settings.speechProvider === "azure" || settings.speechProvider === "whisper") {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.azureKey !== undefined) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (["auto", "cpu", "cuda"].includes(settings.whisperDevice)) {
        envUpdates.WHISPER_DEVICE = settings.whisperDevice;
      }
      if (["manual", "vad"].includes(settings.whisperCaptureMode)) {
        envUpdates.WHISPER_CAPTURE_MODE = settings.whisperCaptureMode;
      }
      if (["chat", "overlay", "both"].includes(settings.whisperResponseTarget)) {
        envUpdates.WHISPER_RESPONSE_TARGET = settings.whisperResponseTarget;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }
      if (settings.deepseekKey !== undefined) {
        envUpdates.DEEPSEEK_API_KEY = settings.deepseekKey;
      }
      if (settings.llmProvider === "gemini" || settings.llmProvider === "deepseek") {
        envUpdates.LLM_PROVIDER = settings.llmProvider;
      }

      // ── Persist the previously in-memory-only preferences ──
      // codingLanguage / activeSkill / appIcon / windowGap used to reset on
      // every restart (R2 audit finding). They now round-trip through .env.
      const validSkills = ["behavioral", "dsa", "mcq", "ood", "programming", "system-design"];
      const validLanguages = ["cpp", "c", "python", "java", "javascript"];
      const validIcons = ["terminal", "activity", "settings"];
      if (settings.codingLanguage && validLanguages.includes(settings.codingLanguage)) {
        envUpdates.CODING_LANGUAGE = settings.codingLanguage;
      }
      if (settings.activeSkill && validSkills.includes(settings.activeSkill)) {
        envUpdates.ACTIVE_SKILL = settings.activeSkill;
      }
      const iconKey = settings.selectedIcon || settings.appIcon;
      if (iconKey && validIcons.includes(iconKey)) {
        envUpdates.APP_ICON = iconKey;
      }
      if (settings.windowGap !== undefined && settings.windowGap !== null && settings.windowGap !== "") {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) {
          envUpdates.WINDOW_GAP = String(Math.max(0, Math.min(100, gap)));
        }
      }
      if (settings.captureHotkey && typeof settings.captureHotkey === "string") {
        const hotkey = settings.captureHotkey.trim();
        if (hotkey) {
          // Q079(1): settings refuses any capture-hotkey binding whose chord has
          // a pinned mid-capture role (family members, editing-class chords,
          // bare Esc/Enter/Tab/arrows). The default exit chord stays legal.
          const refusal = captureRouting.validateCaptureHotkey(hotkey);
          if (refusal.refused) {
            logger.warn("Capture hotkey refused by contract validation", { hotkey, reason: refusal.reason });
            windowManager.broadcastToAllWindows("capture-hotkey-refused", { hotkey, reason: refusal.reason });
          } else {
            envUpdates.CAPTURE_MODE_HOTKEY = hotkey;
            // Re-register the capture hotkey live so the change applies
            // without a restart.
            try {
              const { globalShortcut } = require("electron");
              const oldHotkey = this._captureHotkey;
              if (oldHotkey) globalShortcut.unregister(oldHotkey);
              this._captureHotkey = hotkey;
              const ok = globalShortcut.register(hotkey, () => this.toggleCaptureMode());
              if (!ok) {
                // Roll back to the previous hotkey if the new one is taken.
                this._captureHotkey = oldHotkey;
                if (oldHotkey) globalShortcut.register(oldHotkey, () => this.toggleCaptureMode());
                logger.warn("Capture hotkey registration failed; kept previous", { hotkey });
              } else {
                logger.info("Capture hotkey updated", { hotkey });
              }
            } catch (error) {
              logger.warn("Failed to re-register capture hotkey", { error: error.message });
            }
          }
        }
      }

      // Capture the previous whisper command BEFORE persisting — persistEnvUpdates
      // mutates process.env in place, so comparing afterwards would always read
      // equal and skip the speech re-init below (the exact stale-mic-after-install
      // bug the re-init guards against).
      const prevWhisperCommand = process.env.WHISPER_COMMAND || '';

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // If an LLM key or provider was just saved, reinitialize the LLM service
      // so the new client picks up the key/provider. Without this, the test-
      // connection button in the onboarding wizard fails with
      // "Service not initialized" because the client was first created
      // at app startup, before any key was set.
      const llmConfigChanged = settings.geminiKey !== undefined ||
        settings.deepseekKey !== undefined ||
        settings.llmProvider !== undefined;
      if (llmConfigChanged) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after LLM config update");
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after LLM config update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when provider OR whisper command
      // changes. Without the second check, the install flow (which
      // writes a new whisperCommand after install but keeps the same
      // provider) would leave the speech service pointing at a stale
      // (or non-existent) binary, and the main overlay's mic button
      // would stay hidden / non-functional.
      const providerChanged = settings.speechProvider && speechService.provider !== settings.speechProvider;
      const whisperCommandChanged = settings.whisperCommand !== undefined &&
        prevWhisperCommand !== String(settings.whisperCommand || '');
      if (providerChanged || whisperCommandChanged) {
        try {
          speechService.initializeClient();
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, overlay, chat)
          // can react immediately — especially the main overlay's
          // mic button, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            providerChanged,
            whisperCommandChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      // WARNING: assigning process.title on macOS makes LaunchServices
      // re-register the app as a Foreground app ~700 ms later, silently
      // undoing the accessory activation policy (verified empirically:
      // NSRunningApplication.activationPolicy flips accessory -> regular).
      // Skip no-op assignments (the common case: the title is already the
      // stealth name) and re-assert the accessory policy after the refresh
      // timers when the title genuinely changes (icon/name switch).
      if (process.title !== appName) {
        process.title = appName;
      }

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          if (process.title !== appName) {
            process.title = appName;
          }
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      // When the title genuinely changed above, the assignment schedules an
      // asynchronous accessory -> regular policy flip. Re-assert accessory
      // once the last refresh timer (500 ms) and the ~700 ms flip lag have
      // settled. Harmless no-op when the policy never flipped.
      if (
        process.platform === "darwin" &&
        config.get("stealth.hideFromDock") !== false
      ) {
        setTimeout(() => {
          try {
            app.setActivationPolicy("accessory");
            logger.debug("Re-asserted accessory policy after name update");
          } catch (error) {
            logger.warn("Failed to re-assert accessory policy", {
              error: error.message,
            });
          }
        }, 1500);
      }

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
