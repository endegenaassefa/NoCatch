(function (root) {
  'use strict';
  class MicrophoneCapture {
    constructor({ api, mediaDevices = root.navigator?.mediaDevices, AudioContext = root.AudioContext,
      AudioWorkletNode = root.AudioWorkletNode, workletUrl = './src/audio/microphone-worklet.js' }) {
      Object.assign(this, { api, mediaDevices, AudioContext, AudioWorkletNode, workletUrl });
      this.current = null;
    }

    async handle(command) {
      if (!command || typeof command.sessionId !== 'string' || !/^[a-f0-9]{32,128}$/.test(command.sessionId)) return;
      if (command.action === 'start') {
        if (this.current?.sessionId === command.sessionId) return;
        this.dispose();
        return this.start(command.sessionId);
      }
      const state = this.current;
      if (!state || command.sessionId !== state.sessionId) return;
      if (command.action === 'cancel') this.dispose();
      else if (command.action === 'stop') return this.stop(state);
    }

    send(state, event) {
      if (this.current === state) this.api.sendMicrophoneEvent({ ...event, sessionId: state.sessionId });
    }

    async start(sessionId) {
      const state = { sessionId, sequence: 0, phase: 'starting' };
      this.current = state;
      try {
        if (!this.mediaDevices?.getUserMedia || !this.AudioContext || !this.AudioWorkletNode) {
          // Still allow getUserMedia denial to produce the permission-specific error.
          if (!this.mediaDevices?.getUserMedia) throw { name: 'NotSupportedError' };
        }
        const stream = await this.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
        });
        if (this.current !== state) { for (const track of stream.getTracks()) track.stop(); return; }
        state.stream = stream;
        state.ended = () => this.fail(state, 'lost');
        for (const track of stream.getTracks()) track.addEventListener?.('ended', state.ended);
        if (stream.getTracks().some(track => track.readyState === 'ended')) throw { name: 'NotFoundError' };
        if (!this.AudioContext || !this.AudioWorkletNode) throw { name: 'NotSupportedError' };
        const context = state.context = new this.AudioContext();
        await context.audioWorklet.addModule(this.workletUrl);
        if (this.current !== state) return;
        state.node = new this.AudioWorkletNode(context, 'owned-microphone', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        });
        state.node.onprocessorerror = () => this.fail(state, 'capture');
        state.node.port.onmessage = ({ data }) => {
          if (this.current !== state) return;
          if (data?.type === 'audio' && ['running', 'stopping'].includes(state.phase)) {
            this.send(state, { type: 'audio', sequence: state.sequence++, buffer: data.buffer });
          } else if (data?.type === 'stopped' && state.phase === 'stopping') {
            this.finishStop(state);
          }
        };
        state.source = context.createMediaStreamSource(stream);
        await context.resume();
        if (this.current !== state) return;
        if (context.state !== 'running') throw { name: 'NotReadableError' };
        state.phase = 'running';
        context.onstatechange = () => {
          if (state.phase === 'running' && context.state !== 'running') this.fail(state, 'lost');
        };
        state.source.connect(state.node);
        state.node.connect(context.destination); // processor always emits silence
        // A failed graph connection must never announce a usable microphone.
        this.send(state, { type: 'ready' });
      } catch (error) {
        const code = ({ NotAllowedError: 'permission', SecurityError: 'permission',
          NotFoundError: 'device', NotReadableError: 'busy', NotSupportedError: 'unsupported' })[error?.name] || 'capture';
        this.fail(state, code);
      }
    }

    releaseInput(state) {
      try { state.source?.disconnect(); } catch (_) {}
      for (const track of state.stream?.getTracks() || []) {
        track.removeEventListener?.('ended', state.ended);
        try { track.stop(); } catch (_) {}
      }
      state.stream = null;
    }

    stop(state) {
      if (state.stopPromise) return state.stopPromise;
      if (state.phase === 'starting') { this.finishStop(state); return; }
      state.phase = 'stopping';
      state.stopPromise = new Promise(resolve => { state.resolveStop = resolve; });
      // Release hardware immediately, keeping the worklet alive just long enough
      // to drain its already encoded tail, then acknowledge after those messages.
      this.releaseInput(state);
      state.timer = setTimeout(() => this.finishStop(state, true), 500);
      try { state.node.port.postMessage({ action: 'stop' }); }
      catch (_) { this.fail(state, 'capture'); }
      return state.stopPromise;
    }

    finishStop(state, incomplete = false) {
      if (this.current !== state) return;
      this.send(state, { type: 'stopped', incomplete });
      this.dispose();
    }

    fail(state, code) {
      if (this.current !== state) return;
      this.send(state, { type: 'error', code });
      this.dispose();
    }

    dispose() {
      const state = this.current;
      if (!state) return;
      this.current = null;
      clearTimeout(state.timer);
      this.releaseInput(state);
      if (state.node) {
        state.node.port.onmessage = null;
        state.node.onprocessorerror = null;
        try { state.node.disconnect(); } catch (_) {}
        try { state.node.port.close(); } catch (_) {}
      }
      if (state.context) {
        state.context.onstatechange = null;
        try { Promise.resolve(state.context.close()).catch(() => {}); } catch (_) {}
      }
      state.resolveStop?.();
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { MicrophoneCapture };
  else root.MicrophoneCapture = MicrophoneCapture;
})(globalThis);
