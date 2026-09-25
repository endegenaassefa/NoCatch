'use strict';
const { randomBytes } = require('node:crypto');

// Renderer errors are codes, never device/OS/provider strings supplied by IPC.
const MICROPHONE_ERRORS = Object.freeze({
  permission: 'Microphone access was denied. Allow microphone access in system privacy settings, then retry.',
  device: 'No usable microphone is available. Connect a microphone and retry.',
  busy: 'The microphone could not be opened. Close other recording apps and retry.',
  lost: 'Microphone capture stopped. Reconnect your microphone and retry.',
  unsupported: 'Microphone capture is unavailable. Restart the app and retry.',
  capture: 'Microphone capture failed. Check your microphone and retry.',
  timeout: 'Microphone capture did not respond. Stop and retry.',
});

class RendererAudioSession {
  constructor({ send, onAudio, onError, readyTimeoutMs = 30000, stopTimeoutMs = 1000, now = () => performance.now() }) {
    Object.assign(this, { send, onAudio, onError, readyTimeoutMs, stopTimeoutMs, now });
    this.current = null;
  }

  start(owner) {
    this.cancel();
    const state = {
      owner, sessionId: randomBytes(32).toString('hex'), phase: 'starting',
      sequence: 0, credit: 16384, messages: 64, lastAt: this.now(),
    };
    this.current = state;
    const promise = new Promise((resolve, reject) => {
      state.ready = resolve;
      state.reject = reject;
    });
    state.timer = setTimeout(() => this._fail(state, 'timeout'), this.readyTimeoutMs);
    try { this.send(owner, { action: 'start', sessionId: state.sessionId }); }
    catch (_) { this._fail(state, 'capture'); }
    return promise;
  }

  receive(owner, event) {
    const state = this.current;
    if (!state || owner !== state.owner || !event || event.sessionId !== state.sessionId) return false;
    if (event.type === 'ready' && state.phase === 'starting') {
      clearTimeout(state.timer);
      state.phase = 'running';
      state.lastAt = this.now();
      state.ready();
      return true;
    }
    if (event.type === 'error') {
      this._fail(state, typeof event.code === 'string' && Object.hasOwn(MICROPHONE_ERRORS, event.code) ? event.code : 'capture');
      return true;
    }
    if (event.type === 'stopped' && state.phase === 'stopping') {
      this._finish(state, { incomplete: event.incomplete === true });
      return true;
    }
    if (event.type !== 'audio' || !['running', 'stopping'].includes(state.phase)) return false;
    if (Number.isSafeInteger(event.sequence) && event.sequence < state.sequence) return false;
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== state.sequence) { this._fail(state, 'capture'); return false; }
    const bytes = event.buffer;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > 8192 || bytes.byteLength % 2) { this._fail(state, 'capture'); return false; }
    const at = this.now();
    const elapsed = Math.max(0, at - state.lastAt);
    state.lastAt = Math.max(state.lastAt, at);
    state.credit = Math.min(16384, state.credit + elapsed * 32);
    state.messages = Math.min(64, state.messages + elapsed * 0.064);
    if (bytes.byteLength > state.credit || state.messages < 1) {
      this._fail(state, 'capture');
      return false;
    }
    state.credit -= bytes.byteLength;
    state.messages--;
    state.sequence++;
    try { this.onAudio(Buffer.from(new Uint8Array(bytes))); }
    catch (_) { this._fail(state, 'capture'); return false; }
    return true;
  }

  stop() {
    const state = this.current;
    if (!state) return Promise.resolve();
    if (state.phase === 'starting') { this.cancel(); return Promise.resolve(); }
    if (state.stopPromise) return state.stopPromise;
    state.phase = 'stopping';
    state.stopPromise = new Promise(resolve => { state.stopped = resolve; });
    state.timer = setTimeout(() => {
      if (this.current !== state) return;
      this._finish(state, { incomplete: true });
      try { this.send(state.owner, { action: 'cancel', sessionId: state.sessionId }); } catch (_) {}
    }, this.stopTimeoutMs);
    try { this.send(state.owner, { action: 'stop', sessionId: state.sessionId }); }
    catch (_) { this._fail(state, 'capture'); }
    return state.stopPromise;
  }

  cancel() {
    const state = this.current;
    if (!state) return;
    this._finish(state, { incomplete: state.phase === 'stopping' });
    try { this.send(state.owner, { action: 'cancel', sessionId: state.sessionId }); } catch (_) {}
  }

  _finish(state, result = { incomplete: false }) {
    if (this.current !== state) return;
    this.current = null;
    clearTimeout(state.timer);
    if (state.phase === 'starting') state.reject(new Error('Microphone start cancelled.'));
    state.stopped?.(result);
  }

  _fail(state, code) {
    if (this.current !== state) return;
    this.cancel();
    this.onError(new Error(MICROPHONE_ERRORS[code]));
  }
}
module.exports = { RendererAudioSession };
