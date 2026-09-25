const { getDisplayLayout } = require('./display-layout');
const KINDS = ['screen', 'microphone'];
const PERMISSIONS = new Set(['not-determined', 'granted', 'denied', 'restricted', 'unknown']);
const HELP = {
  screen: 'https://support.apple.com/guide/mac-help/control-access-to-screen-and-system-audio-recording-mchld6aa7d23/mac',
  microphone: 'https://support.apple.com/guide/mac-help/control-access-to-your-microphone-on-mac-mchla1b1e1fe/mac'
};

class PlatformAdapter {
  constructor({ electron, platform = process.platform, now = () => new Date().toISOString() } = {}) {
    this.electron = electron || require('electron');
    this.platform = platform;
    this.now = now;
    this.operations = new Map();
  }
  _validate(kind) {
    if (!KINDS.includes(kind)) throw new Error(`Unsupported capability: ${kind}`);
  }
  checkCapability(kind) {
    this._validate(kind);
    const supported = ['darwin', 'win32', 'linux'].includes(this.platform);
    const availability = !supported ? 'unsupported' : kind === 'screen' &&
      typeof this.electron.desktopCapturer?.getSources !== 'function' ? 'unavailable' : 'available';
    let permission = 'unknown';
    let reason = this.platform === 'linux'
      ? 'Permission is managed by the desktop session or portal; verify with an explicit operation.'
      : 'Permission status alone does not verify capture or microphone operation.';
    if (this.platform === 'darwin' || this.platform === 'win32') {
      try {
        const status = this.electron.systemPreferences?.getMediaAccessStatus(kind);
        if (PERMISSIONS.has(status)) permission = status;
      } catch (error) {
        reason = `Permission check failed: ${error.message}`;
      }
    }
    if (this.platform === 'win32' && kind === 'screen') {
      // Electron always returns granted for Windows screen: no permission probe.
      permission = 'unknown';
      reason = 'Electron cannot determine Windows screen-capture permission; run an explicit capture test.';
    }
    const denied = ['denied', 'restricted'].includes(permission);
    // Revocation invalidates prior readiness without inventing a new operation.
    const previous = this.operations.get(kind);
    if (previous?.health === 'healthy' && (denied || permission === 'not-determined' || availability !== 'available')) {
      this.operations.set(kind, { ...previous, health: 'untested', reason: 'Access changed. Run the feature again to verify it.' });
    }
    const operation = this.operations.get(kind);
    if (denied) reason = `${kind} permission is ${permission}. Change access in system privacy settings and restart if requested.`;
    if (availability !== 'available') reason = `${kind} API is ${availability} on ${this.platform}.`;
    return {
      kind, platform: this.platform, availability, permission,
      health: operation?.health || 'untested',
      reason: denied || availability !== 'available' ? reason : operation?.reason || reason,
      recoveryAction: denied ? 'open-settings' : operation?.health === 'failed' ? 'retry' : 'test',
      checkedAt: this.now(), lastOperationAt: operation?.checkedAt || null
    };
  }
  checkCapabilities() {
    return { platform: this.platform, screen: this.checkCapability('screen'), microphone: this.checkCapability('microphone') };
  }
  // Only real operations, never permission checks, update runtime health.
  reportOperation(kind, { success, reason = '' }) {
    this._validate(kind);
    this.operations.set(kind, {
      health: success ? 'healthy' : 'failed', reason: reason || (success ? 'Last operation succeeded.' : 'Last operation failed.'), checkedAt: this.now()
    });
    return this.checkCapability(kind);
  }
  getDisplayLayout() { return getDisplayLayout(this.electron.screen, this.now); }
  async requestCapability(kind) {
    this._validate(kind);
    return { ...this.checkCapability(kind), requested: false, reason: 'Use an explicit capture or microphone test to request desktop-session access.' };
  }
  async openSettings(kind) {
    this._validate(kind);
    return { opened: false, reason: 'Open your desktop privacy settings or portal settings manually.' };
  }
}

class DarwinAdapter extends PlatformAdapter {
  async requestCapability(kind) {
    this._validate(kind);
    const before = this.checkCapability(kind);
    if (['denied', 'restricted'].includes(before.permission)) return { ...before, requested: false };
    try {
      if (kind === 'microphone') {
        const granted = await this.electron.systemPreferences.askForMediaAccess('microphone');
        return { ...this.checkCapability(kind), permission: granted ? 'granted' : 'denied', requested: true,
          recoveryAction: granted ? 'test' : 'open-settings' };
      }
      // Electron has no askForMediaAccess('screen'). User-initiated enumeration
      // may trigger macOS consent; it does not establish capture health.
      await this.electron.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      return { ...this.checkCapability(kind), requested: true };
    } catch (error) {
      return { ...this.checkCapability(kind), requested: false, reason: error.message, recoveryAction: 'open-settings' };
    }
  }
  async openSettings(kind) {
    this._validate(kind);
    // Open the application using Electron's documented API, avoiding private
    // x-apple preference pane URL identifiers.
    const error = await this.electron.shell.openPath('/System/Applications/System Settings.app');
    return { opened: !error, reason: error || `Choose Privacy & Security, then ${kind === 'screen' ? 'Screen & System Audio Recording' : 'Microphone'}.`, helpUrl: HELP[kind] };
  }
}

class Win32Adapter extends PlatformAdapter {
  async requestCapability(kind) {
    this._validate(kind);
    if (kind === 'microphone') {
      const settings = await this.openSettings(kind);
      return { ...this.checkCapability(kind), requested: false, settings };
    }
    return { ...this.checkCapability(kind), requested: false, reason: 'Run an explicit screen capture test; Windows has no Electron screen-permission prompt API.' };
  }
  async openSettings(kind) {
    this._validate(kind);
    const url = kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy-graphicscaptureprogrammatic';
    await this.electron.shell.openExternal(url);
    return { opened: true, url, reason: 'Review system access, then retry. Available controls depend on Windows version and capture backend.' };
  }
}

class LinuxAdapter extends PlatformAdapter {}
function createPlatformAdapter(options = {}) {
  const platform = options.platform || process.platform;
  const Adapter = { darwin: DarwinAdapter, win32: Win32Adapter, linux: LinuxAdapter }[platform] || PlatformAdapter;
  return new Adapter({ ...options, platform });
}
module.exports = { createPlatformAdapter, PlatformAdapter, DarwinAdapter, Win32Adapter, LinuxAdapter };
