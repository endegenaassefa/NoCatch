const { BrowserWindow, screen, desktopCapturer, shell } = require('electron');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('WINDOW');
const config = require('../core/config');

// Root exam mode (win32): recover from external topmost demotion on native
// window messages. This is still reactive: a competing topmost window can
// briefly take hit tests before recovery, so this is not a no-flicker promise.
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_WINDOWPOSCHANGED = 0x0047;
const WM_STYLECHANGED = 0x007D;
const TOPMOST_GUARD_BLOCK_LOG_INTERVAL_MS = 30000;

class WindowManager {
  constructor() {
    this.windows = new Map();
    this.activeWindow = 'main';
    this.isInteractive = true; // default to interactive so windows are clickable/drag-able

    this.isVisible = false;
    // User intent survives async window creation and native window loss.
    this.desiredWindowVisibility = new Map();
    this.chatHideVersion = 0;
    this._visibilityIntentEpoch = 0;
    this._lastVisibilityHideEpoch = 0;
    this._lastVisibilityShowEpoch = 0;
    this.currentDisplay = null;
    this._displayChangeTimer = null;
    this.screenWatcher = null;
    this.desktopWatcher = null;
    this.lastActiveSpace = null;
    this.screenCaptureAvailabilityWatcher = null;
    this.isScreenBeingShared = false;
    this.geometryFrozen = false; // A5 session-scoped freeze (de-0002, keyed on capture-active — L-0067 boundary)
    this.wasVisibleBeforeSharing = false;
    this.screenCaptureStatus = {
      available: null,
      lastError: null,
      lastCheckedAt: null
    };
    this.isCheckingScreenCaptureStatus = false;
    this.isInitialized = false;
    this.isInitializing = false;
    this.isRecording = false;
    
    // Add debouncing to prevent excessive operations
    this.lastEnforceTime = 0;
    this.enforceDebounceMs = 1000; // Only enforce once per second
    this.focusLocked = false; // Prevent focus loops

    // Event-driven Windows repair shortens topmost losses. Native hit testing
    // still catches brief cover by a competing window, so this is not a
    // guarantee of uninterrupted visibility or clicks.
    this._rootTopmostGuardsEnabled = false;
    this._topmostGuardStates = new Map();
    
    // Window binding properties
    this.bindWindows = true; // Enable window binding by default
    this.windowGap = 10; // Small gap between windows
    this.boundWindowsPosition = { x: 0, y: 0 }; // Track position of bound windows
    
    this.windowConfigs = {
      main: {
        width: 520,
        height: 35,
        useContentSize: true,
        file: 'index.html',
        title: 'Terminal'
      },
      chat: {
        width: 500,
        height: 700,
        file: 'chat.html',
        title: 'Chat'
      },
      llmResponse: {
        width: 840,
        height: 480,
        file: 'llm-response.html',
        title: 'AI Response',
        alwaysOnTop: true
      },
      settings: {
        width: 400,
        height: 380,
        file: 'settings.html',
        title: 'Settings',
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        fullscreenable: false
      },
      materials: {width:620,height:740,file:'materials.html',title:'Session materials'},
      onboarding: {
        width: 560,
        height: 680,
        file: 'onboarding.html',
        title: 'Welcome',
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        skipTaskbar: process.platform === 'darwin',
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        fullscreenable: false
      }
    };

    this.init();
  }

  init() {
    // ... existing initialization code ...
  }

  async initializeWindows(options = {}) {
    const { showMainWindow = true } = options;
    if (this.isInitialized || this.isInitializing) {
      logger.warn('Windows already initialized or initializing');
      return;
    }

    this.isInitializing = true;
    logger.info('Initializing application windows', { showMainWindow });
    
    try {
      // Pass autoShow so the main window doesn't flash visible during
      // first-run onboarding before the user has configured API keys.
      await this.createMainWindow({ autoShow: showMainWindow });
      await this.createChatWindow();
      await this.createLLMResponseWindow();
      await this.createSettingsWindow();
      
      this.setupWindowEventHandlers();
      this.setupScreenTracking();
      // Screen enumeration may prompt for access. Only explicit capture actions
      // should use it; startup and text-only setup must remain permission-free.

      // Make windows interactive by default so they are not click-through
      this.setInteractive(true);
      
      // Optionally show the main window (deferred during onboarding)
      if (showMainWindow) {
        await this.showMainWindow();
      }
      
      this.isInitialized = true;
      this.isInitializing = false;
      logger.info('All windows initialized successfully');
    } catch (error) {
      this.isInitializing = false;
      logger.error('Failed to initialize windows', { error: error.message });
      throw error;
    }
  }

  async showMainWindow() {
    const mainWindow = this.windows.get('main');
    if (!mainWindow) return;
    this._ensureDesiredVisibility().set('main', true);
    
    // Immediate always-on-top enforcement for main window
    if (process.platform === 'darwin') {
      try {
        mainWindow.setAlwaysOnTop(true, 'floating', 2);
      } catch (error) {
        this.setWindowAlwaysOnTop(mainWindow);
      }
    } else {
      this.setWindowAlwaysOnTop(mainWindow);
    }
    
    // Wait for app to fully initialize and detect current desktop
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!this.isWindowDesiredVisible('main') || this.isScreenBeingShared || mainWindow.isDestroyed()) return;
    this.showOnCurrentDesktop(mainWindow);
    
    // Additional enforcement after showing
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!this.isWindowDesiredVisible('main') || this.isScreenBeingShared || mainWindow.isDestroyed()) return;
    if (process.platform === 'darwin') {
      try {
        mainWindow.setAlwaysOnTop(true, 'floating', 2);
      } catch (error) {
        this.setWindowAlwaysOnTop(mainWindow);
      }
    } else {
      this.setWindowAlwaysOnTop(mainWindow);
    }
    
    this.isVisible = true;
    logger.info('Main window displayed');
    // Notify renderer to refresh speech availability
    mainWindow.webContents.send('main-window-shown', {});
  }

  async createMainWindow(options = {}) {
    const { autoShow = true } = options;
    if (autoShow) this._ensureDesiredVisibility().set('main', true);
    if (this.windows.has('main')) {
      return this.windows.get('main');
    }
    const window = await this.createWindow('main', false); // Don't show during creation
    this.windows.set('main', window);

    // Always-on-top must be set even when we're deferring the visual
    // show — it persists into the future showOnCurrentDesktop call.
    if (process.platform === 'darwin') {
      try {
        window.setAlwaysOnTop(true, 'floating', 2);
      } catch (error) {
        this.setWindowAlwaysOnTop(window);
      }
    } else {
      this.setWindowAlwaysOnTop(window);
    }

    // Only auto-show when explicitly allowed (e.g. not during first-run
    // onboarding). The single entry point for showing the overlay is
    // `showMainWindow()` — callers control timing via the flag below.
    if (autoShow) {
      // Wait for app to fully initialize and detect current desktop
      setTimeout(() => {
        if (!this.isWindowDesiredVisible('main') || this.isScreenBeingShared) return;
        this.showOnCurrentDesktop(window);
        // Additional enforcement after showing
        setTimeout(() => {
          if (!window.isDestroyed() && this.isWindowDesiredVisible('main') && !this.isScreenBeingShared) {
            if (process.platform === 'darwin') {
              try {
                window.setAlwaysOnTop(true, 'floating', 2);
              } catch (error) {
                this.setWindowAlwaysOnTop(window);
              }
            } else {
              this.setWindowAlwaysOnTop(window);
            }
          }
        }, 200);
      }, 100);
    }

    return window;
  }

  async createChatWindow() {
    if (this.windows.has('chat')) {
      return this.windows.get('chat');
    }
    const window = await this.createWindow('chat');
    this.windows.set('chat', window);
    window.hide();
    return window;
  }

  async createLLMResponseWindow() {
    if (this.windows.has('llmResponse')) {
      return this.windows.get('llmResponse');
    }
    const window = await this.createWindow('llmResponse');
    this.windows.set('llmResponse', window);
    
    // Add console message listener to see renderer logs in main process
    window.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (message.includes('LLM-RESPONSE')) {
        logger.info(`[RENDERER] ${message}`);
      }
    });
    
    window.hide();
    return window;
  }

  async createSettingsWindow() {
    if (this.windows.has('settings')) {
      return this.windows.get('settings');
    }
    const window = await this.createWindow('settings');
    this.windows.set('settings', window);
    window.hide();
    return window;
  }

  async createWindow(type, showOnCreate = false) {
    const windowConfig = this.windowConfigs[type];
    if (!windowConfig) {
      throw new Error(`Unknown window type: ${type}`);
    }

    // Base options
    const baseOptions = {
      width: windowConfig.width,
      height: windowConfig.height,
      webPreferences: {
        ...config.get('window.webPreferences'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        devTools: true, // Enable DevTools for debugging
      },
      show: false, // Never show during creation, use showOnCurrentDesktop instead
      title: windowConfig.title,
      skipTaskbar: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      fullscreenable: false,
      // Platform-specific always-on-top settings
      ...(process.platform === 'darwin' && {
        level: 'floating' // Start with floating level for macOS
      })
    };

    // Type-specific window configurations
    let browserWindowOptions;
    
    if (type === 'settings') {
      // Completely minimal settings window - no decorations at all
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        level: process.platform === 'darwin' ? 'floating' : undefined,
        // Additional macOS flags for better always-on-top behavior
        ...(process.platform === 'darwin' && {
          type: 'panel',
          // Never take keyboard focus: clicking Settings must not make it the
          // key window and blur the proctored page. Typing into Settings goes
          // through the keystroke-capture mode (see main.js capture helper).
          focusable: false,
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        })
      };
  } else if ((type === 'onboarding' || type === 'materials')) {
      // First-run onboarding wizard — same frameless/panel style as
      // settings, with visible renderer controls and native minimize support.
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: false,
        resizable: false,
        minimizable: true,
        maximizable: false,
        closable: true,
        hasShadow: true,
        backgroundColor: '#151923',
        skipTaskbar: process.platform === 'darwin',
        level: process.platform === 'darwin' ? 'floating' : undefined,
        ...(process.platform === 'darwin' && {
          type: 'panel',
          // Same as settings: clicks must never make the wizard key and blur
          // the proctored page; typing flows through keystroke-capture mode.
          focusable: false,
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        })
      };
  } else if (type === 'main') {
      // Main window configuration - fit to content, completely frameless
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: false,
        transparent: true,
        backgroundColor: '#00000000',
  // Allow resizing so users can adjust width; we will lock height in handlers
  resizable: true,
    // Keep the original max width as cap; allow small min width so it can collapse to one icon
    minWidth: 60,
    maxWidth: this.windowConfigs.main.width,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        useContentSize: windowConfig.useContentSize || false,
        thickFrame: false,
        focusable: process.platform === 'win32', // Original Windows toolbar accepts focus from an explicit user show
        ...(process.platform === 'darwin' && {
          type: 'panel', // Non-activating panel: clicks never activate the app
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'llmResponse') {
      // LLM Response window - completely frameless, just content
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        backgroundColor: '#00000000',
        resizable: true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        thickFrame: false,
        focusable: false, // Read-only display: never steal keyboard focus
        ...(process.platform === 'darwin' && {
          type: 'panel', // Non-activating panel: clicks never activate the app
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'chat') {
      // Chat window - frameless without window controls
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: true,
        ...(process.platform === 'darwin' && {
          // Non-activating panel: clicking chat must not activate the app.
          // A regular window click activates even an accessory app and
          // would blur the proctored page. focusable:false goes further:
          // the chat window can NEVER become the key window, so no click
          // can ever transfer keyboard focus away from the proctored page.
          // Typing reaches chat exclusively through keystroke-capture mode
          // (global hotkey → event tap → sendInputEvent), never via key
          // status.
          type: 'panel',
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          focusable: false,
          acceptFirstMouse: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else {
      // Other windows (skills)
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: true,
        titleBarStyle: 'default',
        transparent: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        closable: true,
        hasShadow: true,
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    }

    // Windows-specific settings
    if (process.platform === 'win32') {
      browserWindowOptions = {
        ...browserWindowOptions,
        parent: null,
        modal: false,
        thickFrame: false,
      };
    }

    browserWindowOptions.kiosk = false;
    browserWindowOptions.simpleFullscreen = false;

  const window = new BrowserWindow(browserWindowOptions);

    // Windows created after root-mode guards are enabled (settings, llmResponse,
    // onboarding) get the same demotion protection as main/chat.
    if (this._rootTopmostGuardsEnabled) {
      this.installTopmostGuard(type, window);
    }

    // External links (GitHub, the website, Google AI Studio, etc.) must open in
    // the user's real browser, never inside the frameless overlay windows.
    // Deny any in-app window.open and hand http(s) URLs to the OS browser, and
    // block the current window from navigating away to an external site.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (/^https?:\/\//i.test(url) && url !== window.webContents.getURL()) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

  // Load the HTML file
    await window.loadFile(windowConfig.file);
    
  // Position the window
    this.positionWindow(window, type);
    
  // Apply simplified stealth measures
    this.applyStealthMeasures(window, type);
    
  // Initialize interaction mode based on current state for ALL windows
    if (this.isInteractive) {
      window.setIgnoreMouseEvents(false);
    } else {
      window.setIgnoreMouseEvents(true, { forward: true });
    }

    // Horizontal-only resize behavior for main overlay window
    if (type === 'main') {
      try {
        // Small practical minimum width so it can collapse to roughly one icon width
        // Height is managed dynamically; don't lock here to allow programmatic changes
        if (typeof window.setMinimumSize === 'function') {
          // Set a conservative minimum width; height will be adjusted via IPC as needed
          window.setMinimumSize(60, windowConfig.height);
        }

        // Intercept user-initiated resizes to lock height and allow width changes only
        window.on('will-resize', (event, newBounds) => {
          try {
            // Keep current content height; only apply the new width
            const [_, currentContentHeight] = window.getContentSize();
            event.preventDefault();
            // Enforce width within min/max bounds
            const minW = 60;
            const maxW = this.windowConfigs.main.width;
            const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
            window.setContentSize(desiredW, Math.max(1, currentContentHeight));
          } catch (e) {
            // Fallback: lock window height using window size
            try {
              const [__w, currentWindowHeight] = window.getSize();
              event.preventDefault();
              const minW = 60;
              const maxW = this.windowConfigs.main.width;
              const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
              window.setSize(desiredW, Math.max(1, currentWindowHeight));
            } catch { /* noop */ }
          }
        });

        // Windows content resizing must preserve the user's placement. A move
        // can emit resize events at fractional DPI, so never restart top layout.
        window.on('resize', () => {
          if (this.bindWindows) {
            if (process.platform === 'win32') this.moveBoundWindows(0, 0);
            else this.positionBoundWindows();
          }
        });
      } catch { /* ignore */ }
    }
    
    // Show window on current desktop if requested
    if (showOnCreate) {
      this.showOnCurrentDesktop(window);
    }

    logger.debug('Window created successfully', {
      type,
      title: windowConfig.title,
      dimensions: `${windowConfig.width}x${windowConfig.height}`,
      showOnCreate: showOnCreate
    });

    return window;
  }

  applyStealthMeasures(window, type) {
    // Enhanced always-on-top enforcement for all platforms
    if (process.platform === 'darwin') {
      // macOS: Use native window level constants for maximum effectiveness
      try {
        // Try the most aggressive levels first
        const levels = [
          'floating',        // Preferred: above normal apps, below screen-saver
          'pop-up-menu',     // Menu level
          'modal-panel',     // Modal panel level
          'normal'           // Fallback to normal with alwaysOnTop
        ];
        
        let levelSet = false;
        for (const level of levels) {
          try {
            window.setAlwaysOnTop(true, level, 1);
            levelSet = true;
            logger.debug(`Successfully set always-on-top with level: ${level}`, { type });
            break;
          } catch (levelError) {
            logger.debug(`Failed to set level: ${level}`, { error: levelError.message });
          }
        }
        
        if (!levelSet) {
          // Final fallback
          this.setWindowAlwaysOnTop(window);
        }
        
        // Additional macOS-specific enforcement
        setTimeout(() => {
          if (!window.isDestroyed()) {
            try {
              // Force re-application of always-on-top
              window.setAlwaysOnTop(false);
              setTimeout(() => {
                if (!window.isDestroyed()) {
                  window.setAlwaysOnTop(true, 'floating', 1);
                }
              }, 50);
            } catch (error) {
              logger.warn('Error in macOS re-enforcement', { error: error.message });
            }
          }
        }, 200);
        
      } catch (error) {
        logger.warn('Error setting always-on-top for macOS', { error: error.message });
        // Absolute fallback
        this.setWindowAlwaysOnTop(window);
      }
    } else if (process.platform === 'win32') {
      // Windows: Multiple enforcement attempts
      this.setWindowAlwaysOnTop(window);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          this.setWindowAlwaysOnTop(window);
        }
      }, 100);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          this.setWindowAlwaysOnTop(window);
        }
      }, 500);
      
    } else {
      // Linux and other platforms
      this.setWindowAlwaysOnTop(window);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          this.setWindowAlwaysOnTop(window);
        }
      }, 100);
    }

    // Ensure window appears on all workspaces/desktops initially.
    // skipTransformProcessType: the app runs under the accessory activation
    // policy (see main.js); without this flag Electron flips the process
    // between UIElement and Foreground on every call, which would silently
    // undo the accessory policy and show a Dock icon.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    
    // Keep setup reachable in the taskbar after native minimization.
    const skipTaskbar = type !== 'onboarding' || process.platform === 'darwin';
    window.setSkipTaskbar(skipTaskbar);
    
    // Make window undetectable by screen capture (if supported)
    try {
      window.setContentProtection(true);
      if (process.platform === 'linux' && !this._warnedNoContentProtection) {
        this._warnedNoContentProtection = true;
        logger.warn('Screen-capture protection is unavailable on Linux (Electron limitation). The overlay WILL be visible in screen shares. This stealth feature only works on macOS and Windows.');
      }
    } catch (error) {
      logger.debug('Content protection not supported on this platform');
    }
    
    // More aggressive event listeners to maintain always-on-top behavior
    const enforceAlwaysOnTop = () => {
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Single assertion at 'floating': above normal windows without
            // the screen-saver level churn that occludes other apps.
            window.setAlwaysOnTop(true, 'floating', 1);
          } else {
            this.setWindowAlwaysOnTop(window);
          }
        } catch (error) {
          logger.debug('Error in enforceAlwaysOnTop', { error: error.message });
        }
      }
    };
    
    // Event-based enforcement
    // NOTE: no 'blur' re-assertion here — re-asserting on blur fights the
    // OS window manager and aggravates focus churn on the proctored page.
    window.on('show', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
    });
    
    window.on('focus', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    window.on('restore', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    // NOTE: the periodic 3-second always-on-top re-assertion was removed —
    // constant level churn triggers occlusion/visibility detection in other
    // apps (the proctored page reported visibilitychange: hidden). The level
    // is set once at creation and re-asserted only on show/restore/focus.
    logger.debug('Applied enhanced stealth measures with aggressive always-on-top', {
      type,
      platform: process.platform,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar
    });
  }

  positionWindow(window, type) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;

    if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
      // Position bound windows together
      this.positionBoundWindows();
      return;
    }

    if (type === 'adjacent-to-test') {
      // Position the overlay directly beside the test window to minimize eye movement.
      // Detect the test window via cursor position or active display.
      const cursorPoint = screen.getCursorScreenPoint();
      const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint);
      const { x: cDisplayX, y: cDisplayY, width: cScreenWidth, height: cScreenHeight } = cursorDisplay.workArea;

      const [windowWidth, windowHeight] = window.getSize();

      // Place overlay on the right side of the screen, vertically centered
      const position = {
        x: cDisplayX + cScreenWidth - windowWidth - 20,
        y: cDisplayY + Math.round((cScreenHeight - windowHeight) / 2)
      };

      window.setPosition(position.x, position.y);

      logger.debug('Positioned window adjacent to test', {
        type,
        position: `${position.x},${position.y}`,
        display: cursorDisplay.id || 'primary'
      });
      return;
    }

    // All windows positioned at top of screen with small margin
    const topMargin = 20;
    const [windowWidth] = window.getSize();

    const positions = {
      main: { x: displayX + 50, y: displayY + topMargin },
      chat: { x: displayX + screenWidth - windowWidth - 50, y: displayY + topMargin },
      llmResponse: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin },
      settings: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin }
    };

    const position = positions[type] || { x: displayX + 100, y: displayY + topMargin };
    window.setPosition(position.x, position.y);
    
    logger.debug('Positioned window at top', {
      type,
      position: `${position.x},${position.y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  // New method to position bound windows (vertical column layout) - Always at top
  positionBoundWindows() {
    if (this.geometryFrozen) return; // A5: no geometry mutation during capture
    const mainWindow = this.windows.get('main');
    const llmWindow = this.windows.get('llmResponse');
    
    if (!mainWindow || !llmWindow) return;
    
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;
    
    const [mainWidth, mainHeight] = mainWindow.getSize();
    const [llmWidth, llmHeight] = llmWindow.getSize();
    
    // Always position at the top of the screen with small margin
    const topMargin = 20;
    const startY = displayY + topMargin;
    
    // Use the wider window for horizontal centering
    const maxWidth = Math.max(mainWidth, llmWidth);
    
    // Center horizontally on the display
    const xPosition = displayX + Math.round((screenWidth - maxWidth) / 2);
    
    // Ensure windows don't go outside screen bounds horizontally
    const adjustedMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, xPosition));
    const adjustedLlmX = Math.max(displayX, Math.min(displayX + screenWidth - llmWidth, xPosition));
    
    // Position main window (top)
    const mainX = adjustedMainX;
    const mainY = startY;
    mainWindow.setPosition(mainX, mainY);
    
    // Position LLM response window below with gap
    const llmX = adjustedLlmX;
    const llmY = startY + mainHeight + this.windowGap;
    llmWindow.setPosition(llmX, llmY);
    
    // Update stored position (use main window position as reference)
    this.boundWindowsPosition = { x: adjustedMainX, y: startY };
    
    logger.debug('Positioned bound windows at top (column layout)', {
      mainPosition: `${mainX},${mainY}`,
      llmPosition: `${llmX},${llmY}`,
      gap: this.windowGap,
      topMargin: topMargin,
      display: display.id
    });
  }

  // New method to move bound windows (column layout) - Maintains top positioning preference
  moveBoundWindows(deltaX, deltaY) {
    if (!this.bindWindows || this.geometryFrozen) return;
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    if (process.platform === 'win32') {
      if (this._windowsMovementDisposed) return;
      // A resize callback during a native move must not enqueue another clamp.
      if (this._movingBoundWindows && deltaX === 0 && deltaY === 0) return;
      return this.queueWindowsMove(deltaX, deltaY);
    }
    if (this._movingBoundWindows) return;
    
    const mainWindow = this.windows.get('main');
    const llmWindow = this.windows.get('llmResponse');
    
    if (!mainWindow || !llmWindow) return;
    
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;
    
    // Get current positions and sizes
    const [mainX, mainY] = mainWindow.getPosition();
    const [llmX, llmY] = llmWindow.getPosition();
    const [mainWidth, mainHeight] = mainWindow.getSize();
    const [llmWidth, llmHeight] = llmWindow.getSize();
    
    // Calculate total height for bounds checking
    const totalHeight = mainHeight + this.windowGap + llmHeight;
    const topMargin = 20;
    const minY = displayY + topMargin;
    
    // Calculate new positions with bounds checking
    const newMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, mainX + deltaX));
    // Ensure we don't go above the top margin or below screen bounds
    const newMainY = Math.max(minY, Math.min(displayY + screenHeight - totalHeight, mainY + deltaY));
    
    // LLM window follows the same horizontal movement but maintains vertical relationship
    const newLlmX = Math.max(displayX, Math.min(displayX + screenWidth - llmWidth, llmX + deltaX));
    const newLlmY = newMainY + mainHeight + this.windowGap;
    
    // Move both windows
    mainWindow.setPosition(newMainX, newMainY);
    llmWindow.setPosition(newLlmX, newLlmY);
    
    // Update stored position (use main window as reference)
    this.boundWindowsPosition.x = newMainX;
    this.boundWindowsPosition.y = newMainY;
    
    logger.debug('Moved bound windows (maintaining top preference)', {
      delta: `${deltaX},${deltaY}`,
      newMainPosition: `${newMainX},${newMainY}`,
      newLlmPosition: `${newLlmX},${newLlmY}`,
      topMargin: topMargin,
      totalHeight: totalHeight
    });
  }

  async getWindowsPositioner() {
    if (!this._windowsPositioner) {
      const WindowsWindowPositioner = require('../platform/windows/window-position');
      this._windowsPositioner = new WindowsWindowPositioner();
    }
    await this._windowsPositioner.ready();
    return this._windowsPositioner;
  }

  queueWindowsMove(deltaX, deltaY) {
    if ((this._queuedWindowsMoves || 0) >= 32) {
      logger.warn('Windows movement queue is full');
      return Promise.resolve();
    }
    this._queuedWindowsMoves = (this._queuedWindowsMoves || 0) + 1;
    const operation = (this._windowsMoveQueue || Promise.resolve()).then(async () => {
      if (!this.bindWindows || this.geometryFrozen || this._windowsMovementDisposed) return;
      const positioner = await this.getWindowsPositioner();
      // Startup may overlap capture, hiding, or shutdown. Read current state
      // after readiness and after earlier queued moves have actually completed.
      if (!this.bindWindows || this.geometryFrozen || this._windowsMovementDisposed) return;
      return this.moveVisibleBoundWindows(deltaX, deltaY, positioner);
    }).catch(error => {
      logger.warn('Windows window movement failed', { message: error.message });
    }).finally(() => { this._queuedWindowsMoves--; });
    this._windowsMoveQueue = operation;
    return operation;
  }

  async moveVisibleBoundWindows(deltaX, deltaY, positioner) {
    const windows = ['main', 'llmResponse']
      .map(type => this.windows.get(type))
      .filter(window => window && !window.isDestroyed() && window.isVisible());
    if (!windows.length) return;
    const area = (this.currentDisplay || screen.getPrimaryDisplay()).workArea;
    const bounds = windows.map(window => window.getBounds());
    const left = Math.min(...bounds.map(b => b.x));
    const top = Math.min(...bounds.map(b => b.y));
    const right = Math.max(...bounds.map(b => b.x + b.width));
    const bottom = Math.max(...bounds.map(b => b.y + b.height));
    // Clamp a shared translation, preserving each visible window's offset.
    // A hidden legacy answer panel must not constrain the visible toolbar.
    const dx = Math.max(area.x - left, Math.min(area.x + area.width - right, deltaX));
    const dy = Math.max(area.y + 20 - top, Math.min(area.y + area.height - bottom, deltaY));
    if (dx === 0 && dy === 0) return;
    this._movingBoundWindows = true;
    try {
      const targets = windows.map((window, index) => {
        const b = bounds[index];
        const nativeHandle = window.getNativeWindowHandle();
        const handle = nativeHandle.length === 8
          ? nativeHandle.readBigUInt64LE(0).toString()
          : nativeHandle.readUInt32LE(0).toString();
        const point = screen.dipToScreenPoint({ x: Math.round(b.x + dx), y: Math.round(b.y + dy) });
        return { handle, x: point.x, y: point.y };
      });
      await positioner.move(targets);
      const main = this.windows.get('main');
      if (main && !main.isDestroyed()) {
        const [x, y] = main.getPosition();
        this.boundWindowsPosition = { x, y };
      }
    } finally {
      this._movingBoundWindows = false;
    }
  }

  showOnCurrentDesktop(win) {
    if (!win || win.isDestroyed()) return;

    const llmWin = this.windows.get('llmResponse');
    const isLLM = llmWin && !llmWin.isDestroyed() && win.id === llmWin.id;

    if (process.platform === 'darwin') {
      // macOS: prevent space switching and keep visibility stable.
      // skipTransformProcessType keeps this call from flipping the app's
      // activation policy (UIElement <-> Foreground), which would undo the
      // accessory policy set at startup and briefly show a Dock icon.
      win.hide();
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });

      const setMacOSAlwaysOnTop = () => {
        if (win.isDestroyed()) return;
        try {
          win.setAlwaysOnTop(true, 'floating', 2);
        } catch {
          try { win.setAlwaysOnTop(true, 'pop-up-menu', 2); }
          catch { this.setWindowAlwaysOnTop(win); }
        }
      };

      setMacOSAlwaysOnTop();

      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.showInactive(); // Non-activating show: never steal focus
        setMacOSAlwaysOnTop();
        setTimeout(() => { if (!win.isDestroyed()) setMacOSAlwaysOnTop(); }, 100);
        // Keep LLM window visible across workspaces; others revert
        setTimeout(() => {
          if (win.isDestroyed()) return;
          if (!isLLM) {
            // NOTE: without skipTransformProcessType, this call transforms
            // the process to a Foreground app (Dock icon + activatable),
            // undoing the accessory activation policy.
            win.setVisibleOnAllWorkspaces(false, {
              skipTransformProcessType: true,
            });
          }
          setMacOSAlwaysOnTop();
        }, 300);
      }, 50);
    } else {
      // Linux/Windows
      try {
        win.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      } catch (error) {
        logger.warn('Could not move window to current desktop', { error: error.message });
      }
      try {
        this.setWindowAlwaysOnTop(win);
      } catch (error) {
        logger.warn('Could not keep window on top', { error: error.message });
      }
      win.showInactive(); // Non-activating show: never steal focus
      if (process.platform === 'win32') {
        // Re-front within the topmost band without activation or repaint.
        // On Windows the topmost band is SHARED: another topmost app (the
        // exam browser) covers us simply by re-fronting itself, and
        // showInactive() on an already-visible window does NOT change
        // z-order. moveTop() = SetWindowPos(HWND_TOPMOST, NOMOVE|NOSIZE|
        // NOACTIVATE): instant, flicker-free, focus-preserving (validated by
        // tests/kill-matrix/windows/system-band-probe.ps1).
        try {
          win.moveTop();
        } catch (error) {
          logger.warn('Could not re-front window in topmost band', { error: error.message });
        }
      }
      setTimeout(() => {
        if (win.isDestroyed()) return;
        if (!isLLM) {
          try {
            win.setVisibleOnAllWorkspaces(false, {
              skipTransformProcessType: true,
            });
          } catch (error) {
            logger.warn('Could not finish desktop switch', { error: error.message });
          }
        }
        try {
          this.setWindowAlwaysOnTop(win);
        } catch (error) {
          logger.warn('Could not keep window on top after show', { error: error.message });
        }
      }, 500);
    }

    logger.debug('Showing window on current desktop with enhanced always-on-top', {
      platform: process.platform,
      windowId: win.id,
      isDestroyed: win.isDestroyed()
    });
  }

  // NOTE: no accessory<->regular activation toggle is used here. Every
  // overlay window is a non-activating panel (or focusable:false) and the
  // app runs under the accessory policy set in main.js; panels accept
  // keyboard input by becoming key WITHOUT activating the app, so no
  // policy switch is ever needed. A toggle would only add dock-icon
  // flicker and a "stuck in regular" failure mode.
  
  setupWindowEventHandlers() {
    this.windows.forEach((window, type) => {
      window.on('closed', () => {
        logger.debug('Window closed', { type });
        this.windows.delete(type);
      });

      window.on('focus', () => {
        this.activeWindow = type;
        logger.debug('Window focused', { type });
      });

      // SIMPLIFIED blur handler - no aggressive re-focusing
      window.on('blur', () => {
        // Only log, don't force focus back
        logger.debug('Window blurred', { type });
      });

      window.on('show', () => {
        logger.debug('Window shown', { type });
      });

      window.on('hide', () => {
        logger.debug('Window hidden', { type });
      });

      // Handle window minimize attempts
      window.on('minimize', (event) => {
        if (type !== 'onboarding') {
          event.preventDefault();
          logger.debug('Prevented window minimize', { type });
        }
      });

      // WM_CLOSE is on UIPI's benign message allowlist, so even a lower-
      // integrity process can POST it to these windows (validated by the
      // system-band probe). The overlays are closable:false; the quit path
      // flips setClosable(true) right before app.quit(), so closable doubles
      // as the quit signal here: refuse external closes, allow the real quit.
      window.on('close', (event) => {
        if (!window.isClosable()) {
          event.preventDefault();
          logger.warn('Prevented external close request', { type });
        }
      });

      window.on('restore', () => {
        // Simplified restore handling
        logger.debug('Window restored', { type });
      });
    });
  }

  setupScreenCaptureAvailabilityWatcher() {
    // Avoid screencast portal errors on Linux/Wayland by disabling periodic detection
    if (process.platform === 'linux') {
      logger.info('Skipping screen capture availability watcher on Linux to avoid portal screencast errors');
      return;
    }

    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
    }

    // This is only a capture availability probe. desktopCapturer.getSources()
    // cannot tell whether another app is currently sharing the screen.
    this.screenCaptureAvailabilityWatcher = setInterval(async () => {
      await this.checkScreenCaptureAvailability();
    }, 5000); // Check every 5 seconds instead of 1

    logger.info('Screen capture availability watcher initialized');
  }

  // Exam mode must silence the Brain's own SCK enumeration: each
  // desktopCapturer.getSources() call is capture-class activity, and the
  // incident doc explicitly demands the 5 s watcher be disabled during exams
  // ("constant SCK enumeration = repeated trigger opportunity" —
  // INCIDENT-2026-09-19-135148). The shield does all exam capture; the Brain
  // must go quiet. Called by enterShieldExamMode on arm/restore.
  pauseScreenCaptureAvailabilityWatcher() {
    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
      this.screenCaptureAvailabilityWatcher = null;
      logger.info('Screen capture availability watcher paused (exam mode)');
    }
  }

  resumeScreenCaptureAvailabilityWatcher() {
    if (!this.screenCaptureAvailabilityWatcher) {
      this.setupScreenCaptureAvailabilityWatcher();
      logger.info('Screen capture availability watcher resumed');
    }
  }

  async checkScreenCaptureAvailability() {
    if (this.isCheckingScreenCaptureStatus) {
      logger.debug('Skipping overlapping screen capture availability check');
      return;
    }

    this.isCheckingScreenCaptureStatus = true;
    const previousAvailability = this.screenCaptureStatus.available;
    const checkedAt = new Date().toISOString();

    try {
      await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1, height: 1 }
      });

      this.screenCaptureStatus = {
        available: true,
        lastError: null,
        lastCheckedAt: checkedAt
      };

      if (previousAvailability === false) {
        logger.info('Screen capture enumeration recovered');
      }
    } catch (error) {
      this.screenCaptureStatus = {
        available: false,
        lastError: error.message,
        lastCheckedAt: checkedAt
      };

      const logContext = {
        error: error.message,
        isScreenBeingShared: this.isScreenBeingShared
      };

      if (previousAvailability === false) {
        logger.debug('Screen capture enumeration still unavailable', logContext);
      } else {
        logger.warn('Screen capture enumeration unavailable; leaving screen sharing mode unchanged', logContext);
      }
    } finally {
      this.isCheckingScreenCaptureStatus = false;
    }
  }

  startScreenSharingMode() {
    if (!this.isScreenBeingShared) {
      this.isScreenBeingShared = true;
      this.wasVisibleBeforeSharing = this.isVisible;
      this.handleScreenSharingStarted();
    }
  }

  /**
   * de-0002 Q080 fold: set ONLY the share GUARD flag — the four visibility
   * guards (llm panel / settings / onboarding shows) fire, but the hide-all
   * screen-share flow does NOT run. Wired to capture mode in main.js.
   */
  setScreenBeingShared(value) {
    if (this.isScreenBeingShared !== Boolean(value)) {
      this.isScreenBeingShared = Boolean(value);
      logger.info('Screen-share guard flag set from capture mode', { isScreenBeingShared: this.isScreenBeingShared });
    }
  }

  /**
   * de-0002 A5/Q076(6): the geometry freeze suppresses ALL window geometry
   * mutation while a session is active (implemented keyed on capture-active;
   * boundary named in L-0067). Gates positionBoundWindows / centerWindow /
   * expandLLMWindow.
   */
  setGeometryFrozen(value) {
    if (this.geometryFrozen !== Boolean(value)) {
      this.geometryFrozen = Boolean(value);
      logger.info('Geometry freeze toggled', { geometryFrozen: this.geometryFrozen });
    }
  }

  stopScreenSharingMode() {
    if (this.isScreenBeingShared) {
      this.isScreenBeingShared = false;
      this.handleScreenSharingStopped();
    }
  }

  handleScreenSharingStarted() {
    logger.info('Screen sharing mode enabled - hiding windows');
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.hide();
        window.setPosition(-10000, -10000);
      }
    });
  }

  handleScreenSharingStopped() {
    logger.info('Screen sharing mode disabled - restoring windows');
    
    if (this.wasVisibleBeforeSharing) {
      this.moveWindowsToActiveScreen();
      this.showAllWindows();
    }
  }

  switchToWindow(windowType) {
    if (!this.windowConfigs[windowType]) {
      logger.warn('Attempted to switch to unknown window type', { windowType });
      return;
    }

    if (this.isScreenBeingShared) {
      return;
    }

    const targetWindow = this.windows.get(windowType);
    // OpenCluely's chat shortcut is a toggle independent of the main toolbar.
    if (windowType === 'chat' && targetWindow && !targetWindow.isDestroyed() && targetWindow.isVisible()) {
      this.hideChatWindow();
      return;
    }
    if (windowType === 'main' || windowType === 'chat') {
      this._ensureDesiredVisibility().set(windowType, true);
    }
    if (!targetWindow || targetWindow.isDestroyed()) {
      // A stale destroyed entry must not make an explicit open a no-op.
      this.ensureWindow(windowType);
      this.activeWindow = windowType;
      return;
    }
    if (targetWindow && !targetWindow.isDestroyed()) {
      const chatWindow = this.windows.get('chat');
      if (windowType !== 'chat' && chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
        this.hideChatWindow();
      }
      this.showOnCurrentDesktop(targetWindow);
      if (process.platform === 'win32' && this.isInteractive && targetWindow.isVisible()) {
        targetWindow.focus();
      }

      this.activeWindow = windowType;
      
      logger.info('Switched to window', {
        windowType,
        isVisible: this.isVisible
      });
    }
  }

  showAllWindows() {
    if (this.isScreenBeingShared) {
      return;
    }

    for (const type of ['main', 'chat']) {
      this._ensureDesiredVisibility().set(type, true);
      const window = this.windows.get(type);
      if (!window || window.isDestroyed()) this.ensureWindow(type);
    }
    this.windows.forEach((window, type) => {
      if (window.isDestroyed()) return;
      if (type !== 'llmResponse') { // Don't show LLM response unless it has content
        this.showOnCurrentDesktop(window);
      }
    });
    
    this._visibilityIntentEpoch = (this._visibilityIntentEpoch || 0) + 1;
    this._lastVisibilityShowEpoch = this._visibilityIntentEpoch;
    this.isVisible = true;
    // NOTE: no .focus() here — focusing would steal focus from the
    // proctored page. Windows are shown with showInactive() above.
    
    logger.info('All windows shown on current desktop', { 
      activeWindow: this.activeWindow,
      windowCount: this.windows.size 
    });
  }

  hideAllWindows() {
    // Legacy shape: hide everything except the answer panel, which is only
    // shown transiently when content arrives. Exam mode now calls
    // hideAllWindowsExcept(["chat"]) instead — the chat is the surface.
    this.hideAllWindowsExcept(['llmResponse']);
  }

  // Hide every window whose type is NOT in `keepTypes`. Exam mode calls this
  // with keepTypes=["chat"] so the Cluely chat UI stays visible as the single
  // answer surface while the overlay/settings/answer panel are hidden.
  hideAllWindowsExcept(keepTypes = []) {
    if (!keepTypes.includes('chat')) this.chatHideVersion += 1;
    for (const type of ['main', 'chat']) {
      this._ensureDesiredVisibility().set(type, keepTypes.includes(type));
    }
    this.windows.forEach((window, type) => {
      if (window.isDestroyed()) return;
      if (!keepTypes.includes(type)) {
        window.hide();
      }
    });

    this.recordVisibilityHide();
    this.isVisible = false;
    logger.info('All windows hidden except', { keepTypes });
  }

  _ensureDesiredVisibility() {
    // Lazy init keeps vm-sandboxed instances (which skip the constructor)
    // working: intent tracking simply starts empty.
    if (!this.desiredWindowVisibility) this.desiredWindowVisibility = new Map();
    return this.desiredWindowVisibility;
  }

  isWindowDesiredVisible(type) {
    return this._ensureDesiredVisibility().get(type) === true;
  }

  recordVisibilityHide() {
    // A delayed answer may update hidden content, but not reverse a user hide.
    this._visibilityIntentEpoch = (this._visibilityIntentEpoch || 0) + 1;
    this._lastVisibilityHideEpoch = this._visibilityIntentEpoch;
  }

  getVisibilityHideEpoch() {
    return this._lastVisibilityHideEpoch || 0;
  }

  shouldRevealAnswerSince(hideEpoch) {
    const lastHide = this.getVisibilityHideEpoch();
    return lastHide === hideEpoch || (this._lastVisibilityShowEpoch || 0) > lastHide;
  }

  hasVisibleWindows() {
    return Array.from(this.windows.values()).some(window =>
      window && !window.isDestroyed() && window.isVisible());
  }

  toggleVisibility() {
    if (this.isScreenBeingShared) {
      return this.isVisible;
    }

    // Capture and answer delivery can reveal a window without changing isVisible.
    // Toggle the windows the user can actually see, not a stale group flag.
    if (process.platform === 'win32' ? this.hasVisibleWindows() : this.isVisible) {
      this.hideAllWindowsExcept([]);
    } else {
      this.showAllWindows();
      if (process.platform === 'win32' && this.isInteractive) {
        const active = this.windows.get(this.activeWindow);
        if (active && !active.isDestroyed() && active.isVisible()) active.focus();
      }
    }
    
    return this.isVisible;
  }

  // Recreate a missing core window. Creation is async, so the user's latest
  // visibility choice must be checked after it finishes.
  ensureWindow(type) {
    const existing = this.windows.get(type);
    if (existing && !existing.isDestroyed()) return existing;
    if (this._windowCreationPromises && this._windowCreationPromises.has(type)) return null;
    this.windows.delete(type);
    const map = this._windowCreationPromises || (this._windowCreationPromises = new Map());
    logger.warn('Root visibility recreating externally destroyed window', { type });
    const promise = (type === 'main'
      ? this.createMainWindow({ autoShow: false })
      : this.createChatWindow()
    ).then((window) => {
      if (window && !window.isDestroyed()) {
        window.on('closed', () => {
          if (this.windows.get(type) === window) this.windows.delete(type);
        });
        if (!this.isInteractive) window.setIgnoreMouseEvents(true, { forward: true });
        if (this.isWindowDesiredVisible(type) && !this.isScreenBeingShared) {
          this.showOnCurrentDesktop(window);
        }
        logger.info('Root visibility window recreated', { type });
      }
      return window;
    }).catch((error) => {
      logger.warn('Root visibility window recreation failed', { type, error: error.message });
      return null;
    }).finally(() => {
      map.delete(type);
    });
    map.set(type, promise);
    return null;
  }

  setInteractive(interactive) {
    this.isInteractive = interactive;
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        if (interactive) {
          // Interactive mode: allow mouse events for all windows
          window.setIgnoreMouseEvents(false);
        } else {
          // Non-interactive mode: enable click-through with forwarding for all windows
          window.setIgnoreMouseEvents(true, { forward: true });
        }
        window.webContents.send('interaction-mode-changed', interactive);
      }
    });
    
    logger.info('Window interaction mode changed', { 
      interactive,
      clickThrough: !interactive,
      affectedWindows: Array.from(this.windows.keys())
    });
  }

  toggleInteraction() {
    this.setInteractive(!this.isInteractive);
    
    // Ensure all windows remain always-on-top after interaction mode change
    this.enforceAlwaysOnTopForAllWindows();
    
    return this.isInteractive;
  }

  setWindowAlwaysOnTop(window) {
    // Electron's default floating level reorders behind the Windows taskbar.
    // The explicit popup level preserves native topmost state on Windows.
    if (process.platform === 'win32') window.setAlwaysOnTop(true, 'pop-up-menu');
    else window.setAlwaysOnTop(true);
  }

  // Root exam mode (win32): install event-driven topmost guards on the live
  // windows. The exam app strips WS_EX_TOPMOST ~1 Hz; the 500 ms snapshot +
  // 2 s repair loop can only re-fight after the window already dropped below
  // the exam. These hooks shorten recovery after native demotion messages;
  // they cannot prevent a competing window from briefly taking focus/clicks.
  enableRootTopmostGuards() {
    if (process.platform !== 'win32' || this._rootTopmostGuardsEnabled) return;
    this._rootTopmostGuardsEnabled = true;
    for (const type of ['main', 'chat']) {
      const window = this.windows.get(type);
      if (window && !window.isDestroyed()) this.installTopmostGuard(type, window);
    }
  }

  installTopmostGuard(type, window) {
    if (process.platform !== 'win32' || !window || window.isDestroyed()) return;
    if (typeof window.hookWindowMessage !== 'function') {
      logger.warn('Root visibility topmost guard unavailable', { type });
      return;
    }
    let state = this._topmostGuardStates.get(type);
    if (!state) {
      state = { lastAt: 0, blocks: 0, lastBlockLogAt: 0, reasserting: false };
      this._topmostGuardStates.set(type, state);
    }

    const noteBlocked = (method) => {
      state.blocks += 1;
      const now = Date.now();
      if (state.blocks === 1 || now - state.lastBlockLogAt >= TOPMOST_GUARD_BLOCK_LOG_INTERVAL_MS) {
        state.lastBlockLogAt = now;
        logger.info('Root visibility topmost guard blocked demotion', { type, method, totalBlocks: state.blocks });
      }
    };

    // Repair only when Windows actually removed our topmost status.
    const reassert = () => {
      if (window.isDestroyed() || !window.isVisible()) return;
      if (state.reasserting) return;
      state.reasserting = true;
      try {
        this.setWindowAlwaysOnTop(window);
      } catch (error) {
        logger.debug('Root visibility topmost guard re-assert failed', { type, error: error.message });
      } finally {
        state.reasserting = false;
      }
      noteBlocked('repair');
    };

    // Electron's hook passes lParam as a pointer value, not the pointed-to
    // STYLESTRUCT/WINDOWPOS. Never mutate or parse it as an inline struct.
    const repairIfDemoted = () => {
      try {
        if (!window.isAlwaysOnTop()) reassert();
      } catch (_) { /* ignore */ }
    };

    try {
      window.hookWindowMessage(WM_STYLECHANGED, repairIfDemoted);
      window.hookWindowMessage(WM_WINDOWPOSCHANGING, repairIfDemoted);
      window.hookWindowMessage(WM_WINDOWPOSCHANGED, repairIfDemoted);
      logger.info('Root visibility topmost guard installed', { type });
    } catch (error) {
      logger.warn('Root visibility topmost guard install failed', { type, error: error.message });
    }
  }

  // New method to enforce always-on-top for all windows
  enforceAlwaysOnTopForAllWindows() {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Single assertion at 'floating' — avoid the screen-saver level
            // churn that occludes other applications.
            window.setAlwaysOnTop(true, 'floating', 1);
          } else {
            // Windows and Linux
            this.setWindowAlwaysOnTop(window);
            
            // Additional enforcement after a short delay
            setTimeout(() => {
              if (!window.isDestroyed()) {
                this.setWindowAlwaysOnTop(window);
              }
            }, 100);
          }
        } catch (error) {
          logger.warn('Error enforcing always-on-top', { 
            type, 
            error: error.message 
          });
          // Fallback to basic always-on-top
          try {
            this.setWindowAlwaysOnTop(window);
          } catch (fallbackError) {
            logger.error('Fallback always-on-top failed', { 
              type, 
              error: fallbackError.message 
            });
          }
        }
      }
    });
    
    logger.debug('Enforced always-on-top for all windows with aggressive strategy', {
      platform: process.platform,
      windowCount: this.windows.size
    });
  }

  // Public method to manually enforce always-on-top for all windows
  forceAlwaysOnTopForAllWindows() {
    this.enforceAlwaysOnTopForAllWindows();
    logger.info('Manually enforced always-on-top for all windows');
  }

  // Debug method to test and verify always-on-top functionality
  testAlwaysOnTopForAllWindows() {
    const results = {};
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          const isAlwaysOnTop = window.isAlwaysOnTop();
          
          if (process.platform === 'darwin') {
            // Test different levels on macOS
            window.setAlwaysOnTop(true, 'floating', 2);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'pop-up-menu', 2);
                setTimeout(() => {
                  if (!window.isDestroyed()) {
                    window.setAlwaysOnTop(true, 'floating', 2);
                  }
                }, 50);
              }
            }, 50);
          } else {
            // For other platforms
            this.setWindowAlwaysOnTop(window);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                this.setWindowAlwaysOnTop(window);
              }
            }, 50);
          }
          
          results[type] = {
            success: true,
            isAlwaysOnTop: isAlwaysOnTop,
            isVisible: window.isVisible(),
            isDestroyed: window.isDestroyed()
          };
          
        } catch (error) {
          results[type] = {
            success: false,
            error: error.message,
            isDestroyed: window.isDestroyed()
          };
        }
      } else {
        results[type] = {
          success: false,
          error: 'Window is destroyed'
        };
      }
    });
    
    logger.info('Always-on-top test results', { 
      platform: process.platform,
      results 
    });
    
    return results;
  }

  showLLMResponse(content, metadata = {}, { reveal = true, owner = null } = {}) {
    logger.debug('showLLMResponse called', {
      isScreenBeingShared: this.isScreenBeingShared,
      contentLength: content.length,
      skill: metadata.skill
    });

    if (this.isScreenBeingShared) {
      logger.warn('LLM response blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow) {
      logger.error('LLM response window not available');
      return;
    }

    // Ensure window is not destroyed before use
    if (llmWindow.isDestroyed()) {
      logger.error('LLM response window is destroyed');
      return;
    }

    // The latest request owns the shared panel. Older answers still reach
    // chat/history, but cannot replace this panel's loading/result state.
    if (owner != null && !this.isAnswerPanelOwner(owner)) return;
    if (owner == null) this.claimAnswerPanelOwner();

    logger.debug('Sending display-llm-response event to window');
    llmWindow.webContents.send('display-llm-response', {
      content,
      metadata,
      timestamp: new Date().toISOString()
    });

    if (!reveal) {
      logger.debug('Answer content delivered without reopening a hidden panel');
      return;
    }
    
    logger.debug('Showing and focusing LLM window');
    this.showOnCurrentDesktop(llmWindow);
    
    // Position bound windows when LLM response is shown
    if (this.bindWindows) {
      this.positionBoundWindows();
    }
        
    logger.info('LLM response displayed', {
      contentLength: content.length,
      skill: metadata.skill,
      windowVisible: llmWindow.isVisible(),
      boundWindows: this.bindWindows
    });
  }

  claimAnswerPanelOwner() {
    this._answerPanelOwner = (this._answerPanelOwner || 0) + 1;
    return this._answerPanelOwner;
  }

  isAnswerPanelOwner(owner) {
    return owner != null && owner === this._answerPanelOwner;
  }

  canDeliverPanelStream(owner, window) {
    // Preserve the legacy hidden-panel feed for chat-only answers. An
    // unowned stream must not rewrite a panel another request is showing.
    return owner == null ? !window.isVisible() : this.isAnswerPanelOwner(owner);
  }

  showLLMLoading(owner = null) {
    if (this.isScreenBeingShared) {
      logger.warn('LLM loading blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (llmWindow) {
      if (owner != null && !this.isAnswerPanelOwner(owner)) return;
      if (owner == null) owner = this.claimAnswerPanelOwner();
      logger.debug('Showing LLM loading state');
      llmWindow.webContents.send('show-loading');
      this.showOnCurrentDesktop(llmWindow);
      
      // Position bound windows when LLM loading is shown
      if (this.bindWindows) {
        this.positionBoundWindows();
      }
      
      logger.debug('LLM loading window shown');
      return owner;
    } else {
      logger.error('LLM window not available for loading state');
    }
  }

  hideLLMResponse({ owner = null, explicit = owner == null } = {}) {
    if (owner != null && owner !== this._answerPanelOwner) return;
    const llmWindow = this.windows.get('llmResponse');
    if (llmWindow && !llmWindow.isDestroyed()) {
      llmWindow.hide();
      if (explicit) this.recordVisibilityHide();
    }
  }

  showSettings() {
    if (this.isScreenBeingShared) return;

    const settingsWindow = this.windows.get('settings');
    if (settingsWindow) {
      this.showOnCurrentDesktop(settingsWindow);
      this.centerWindow(settingsWindow); // This now positions at top-center
      
      // Notify that settings window is shown
      setTimeout(() => {
        settingsWindow.webContents.send('settings-window-shown');
      }, 50);
      
      logger.info('Settings window displayed at top');
    }
  }

  hideSettings() {
    const settingsWindow = this.windows.get('settings');
    if (settingsWindow) {
      settingsWindow.hide();
    }
  }

  async showOnboarding() {
    if (this.isScreenBeingShared) return null;

    let onboardingWindow = this.windows.get('onboarding');
    if (!onboardingWindow) {
      onboardingWindow = await this.createWindow('onboarding');
      this.windows.set('onboarding', onboardingWindow);

      // Once the wizard renderer signals it's ready, send it the
      // current first-run status so it can pre-populate correctly.
      onboardingWindow.webContents.once('did-finish-load', () => {
        logger.info('Onboarding window loaded');
      });
    }

    if (onboardingWindow.isMinimized()) onboardingWindow.restore();
    this.showOnCurrentDesktop(onboardingWindow);
    this.centerWindow(onboardingWindow);
    // Onboarding is a non-activating panel and the app runs under the
    // accessory policy: the user clicks the wizard once and it accepts
    // keyboard input by becoming key WITHOUT activating the app (same
    // mechanism as the settings window), so no activation policy switch
    // or focus steal is needed.
    if (process.platform !== 'darwin') {
      // Windows/Linux: keep the first-run convenience of focusing the
      // wizard so the user can type immediately.
      onboardingWindow.focus();
    }
    logger.info('Onboarding window displayed');
    return onboardingWindow;
  }

  hideOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow) {
      onboardingWindow.hide();
    }
  }

  closeOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    this.windows.delete('onboarding');
  }

  expandLLMWindow(contentMetrics = null) {
    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || this.isScreenBeingShared || this.geometryFrozen) return;

    const optimalSize = this.calculateOptimalWindowSize(contentMetrics);
    
    // Ensure we have valid numbers for setSize
    const width = Math.round(Number(optimalSize.width)) || 840;
    const height = Math.round(Number(optimalSize.height)) || 480;
    
    llmWindow.setSize(width, height);
    
    // If windows are bound, position them together; otherwise center the LLM window
    if (this.bindWindows) {
      this.positionBoundWindows();
    } else {
      this.centerWindow(llmWindow);
    }
    
    logger.debug('LLM window resized', { 
      newSize: `${width}x${height}`,
      basedOnContent: !!contentMetrics,
      boundWindows: this.bindWindows
    });
  }

  calculateOptimalWindowSize(contentMetrics) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    
    let width = 840; // Default LLM window width
    let height = 480; // Default LLM window height
    
    if (contentMetrics && typeof contentMetrics === 'object') {
      const lineCount = Number(contentMetrics.lineCount) || 20;
      const avgLineLength = Number(contentMetrics.avgLineLength) || 80;
      
      width = Math.min(Math.max(avgLineLength * 8, 500), screenWidth * 0.8);
      height = Math.min(Math.max(lineCount * 25 + 100, 300), screenHeight * 0.8);
    }
    
    return { 
      width: Math.round(Number(width)) || 840, 
      height: Math.round(Number(height)) || 480 
    };
  }

  centerWindow(window) {
    if (this.geometryFrozen) return; // A5: no geometry mutation during capture
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    const [windowWidth, windowHeight] = window.getSize();
    
    // Center horizontally but position at top
    const topMargin = 20;
    const x = displayX + Math.round((screenWidth - windowWidth) / 2);
    const y = displayY + topMargin;
    
    window.setPosition(x, y);
    
    logger.debug('Positioned window at top-center', {
      position: `${x},${y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  broadcastToAllWindows(channel, data, options = {}) {
    const windowStates = {};
    
    this.windows.forEach((window, type) => {
      if (type === 'llmResponse' && Object.hasOwn(options, 'panelOwner') &&
          !window.isDestroyed() && !this.canDeliverPanelStream(options.panelOwner, window)) {
        windowStates[type] = { skipped: 'not current panel owner' };
        return;
      }
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
        windowStates[type] = {
          isVisible: window.isVisible(),
          isDestroyed: window.isDestroyed(),
          hasWebContents: !!window.webContents
        };
      } else {
        windowStates[type] = { isDestroyed: true };
      }
    });
    
    logger.info('Broadcast sent to all windows', { 
      channel, 
      windowCount: this.windows.size,
      windowStates,
      dataKeys: data ? Object.keys(data) : [],
      // Fixed: Check for 'content' instead of 'response' to match actual data structure
      dataPreview: data && data.content ? data.content.substring(0, 50) + '...' : 
                   data && data.response ? data.response.substring(0, 50) + '...' : 'No response'
    });
  }

  getWindow(type) {
    return this.windows.get(type);
  }

  getActiveWindow() {
    return this.windows.get(this.activeWindow);
  }

  getWindowStats() {
    const stats = {};
    
    this.windows.forEach((window, type) => {
      stats[type] = {
        isVisible: window.isVisible(),
        isFocused: window.isFocused(),
        position: window.getPosition(),
        size: window.getSize()
      };
    });
    
    return {
      windows: stats,
      activeWindow: this.activeWindow,
      isInteractive: this.isInteractive,
      isVisible: this.isVisible,
      isScreenBeingShared: this.isScreenBeingShared,
      screenCaptureStatus: { ...this.screenCaptureStatus }
    };
  }

  destroyAllWindows() {
    if (process.platform === 'win32') {
      this._windowsMovementDisposed = true;
      this._windowsPositioner?.dispose();
    }
    this.windows.forEach((window, type) => {
      logger.debug('Destroying window', { type });
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
    
    this.windows.clear();

    if (this._displayChangeTimer) {
      clearTimeout(this._displayChangeTimer);
      this._displayChangeTimer = null;
    }
    
    // Clean up all watchers
    if (this.screenWatcher) {
      clearInterval(this.screenWatcher);
      this.screenWatcher = null;
    }
    
    if (this.desktopWatcher) {
      clearInterval(this.desktopWatcher);
      this.desktopWatcher = null;
    }

    if (this._displayChangeTimer) {
      clearTimeout(this._displayChangeTimer);
      this._displayChangeTimer = null;
    }

    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
      this.screenCaptureAvailabilityWatcher = null;
    }
    
    logger.info('All windows destroyed');
  }

  setupScreenTracking() {
    // Initialize with current cursor position to get the active display
    const cursorPoint = screen.getCursorScreenPoint();
    this.currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
    this._activeDisplaySignature = this.displaySignature(this.currentDisplay);
    
    screen.on('display-added', () => {
      logger.debug('Display added');
      this.handleDisplayChange();
    });

    screen.on('display-removed', () => {
      logger.debug('Display removed');
      this.handleDisplayChange();
    });

    screen.on('display-metrics-changed', () => {
      logger.debug('Display metrics changed');
      this.handleDisplayChange();
    });

    // More frequent tracking during initialization
    this.screenWatcher = setInterval(() => {
      this.trackActiveScreen();
    }, 2000);

    // SIMPLIFIED desktop tracking
    this.setupDesktopTracking();

    logger.info('Screen and desktop tracking initialized', {
      currentDisplay: this.currentDisplay.id,
      cursorPosition: cursorPoint
    });
  }

  handleDisplayChange() {
    if (this._displayChangeTimer) clearTimeout(this._displayChangeTimer);
    this._displayChangeTimer = setTimeout(() => {
      this._displayChangeTimer = null;
      if (this.isScreenBeingShared) return;
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
      const signature = this.displaySignature(display);
      if (signature === this._activeDisplaySignature) return;
      this.currentDisplay = display;
      this._activeDisplaySignature = signature;
      this.moveWindowsToActiveScreen();
    }, 500);
  }

  displaySignature(display) {
    if (!display) return '';
    const b = display.bounds || {};
    const w = display.workArea || {};
    return [display.id, display.scaleFactor, b.x, b.y, b.width, b.height,
      w.x, w.y, w.width, w.height].join(':');
  }

  trackActiveScreen() {
    if (this.isScreenBeingShared) return;

    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    
    const signature = this.displaySignature(activeDisplay);
    if (!this.currentDisplay || signature !== this._activeDisplaySignature) {
      this.currentDisplay = activeDisplay;
      this._activeDisplaySignature = signature;
      this.moveWindowsToActiveScreen();
      
      logger.debug('Active screen changed', {
        displayId: activeDisplay.id,
        bounds: activeDisplay.bounds
      });
    }
  }

  moveWindowsToActiveScreen() {
    if (!this.currentDisplay || this.isScreenBeingShared) return;

    const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = this.currentDisplay.workArea;
    
    // Handle bound windows specially
    if (this.bindWindows) {
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow && !mainWindow.isDestroyed() && !llmWindow.isDestroyed()) {
        // Position bound windows on the new screen and ensure they appear on current desktop
        this.positionBoundWindows();
        if (mainWindow.isVisible()) this.showOnCurrentDesktop(mainWindow);
        if (llmWindow.isVisible()) this.showOnCurrentDesktop(llmWindow);
      }
    }
    
    this.windows.forEach((window, type) => {
      if (window && !window.isDestroyed()) {
        // Skip main and llmResponse if they're bound (already handled above)
        if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
          return;
        }
        
        const [windowWidth, windowHeight] = window.getSize();
        
        let newX, newY;
        
        // All windows positioned at top of screen
        const topMargin = 20;
        
        switch (type) {
          case 'main':
            newX = displayX + 50;
            newY = displayY + topMargin;
            break;
          case 'chat':
            newX = displayX + displayWidth - windowWidth - 50;
            newY = displayY + topMargin;
            break;
          case 'skills':
            newX = displayX + 50;
            newY = displayY + topMargin + 100; // Slightly lower to avoid overlap
            break;
          case 'llmResponse':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          case 'settings':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          default:
            newX = displayX + 100;
            newY = displayY + topMargin;
        }
        
        window.setPosition(Math.round(newX), Math.round(newY));
        
        // Ensure always-on-top is maintained after moving
        if (process.platform === 'darwin') {
          window.setAlwaysOnTop(true, 'floating', 1);
        } else {
          this.setWindowAlwaysOnTop(window);
        }
        
        // Ensure window appears on current desktop if it's visible
        if (window.isVisible()) {
          this.showOnCurrentDesktop(window);
        }
        
        logger.debug('Window moved to active screen and shown on current desktop', {
          type,
          position: `${newX},${newY}`,
          isVisible: window.isVisible(),
          displayId: this.currentDisplay.id
        });
      }
    });
  }

  setupDesktopTracking() {
    // MUCH less aggressive desktop tracking
    this.desktopWatcher = setInterval(() => {
      this.trackDesktopChanges();
    }, 10000); // Changed from 1500ms to 10000ms (10 seconds)

    logger.info('Desktop tracking initialized');
  }

  trackDesktopChanges() {
    if (this.isScreenBeingShared) return;

    // Simplified tracking - just log changes
    if (process.platform === 'darwin') {
      const cursorPoint = screen.getCursorScreenPoint();
      const currentSpaceSignature = `${cursorPoint.x}_${cursorPoint.y}`;
      
      if (this.lastActiveSpace && this.lastActiveSpace !== currentSpaceSignature) {
        logger.debug('Desktop space might have changed');
      }
      
      this.lastActiveSpace = currentSpaceSignature;
    }
  }

  // REMOVED all the aggressive enforcement methods that were causing flickering:
  // - handlePossibleSpaceChange()
  // - handleSpaceChange() 
  // - ensureWindowVisibility()
  // - enforceWindowProperties()
  // - enforceAllWindowProperties()
  // - enforceAlwaysOnTop()

  // Public methods for manual screen sharing control
  enableScreenSharingMode() {
    this.startScreenSharingMode();
  }

  disableScreenSharingMode() {
    this.stopScreenSharingMode();
  }

  isInScreenSharingMode() {
    return this.isScreenBeingShared;
  }

  // Window binding management methods
  setWindowBinding(enabled) {
    this.bindWindows = enabled;
    
    if (enabled) {
      // Position bound windows when binding is enabled
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow) {
        this.positionBoundWindows();
      }
      
      logger.info('Window binding enabled');
    } else {
      logger.info('Window binding disabled');
    }
    
    return this.bindWindows;
  }

  toggleWindowBinding() {
    return this.setWindowBinding(!this.bindWindows);
  }

  getWindowBindingStatus() {
    return {
      enabled: this.bindWindows,
      gap: this.windowGap,
      position: this.boundWindowsPosition
    };
  }

  setWindowGap(gap) {
    this.windowGap = Math.max(0, gap);
    
    // Re-position if currently bound
    if (this.bindWindows) {
      this.positionBoundWindows();
    }
    
    logger.debug('Window gap updated', { gap: this.windowGap });
    return this.windowGap;
  }

  showChatWindow() {
    if (this.isScreenBeingShared) return;
    this._ensureDesiredVisibility().set('chat', true);
    const chatWindow = this.windows.get('chat');
    if (!chatWindow || chatWindow.isDestroyed()) {
      this.ensureWindow('chat');
      return;
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      if (chatWindow.isVisible()) return;
      this.showOnCurrentDesktop(chatWindow);
      logger.debug('Chat window shown');
    }
  }

  showWindow(windowType) {
    // Unconditional show (no toggle) — used by keystroke-capture mode so the
    // user can always see where their keystrokes are landing.
    if (this.isScreenBeingShared) return;
    if (windowType === 'main' || windowType === 'chat') {
      this._ensureDesiredVisibility().set(windowType, true);
    }
    const targetWindow = this.windows.get(windowType);
    if ((!targetWindow || targetWindow.isDestroyed()) && (windowType === 'main' || windowType === 'chat')) {
      this.ensureWindow(windowType);
      return;
    }
    if (targetWindow && !targetWindow.isDestroyed()) {
      // E9-S-001 fold: on macOS, if the target is already visible, showing
      // again would run the hide→showInactive dance (a visible flash
      // mid-share), so it stays a no-op there. On Windows there is no hide
      // dance: an already-visible but COVERED window must instead be
      // re-fronted in the shared topmost band (moveTop, no activation, no
      // repaint) — otherwise the summon hotkey is a silent no-op exactly
      // when the user needs it (window buried under the exam browser).
      if (targetWindow.isVisible() && process.platform !== 'win32') {
        return;
      }
      this.showOnCurrentDesktop(targetWindow);
      logger.debug('Window shown for capture', { windowType });
    }
  }

  hideChatWindow() {
    this.chatHideVersion += 1;
    this._ensureDesiredVisibility().set('chat', false);
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.hide();
      logger.debug('Chat window hidden');
    }
  }

  handleRecordingStarted() {
    this.isRecording = true;
    this.showChatWindow();
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-started');
    logger.debug('Recording started, chat window shown');
  }

  handleRecordingStopped() {
    this.isRecording = false;
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-stopped');
    logger.debug('Recording stopped, chat window kept visible for the response');
  }

  broadcastSkillChange(skill) {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send('skill-changed', { skill });
      }
    });
    
    logger.info('Skill change broadcasted to all windows', { 
      skill,
      windowCount: this.windows.size 
    });
    }
}

module.exports = new WindowManager();
