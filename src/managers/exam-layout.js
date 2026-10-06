'use strict';

const { app, screen, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../core/logger').createServiceLogger('EXAM-LAYOUT');

const MODIFIERS = ['Ctrl+Shift', 'Ctrl+Alt', 'Ctrl+Alt+Shift'];
const DIRECTIONS = { Left: [-20, 0], Right: [20, 0], Up: [0, -20], Down: [0, 20] };
const MARGIN = 16;
const BAR = 34, GAP = 8;
const alive = win => win && !win.isDestroyed();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Layout intent is independent of process privilege, click-through and macOS
// Shield. This controller owns the attached Windows toolbar/chat geometry and movement keys.
class ExamLayout {
  constructor(manager, { enabled = false } = {}) {
    this.manager = manager;
    this.enabled = process.platform === 'win32' && enabled;
    this.file = path.join(app.getPath('userData'), 'exam-layout.json');
    this.preferences = { version: 2, modifier: MODIFIERS[0], positions: {}, normalWindows: {} };
    this.attachments = new Map();
    this.loadingWindows = new Set();
    this.compactHeight = BAR;
    this.toolbarHeight = BAR;
    this.menuRevision = 0;
    this.registered = new Set();
    this.epoch = 0;
    this.busy = false;
    this.disposed = false;
    this.movementFailed = false;
    this.error = '';
    this.readPreferences();
  }

  readPreferences() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (![1, 2].includes(saved.version)) return;
      if (MODIFIERS.includes(saved.modifier)) this.preferences.modifier = saved.modifier;
      if (Number.isSafeInteger(saved.displayId)) this.preferences.displayId = saved.displayId;
      for (const [id, point] of Object.entries(saved.positions || {}).slice(0, 32)) {
        if (/^-?\d+$/.test(id) && [point?.x, point?.y].every(Number.isFinite)) {
          this.preferences.positions[id] = { x: point.x, y: point.y - (saved.version === 1 ? BAR + GAP : 0) };
        }
      }
      const bounds = saved.normalBounds;
      if (bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) &&
          bounds.width >= 300 && bounds.height >= 400) this.preferences.normalBounds = bounds;
      for (const type of ['main', 'chat']) {
        const b = saved.normalWindows?.[type];
        if (b && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k])) && b.width > 0 && b.height > 0) this.preferences.normalWindows[type] = b;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('Could not read panel placement', { message: error.message });
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.preferences, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      const recovered = this.saveError;
      this.saveError = false;
      if (recovered) this.publish();
    } catch (error) {
      this.saveError = true;
      logger.warn('Could not save panel placement', { message: error.message });
      this.publish();
    }
  }

  remember(type = this.enabled ? 'main' : 'chat') {
    const win = this.attachments.get(type);
    if (!alive(win) || this.applyingBounds || this.manager.isScreenBeingShared) return;
    const bounds = win.getBounds();
    if (this.enabled) {
      if (type !== 'main' || !this.display || this.displayChanging ||
          !screen.getAllDisplays().some(d => d.id === this.display.id)) return;
      const area = this.display.workArea;
      this.preferences.positions[this.display.id] = { x: bounds.x - area.x, y: bounds.y - area.y };
    } else {
      if (type === 'chat' && this.normalRestoredBounds && ['x', 'y', 'width', 'height'].every(k => bounds[k] === this.normalRestoredBounds[k])) return;
      this.preferences.normalWindows[type] = bounds;
      if (type === 'chat') this.preferences.normalBounds = bounds;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 200);
    this.saveTimer.unref?.();
  }

  options(type = 'chat') {
    return this.enabled ? { width: 400, height: type === 'main' ? BAR : 520, minWidth: 1, minHeight: 1, movable: false, resizable: false } : {};
  }

  attach(window, type = 'chat') {
    this.detachments?.get(type)?.();
    this.invalidate();
    this.attachments.set(type, window);
    this.loadingWindows.add(type);
    if (type === 'chat') this.window = window;
    const listeners = [];
    const on = (target, event, action) => {
      const guarded = (...args) => { if (this.attachments.get(type) === window && !this.disposed) action(...args); };
      target.on(event, guarded);
      listeners.push(() => target.removeListener(event, guarded));
    };
    (this.detachments ||= new Map()).set(type, () => listeners.forEach(remove => remove()));
    on(window, 'will-move', event => { if (this.enabled) event.preventDefault(); });
    on(window, 'will-resize', event => { if (this.enabled) event.preventDefault(); });
    on(window, 'move', () => this.remember(type));
    on(window, 'resize', () => this.remember(type));
    on(window, 'show', () => this.sync());
    on(window, 'hide', () => {
      this.invalidate();
      if (type === 'main') this.closeToolbarMenu();
      this.save();
      this.sync();
      if (!window.webContents.isDestroyed()) window.webContents.send('chat-panel-hidden');
    });
    on(window, 'closed', () => { this.invalidate(); this.loadingWindows.add(type); this.sync(); });
    on(window.webContents, 'did-start-loading', () => { this.loadingWindows.add(type); this.invalidate(); this.sync(); });
    on(window.webContents, 'did-finish-load', () => { this.loadingWindows.delete(type); this.fit(); this.sync(); });
    on(window.webContents, 'render-process-gone', () => { this.loadingWindows.add(type); this.invalidate(); this.sync(); });
    this.applyPolicy({ initial: true, type });
  }

  closeToolbarMenu({ invalidate = true } = {}) {
    const main = this.attachments.get('main');
    const expanded = this.toolbarHeight > this.compactHeight;
    this.menuRevision++;
    this.toolbarHeight = this.compactHeight;
    if (alive(main) && !main.webContents.isDestroyed()) main.webContents.send('toolbar-menu-close');
    if (expanded) this.fit({ invalidate });
    else this.publish();
  }

  resizeToolbarContent(_width, height, menuRevision) {
    if (!this.enabled || !Number.isFinite(height) || menuRevision !== this.menuRevision) return;
    const main = this.attachments.get('main');
    // Hidden renderers and delayed menu measurements cannot expand the hit area.
    this.toolbarHeight = alive(main) && main.isVisible() ? Math.max(this.compactHeight, Math.ceil(height)) : this.compactHeight;
    this.fit();
    if (this.toolbarHeight > this.compactHeight && alive(main) && main.isVisible()) main.moveTop?.();
  }

  selectedDisplay() {
    const displays = screen.getAllDisplays();
    return displays.find(display => display.id === this.preferences.displayId) || screen.getPrimaryDisplay();
  }

  restoreNormalBounds(target) {
    let request = { ...target }, best;
    const keys = ['x', 'y', 'width', 'height'];
    const attempted = new Set();
    // Find the original rectangle when representable. Some integer-DIP sizes
    // are skipped at fractional scaling; keep the closest measured result and
    // retain the original target instead of accumulating that rounding.
    for (let attempt = 0; attempt < 4; attempt++) {
      const signature = keys.map(key => request[key]).join(',');
      if (attempted.has(signature)) break;
      attempted.add(signature);
      this.window.setBounds(request, false);
      const actual = this.window.getBounds();
      const distance = keys.reduce((sum, key) => sum + Math.abs(actual[key] - target[key]), 0);
      if (!best || distance < best.distance) best = { request: { ...request }, distance };
      if (!distance) break;
      request = Object.fromEntries(keys.map(key => [key, request[key] + target[key] - actual[key]]));
      request.width = Math.max(300, request.width);
      request.height = Math.max(400, request.height);
    }
    this.window.setBounds(best.request, false);
    this.normalRestoredBounds = this.window.getBounds();
    this.preferences.normalBounds = { ...target };
  }

  fit({ invalidate = true } = {}) {
    const main = this.attachments.get('main');
    if (!this.enabled || !alive(main)) return;
    if (this.manager.geometryFrozen) {
      this.fitPending = true;
      this.displayChanging = true;
      this.invalidate();
      this.sync();
      return;
    }
    this.fitPending = false;
    this.displayChanging = false;
    if (invalidate) this.invalidate();
    const display = this.selectedDisplay();
    const previousDisplayId = this.preferences.displayId ?? this.display?.id;
    if (previousDisplayId !== undefined && previousDisplayId !== display.id &&
        !screen.getAllDisplays().some(item => item.id === previousDisplayId)) {
      const previous = this.preferences.positions[previousDisplayId];
      if (previous) this.preferences.positions[display.id] = { ...previous };
    }
    this.display = display;
    this.preferences.displayId = display.id;
    const area = display.workArea;
    const inset = area.width < 332 || area.height < 200 ? 0 : MARGIN;
    this.inset = inset;
    const availableHeight = Math.max(1, area.height - 2 * inset);
    const width = Math.max(1, Math.min(400, area.width - 2 * inset));
    const barHeight = Math.min(this.compactHeight, availableHeight);
    const chatHeight = Math.max(1, Math.min(520, availableHeight - barHeight - GAP));
    this.tooSmall = width < 300 || chatHeight < 200;
    this.chatFits = availableHeight > barHeight + GAP;
    const chatOpen = Boolean(this.manager.examChatOpen && this.chatFits);
    const coreHeight = chatOpen ? barHeight + GAP + chatHeight : barHeight;
    const height = Math.min(availableHeight, Math.max(barHeight, this.toolbarHeight));
    const groupHeight = Math.max(coreHeight, height);
    const saved = this.preferences.positions[display.id];
    const x = Math.round(area.x + clamp(saved?.x ?? area.width - width - inset, inset, Math.max(inset, area.width - width - inset)));
    const y = Math.round(area.y + clamp(saved?.y ?? inset, inset, Math.max(inset, area.height - groupHeight - inset)));
    const wasApplying = this.applyingBounds;
    let compactChanged = false;
    this.applyingBounds = true;
    try {
      const place = (win, bounds) => {
        win.setMinimumSize(1, 1);
        win.setMaximumSize(0, 0);
        win.setBounds(bounds, false);
        const measured = win.getBounds();
        const ew = Math.max(0, measured.width - bounds.width), eh = Math.max(0, measured.height - bounds.height);
        const request = { ...bounds, width: Math.max(1, bounds.width - ew), height: Math.max(1, bounds.height - eh) };
        if (ew || eh) win.setBounds(request, false);
        return { width: request.width, height: request.height };
      };
      // Retain the request that produced the measured fit, including native
      // rounding compensation. Measured sizes are not stable request sizes.
      this.fittedSize = place(main, { x, y, width: Math.round(width), height: Math.round(height) });
      const measured = main.getBounds();
      // Windows can impose a compact minimum above 34 DIPs. Learn that
      // measured extent only while compact; a More overlay is never the bar.
      if (this.toolbarHeight <= this.compactHeight && measured.height > this.compactHeight) {
        this.compactHeight = measured.height;
        this.toolbarHeight = this.compactHeight;
        compactChanged = true;
      }
      const chat = this.attachments.get('chat');
      if (alive(chat)) {
        this.chatFittedSize = place(chat, { x: measured.x, y: measured.y + barHeight + GAP, width: measured.width, height: Math.round(chatHeight) });
        if (!this.chatFits && chat.isVisible()) chat.hide();
        else if (this.chatFits && !this.loadingWindows.has('chat') && this.manager.isWindowDesiredVisible('chat') && this.manager.isWindowDesiredVisible('main') && !this.manager.isScreenBeingShared && !chat.isVisible()) this.manager.showOnCurrentDesktop(chat);
      }
      this.groupHeight = groupHeight;
      this.barHeight = barHeight;
    } finally { this.applyingBounds = wasApplying; }
    if (compactChanged) return this.fit({ invalidate: false });
    this.remember('main');
    this.sync();
  }

  applyPolicy({ initial = false, type } = {}) {
    const entries = type ? [[type, this.attachments.get(type)]] : [...this.attachments];
    this.applyingBounds = true;
    try {
      for (const [name, win] of entries) {
        if (!alive(win)) continue;
        win.setMovable(!this.enabled);
        win.setResizable(!this.enabled);
        if (this.enabled) continue;
        win.setMaximumSize(name === 'main' ? 520 : 0, 0);
        win.setMinimumSize(name === 'main' ? 60 : 300, name === 'main' ? 34 : 400);
        const saved = this.preferences.normalWindows[name] || (name === 'chat' ? this.preferences.normalBounds : null);
        if (!saved && initial) continue;
        const base = saved || { ...win.getBounds(), width: name === 'main' ? 520 : 500, height: name === 'main' ? 35 : 700 };
        const area = screen.getDisplayMatching(base).workArea;
        const width = Math.min(base.width, area.width), height = Math.min(base.height, area.height);
        const target = { width: Math.round(width), height: Math.round(height),
          x: Math.round(clamp(base.x, area.x, area.x + area.width - width)),
          y: Math.round(clamp(base.y, area.y, area.y + area.height - height)) };
        if (name === 'chat') this.restoreNormalBounds(target);
        else win.setBounds(target, false);
      }
    } finally { this.applyingBounds = false; }
    if (this.enabled) this.fit();
    this.publish();
  }

  setEnabled(enabled) {
    if (this.disposed || process.platform !== 'win32' || this.enabled === Boolean(enabled)) return this.state();
    for (const type of this.attachments.keys()) this.remember(type);
    this.closeToolbarMenu();
    this.invalidate();
    this.enabled = Boolean(enabled);
    this.movementFailed = false;
    this.error = '';
    // Release the legacy bindings before claiming this layout's four keys.
    this.manager.onExamLayoutChanged?.();
    this.applyPolicy();
    if (this.enabled) {
      this.manager.examChatOpen = false;
      this.manager.hideAllWindowsExcept([]);
      this.manager.restoreExamCore();
    } else {
      this.manager.showMainWindow();
    }
    this.sync();
    this.save();
    return this.state();
  }

  configure({ modifier, displayId, resetPosition = false } = {}) {
    if (this.manager.geometryFrozen) throw new Error('Finish capture before changing panel setup.');
    if (modifier !== undefined && !MODIFIERS.includes(modifier)) throw new Error('Choose one of the listed movement shortcuts.');
    if (displayId !== undefined && !screen.getAllDisplays().some(display => display.id === displayId)) {
      throw new Error('That display is no longer connected.');
    }
    this.invalidate();
    this.release();
    if (modifier !== undefined) this.preferences.modifier = modifier;
    if (displayId !== undefined) this.preferences.displayId = displayId;
    if (resetPosition) delete this.preferences.positions[this.selectedDisplay().id];
    this.error = '';
    this.movementFailed = false;
    if (this.enabled) this.fit();
    this.save();
    this.sync();
    return this.state();
  }

  invalidate() {
    this.release();
  }

  eligible() {
    return this.enabled && !this.disposed && !this.loadingWindows.has('main') && !this.displayChanging &&
      !this.manager.geometryFrozen && !this.manager.isScreenBeingShared &&
      alive(this.attachments.get('main')) && this.attachments.get('main').isVisible();
  }

  release() {
    // Every registration lifetime is distinct, including conflict rollback and
    // failure recovery without a visibility or mode transition.
    this.epoch++;
    for (const accelerator of this.registered) globalShortcut.unregister(accelerator);
    this.registered.clear();
  }

  sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      if (!this.eligible() || this.movementFailed) {
        this.release();
      } else {
        const epoch = this.epoch;
        for (const direction of Object.keys(DIRECTIONS)) {
          const accelerator = `${this.preferences.modifier}+${direction}`;
          if (this.registered.has(accelerator) && globalShortcut.isRegistered(accelerator)) continue;
          let registered = false;
          try { registered = globalShortcut.register(accelerator, () => this.move(...DIRECTIONS[direction], epoch)); } catch { /* report below */ }
          if (!registered) {
            this.release();
            this.error = 'Movement unavailable. Choose another shortcut in More → Panel setup.';
            break;
          }
          this.registered.add(accelerator);
        }
        if (this.registered.size === 4) this.error = '';
      }
      this.publish();
    } finally { this.syncing = false; }
  }

  move(dx, dy, epoch) {
    // Two synchronous native bounds writes per delivered group step. No worker
    // pipe, promises, movement queue, animation or key-up simulation. Keeping
    // the fitted logical size avoids rounding an observed native size on each
    // step. No show/focus operation participates in movement.
    if (epoch !== this.epoch || !this.eligible() || this.registered.size !== 4 || this.busy || this.movementFailed) return;
    const main = this.attachments.get('main');
    const current = () => epoch === this.epoch && this.eligible() && this.attachments.get('main') === main;
    this.busy = true;
    try {
      if (!current()) return;
      // Dismiss even when an opening measurement has not reached the main
      // process yet. Older resize IPC cannot restore its transparent hit area.
      this.closeToolbarMenu({ invalidate: false });
      const bounds = main.getBounds(), area = this.display.workArea;
      const inset = this.inset;
      const x = Math.round(clamp(bounds.x + dx, area.x + inset, area.x + area.width - bounds.width - inset));
      const y = Math.round(clamp(bounds.y + dy, area.y + inset, area.y + area.height - this.groupHeight - inset));
      if (x === bounds.x && y === bounds.y) return;
      this.applyingBounds = true;
      try {
        main.setBounds({ x, y, ...this.fittedSize }, false);
        const chat = this.attachments.get('chat');
        if (current() && this.manager.examChatOpen && this.chatFits && alive(chat)) {
          const actual = main.getBounds();
          chat.setBounds({ ...this.chatFittedSize, x: actual.x, y: actual.y + this.barHeight + GAP }, false);
        }
      } finally { this.applyingBounds = false; }
      if (current()) this.remember('main');
    } catch (error) {
      this.movementFailed = true;
      this.error = 'Movement unavailable. Open More → Panel setup to retry.';
      this.release();
      this.publish();
      logger.warn('Could not move attached panels', { message: error.message });
    } finally { this.busy = false; }
  }

  state() {
    const availableHeight = Math.max(1, this.selectedDisplay().workArea.height - 2 * (this.inset ?? MARGIN));
    const belowBar = this.compactHeight + GAP;
    // A very short work area uses an overlay covering the bar. Its complete
    // scrollport remains reachable; Escape returns to the compact controls.
    const menuTop = availableHeight - belowBar - 8 < 120 ? 0 : belowBar;
    return {
      menuRevision: this.menuRevision, compactHeight: this.compactHeight,
      chatOpen: Boolean(this.manager.examChatOpen), coreVisible: this.manager.isWindowDesiredVisible('main'),
      menuTop, menuMaxHeight: Math.max(1, availableHeight - menuTop - (menuTop ? 8 : 0)),
      chatUnavailable: this.loadingWindows.has('chat'),
      supported: process.platform === 'win32', enabled: this.enabled,
      modifier: this.preferences.modifier, modifiers: MODIFIERS,
      displayId: this.selectedDisplay().id, tooSmall: Boolean(this.tooSmall && this.enabled),
      displays: screen.getAllDisplays().map((display, index) => ({ id: display.id, label: display.label || `Display ${index + 1}` })),
      movement: this.registered.size === 4 ? 'ready' : 'unavailable',
      error: this.enabled && this.loadingWindows.has('chat') && this.manager.examChatOpen ? 'Chat is loading or unavailable. Try reopening chat; Settings and Panel setup remain available.' : this.tooSmall && this.enabled ? 'This display is too small for chat. Choose a larger display in More → Panel setup.' : this.error,
      saveError: Boolean(this.saveError)
    };
  }

  publish() {
    if (this.disposed) return;
    for (const win of this.attachments.values()) {
      if (alive(win) && !win.webContents.isDestroyed()) win.webContents.send('exam-layout-changed', this.state());
    }
  }

  dispose() {
    if (this.disposed) return;
    this.remember();
    this.save();
    this.disposed = true;
    for (const detach of this.detachments?.values() || []) detach();
    this.invalidate();
    this.release();
  }
}

module.exports = ExamLayout;
