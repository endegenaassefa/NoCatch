'use strict';
// Offline fixtures: never read .env, instantiate the app, acquire hardware or
// contact a provider. The immutable coordinator checker remains separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { Pcm16Encoder } = require('../src/audio/pcm16-encoder');
const { RendererAudioSession } = require('../src/core/renderer-audio-session');
const { MicrophoneCapture } = require('../src/ui/microphone-capture');
const { assertMicrophoneOwner } = require('../src/core/microphone-owner');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const quiet = new Proxy({}, { get: () => () => {} });

for (const rate of [8000, 16000, 22050, 44100, 48000, 96000]) {
  test(`PCM duration and varying waveform survive arbitrary splits at ${rate} Hz`, () => {
    const input = Float32Array.from({ length: rate + 173 }, (_, i) => Math.sin(i * 0.09) * 0.8);
    const expected = new Pcm16Encoder(rate).push(input);
    assert.equal(expected.length, Math.floor(input.length * 16000 / rate));
    const encoder = new Pcm16Encoder(rate), actual = [];
    for (let offset = 0; offset < input.length;) {
      const end = Math.min(input.length, offset + (offset % 277) + 1);
      actual.push(...encoder.push(input.subarray(offset, end)));
      encoder.push(new Float32Array());
      offset = end;
    }
    assert.deepEqual(actual, Array.from(expected));
    assert.deepEqual(Array.from(new Pcm16Encoder(16000).push(Float32Array.from([-2, 2, NaN, Infinity, -Infinity]))), [-32768, 32767, 0, 0, 0]);
  });
}

test('worklet produces bounded 16 kHz stereo downmix messages, silent output and one final tail', () => {
  let Processor;
  const messages = [];
  const context = vm.createContext({ Float32Array, Int16Array, DataView, ArrayBuffer, sampleRate: 44100,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: p => messages.push(p) }; } },
    registerProcessor: (_name, type) => { Processor = type; },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/audio/pcm16-encoder.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'src/audio/microphone-worklet.js'), 'utf8').replace(/^import .*;\n/, ''), context);
  const processor = new Processor();
  for (let i = 0; i < 44100; i += 128) {
    const n = Math.min(128, 44100 - i), output = new Float32Array(n).fill(1);
    assert.equal(processor.process([[new Float32Array(n).fill(0.2), new Float32Array(n).fill(0.6)]], [[output]]), true);
    assert(output.every(v => v === 0));
  }
  processor.port.onmessage({ data: { action: 'stop' } });
  const count = messages.length;
  processor.port.onmessage({ data: { action: 'stop' } });
  assert.equal(messages.length, count);
  assert.equal(messages.at(-1).type, 'stopped');
  const audio = messages.filter(p => p.type === 'audio');
  assert(audio.length <= 26);
  assert(audio.every(p => p.buffer.byteLength <= 1280));
  assert.equal(audio.reduce((n, p) => n + p.buffer.byteLength, 0), 32000);
  assert(audio.every(p => Array.from(new Int16Array(p.buffer)).every(v => Math.abs(v - 13107) <= 1)));
});

function protocol(overrides = {}) {
  const owner = {}, messages = [], audio = [], errors = [];
  const session = new RendererAudioSession({ send: (o, p) => { assert.equal(o, owner); messages.push(p); }, onAudio: b => audio.push(b), onError: e => errors.push(e), readyTimeoutMs: 100, stopTimeoutMs: 20, ...overrides });
  const ready = async () => { const p = session.start(owner); const id = messages.at(-1).sessionId; session.receive(owner, { type: 'ready', sessionId: id }); await p; return id; };
  return { session, owner, messages, audio, errors, ready };
}
test('protocol rejects malformed, skipped, duplicate, wrong-owner and stale frames; drains once', async () => {
  const f = protocol(); const id = await f.ready();
  const frame = { type: 'audio', sessionId: id, sequence: 0, buffer: new ArrayBuffer(4) };
  assert.equal(f.session.receive({}, frame), false);
  assert(f.session.receive(f.owner, frame));
  assert.equal(f.session.receive(f.owner, frame), false);
  const stop = f.session.stop(); assert.equal(f.session.stop(), stop);
  assert(f.session.receive(f.owner, { ...frame, sequence: 1 }));
  f.session.receive(f.owner, { type: 'stopped', sessionId: id }); await stop;
  assert.equal(f.audio.length, 2);
  assert.equal(f.session.receive(f.owner, { ...frame, sequence: 2 }), false);
  const next = await f.ready(); assert.notEqual(next, id);
  assert.equal(f.session.receive(f.owner, frame), false);
  f.session.cancel();
});
test('malformed or skipped frames from the active owner fail the session instead of wedging it', async () => {
  for (const buffer of [null, [], new Uint8Array(4), new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(8194), new SharedArrayBuffer(4)]) {
    const f = protocol(), sessionId = await f.ready();
    assert.equal(f.session.receive(f.owner, { type: 'audio', sessionId, sequence: 0, buffer }), false);
    assert.equal(f.session.current, null); assert.equal(f.errors.length, 1); assert.equal(f.audio.length, 0);
  }
  const f = protocol(), sessionId = await f.ready();
  assert.equal(f.session.receive(f.owner, { type: 'audio', sessionId, sequence: 1, buffer: new ArrayBuffer(4) }), false);
  assert.equal(f.session.current, null); assert.equal(f.errors.length, 1);
});
test('stop timeout preserves accepted audio and reports missing tail; malformed error code is safe', async () => {
  const f = protocol(), sessionId = await f.ready();
  f.session.receive(f.owner, { type: 'audio', sessionId, sequence: 0, buffer: new ArrayBuffer(4) });
  assert.deepEqual(await f.session.stop(), { incomplete: true });
  assert.equal(f.audio.length, 1); assert.equal(f.errors.length, 0); assert.equal(f.session.current, null);
  const id = await f.ready();
  assert.doesNotThrow(() => f.session.receive(f.owner, { type: 'error', sessionId: id, code: { toString: null, valueOf: null } }));
  assert.equal(f.session.current, null); assert.equal(f.errors.length, 1);
});
test('protocol limits aggregate byte rate and message rate and bounds unresponsive stop', async () => {
  let now = 0; const f = protocol({ now: () => now }); const id = await f.ready();
  const frame = sequence => ({ type: 'audio', sessionId: id, sequence, buffer: new ArrayBuffer(8192) });
  assert(f.session.receive(f.owner, frame(0))); assert(f.session.receive(f.owner, frame(1)));
  now = 256; assert(f.session.receive(f.owner, frame(2)));
  assert.equal(f.session.receive(f.owner, frame(3)), false); assert.equal(f.errors.length, 1);
  const next = await f.ready();
  for (let i = 0; i < 64; i++) assert(f.session.receive(f.owner, { type: 'audio', sessionId: next, sequence: i, buffer: new ArrayBuffer(2) }));
  assert.equal(f.session.receive(f.owner, { type: 'audio', sessionId: next, sequence: 64, buffer: new ArrayBuffer(2) }), false);
  await f.ready(); await f.session.stop(); assert.equal(f.session.current, null);
  assert.equal(f.messages.at(-1).action, 'cancel');
});
test('throwing stop transport cannot report a complete tail', async () => {
  const f = protocol(); await f.ready(); f.session.send = () => { throw new Error('owner gone'); };
  assert.deepEqual(await f.session.stop(), { incomplete: true });
  assert.equal(f.session.current, null); assert.equal(f.errors.length, 1);
});
test('pending protocol start rejects on cancellation, failure and timeout without raw error disclosure', async () => {
  const f = protocol({ readyTimeoutMs: 5 });
  const pending = f.session.start(f.owner); f.session.cancel(); await assert.rejects(pending);
  const denied = f.session.start(f.owner);
  f.session.receive(f.owner, { type: 'error', sessionId: f.messages.at(-1).sessionId, code: 'sensitive device details' });
  await assert.rejects(denied); assert(!f.errors[0].message.includes('sensitive'));
  await assert.rejects(f.session.start(f.owner)); assert.equal(f.session.current, null);
});

function microphone(options = {}) {
  const events = [], tracks = [], contexts = [], nodes = [];
  function stream() {
    const track = new EventTarget(); track.stops = 0; track.readyState = 'live'; track.stop = () => { track.stops++; track.readyState = 'ended'; };
    tracks.push(track); return { getTracks: () => [track] };
  }
  class Context {
    constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = {}; this.audioWorklet = { addModule: () => options.module ? options.module.promise : Promise.resolve() }; contexts.push(this); }
    createMediaStreamSource() { this.source = { connect() { if (options.connectError) throw Error('raw device'); }, disconnect() { this.disconnected = true; } }; return this.source; }
    async resume() { if (options.resume) await options.resume.promise; this.state = 'running'; }
    async close() { this.closed = true; this.state = 'closed'; }
  }
  class Node {
    constructor() { nodes.push(this); this.port = { postMessage: p => { this.command = p; }, close: () => { this.closed = true; } }; }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  let prompts = 0;
  const capture = new MicrophoneCapture({ api: { sendMicrophoneEvent: p => events.push(p) }, mediaDevices: { getUserMedia: async () => { prompts++; if (options.permission) return options.permission.promise; return stream(); } }, AudioContext: Context, AudioWorkletNode: Node });
  return { capture, events, tracks, contexts, nodes, stream, get prompts() { return prompts; } };
}
const idA = 'a'.repeat(64), idB = 'b'.repeat(64);
test('renderer does not acquire until start; stop/cancel during pending permission stops late tracks', async () => {
  for (const action of ['cancel', 'stop']) {
    const permission = deferred(), f = microphone({ permission }); assert.equal(f.prompts, 0);
    const pending = f.capture.handle({ action: 'start', sessionId: idA }); await tick();
    await f.capture.handle({ action, sessionId: idA }); permission.resolve(f.stream()); await pending;
    assert.equal(f.tracks[0].stops, 1); assert.equal(f.contexts.length, 0);
    assert(!f.events.some(p => ['ready', 'audio'].includes(p.type)));
  }
});
test('renderer cancels during worklet load/resume and old cleanup cannot close a newer session', async () => {
  for (const stage of ['module', 'resume']) {
    const pendingStage = deferred(), f = microphone({ [stage]: pendingStage });
    const first = f.capture.handle({ action: 'start', sessionId: idA }); await tick();
    await f.capture.handle({ action: 'cancel', sessionId: idA });
    const second = f.capture.handle({ action: 'start', sessionId: idB }); await tick();
    pendingStage.resolve(); await Promise.all([first, second]);
    assert.equal(f.tracks[0].stops, 1); assert(f.contexts[0].closed);
    assert.equal(f.tracks[1].stops, 0); assert(!f.contexts[1].closed);
    assert.deepEqual(f.events.filter(p => p.type === 'ready').map(p => p.sessionId), [idB]);
    await f.capture.handle({ action: 'cancel', sessionId: idA }); assert(f.capture.current);
    f.capture.dispose(); assert.equal(f.tracks[1].stops, 1);
  }
});
test('renderer releases hardware before stop ACK while delivering final PCM in order', async () => {
  const f = microphone(); await f.capture.handle({ action: 'start', sessionId: idA });
  const n = f.nodes[0]; n.port.onmessage({ data: { type: 'audio', buffer: new ArrayBuffer(4) } });
  const stopping = f.capture.handle({ action: 'stop', sessionId: idA });
  assert.equal(f.tracks[0].stops, 1); assert(!f.contexts[0].closed);
  n.port.onmessage({ data: { type: 'audio', buffer: new ArrayBuffer(2) } });
  n.port.onmessage({ data: { type: 'stopped' } }); await stopping;
  assert.deepEqual(f.events.map(p => p.type), ['ready', 'audio', 'audio', 'stopped']);
  assert.deepEqual(f.events.filter(p => p.type === 'audio').map(p => p.sequence), [0, 1]);
  assert(f.contexts[0].closed && n.closed && n.disconnected && f.contexts[0].source.disconnected);
  assert.equal(f.tracks[0].stops, 1);
});
test('renderer handles denied permission, graph failure, device loss and worklet errors safely', async () => {
  const permission = deferred(), denied = microphone({ permission });
  const starting = denied.capture.handle({ action: 'start', sessionId: idA });
  permission.reject(Object.assign(Error('sensitive hardware identifier'), { name: 'NotAllowedError' })); await starting;
  assert.deepEqual(denied.events.map(p => [p.type, p.code]), [['error', 'permission']]);
  for (const failure of ['connect', 'ended', 'processor', 'suspended']) {
    const f = microphone({ connectError: failure === 'connect' }); await f.capture.handle({ action: 'start', sessionId: idA });
    if (failure === 'ended') f.tracks[0].dispatchEvent(new Event('ended'));
    if (failure === 'processor') f.nodes[0].onprocessorerror();
    if (failure === 'suspended') { f.contexts[0].state = 'suspended'; f.contexts[0].onstatechange(); }
    assert.equal(f.tracks[0].stops, 1); assert(f.contexts[0].closed); assert.equal(f.capture.current, null);
    assert.equal(f.events.filter(p => p.type === 'error').length, 1);
    assert(!JSON.stringify(f.events).includes('sensitive'));
  }
});

function speechFixture(platform = 'win32', options = {}) {
  const recognizers = [], writes = [], recordings = [];
  const sdk = {
    AudioStreamFormat: { getWaveFormatPCM: (rate, bits, channels) => { assert.deepEqual([rate, bits, channels], [16000, 16, 1]); return {}; } },
    AudioInputStream: { createPushStream: () => ({ write: b => writes.push(Buffer.from(b)), close() { this.closed = true; } }) },
    AudioConfig: { fromStreamInput: () => ({ close() {} }) },
    ResultReason: { RecognizingSpeech: 1, RecognizedSpeech: 2 }, CancellationReason: { Error: 1 },
    SpeechRecognizer: class {
      constructor() { recognizers.push(this); }
      startContinuousRecognitionAsync(ok, fail) { this.startOK = ok; this.startFail = fail; if (!options.pendingAzure) ok(); }
      stopContinuousRecognitionAsync(ok) { this.stopOK = ok; if (!options.pendingStop) ok(); }
      close() { this.closed = true; }
    },
  };
  class Worker { isConfigured() { return false; } close() {} releaseWhenIdle() {} }
  const file = path.join(root, 'src/services/speech.service.js');
  const localRequire = createRequire(file);
  const code = fs.readFileSync(file, 'utf8').replace(/module\.exports = new SpeechService\(\);/, 'module.exports = SpeechService;');
  const sandbox = { module: { exports: {} }, require: name => {
    if (name === '../core/logger') return { createServiceLogger: () => quiet };
    if (name === '../core/config') return { get: () => undefined };
    if (name === './whisper-worker.service') return Worker;
    if (name === 'microsoft-cognitiveservices-speech-sdk') return options.sdk || sdk;
    if (name === 'node-record-lpcm16') return { record: () => {
      const stream = new EventEmitter(), recording = { stream: () => stream, stop() { this.stopped = true; } };
      recordings.push(recording); return recording;
    } };
    return localRequire(name);
  }, process: { platform, env: {} }, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, console };
  vm.runInNewContext(code, sandbox, { filename: file });
  sandbox.module.exports.prototype._getConfiguredProvider = () => 'disabled';
  const s = new sandbox.module.exports(); const events = [];
  for (const event of ['error', 'transcription', 'interim-transcription', 'recording-started', 'recording-stopped', 'status']) s.on(event, value => events.push([event, value]));
  Object.assign(s, { provider: 'whisper', available: true, speechConfig: {}, whisperCommand: {}, _isManualCaptureMode: () => true });
  s._audioProgramExists = () => true;
  return { s, events, writes, recognizers, recordings, sandbox };
}
for (const platform of ['win32', 'darwin']) {
  for (const provider of ['azure', 'whisper']) {
    test(`${platform} ${provider} uses owned renderer, routes PCM and stops exactly once without native recorder`, async () => {
      const f = speechFixture(platform), s = f.s; s.provider = provider;
      let starts = 0, stops = 0;
      s.setRendererCapture({ start: async () => { starts++; }, stop: async () => { stops++; s.handleAudioChunkFromRenderer(Buffer.from([3, 0])); }, cancel() {} });
      const buffers = []; s._transcribeWhisperBuffer = async b => { buffers.push(b); return 'kept'; };
      await s.startRecording(); s.handleAudioChunkFromRenderer(Buffer.from([1, 0]));
      const first = s.stopRecording(); assert.equal(first, s.stopRecording()); await first;
      assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(f.recordings.length, 0);
      assert.deepEqual(Buffer.concat(provider === 'azure' ? f.writes : buffers), Buffer.from([1, 0, 3, 0]));
      assert.equal(s.isRecording, false); assert.equal(s.isProcessingAudio, false);
      if (provider === 'whisper') assert.deepEqual(f.events.filter(e => e[0] === 'transcription'), [['transcription', 'kept']]);
      assert.equal(f.events.filter(e => e[0] === 'recording-stopped').length, 1);
      s.cancelRecording();
    });
  }
}
test('Linux keeps native recorder and ignores renderer PCM', async () => {
  const f = speechFixture('linux'); f.s.setRendererCapture({ start() { assert.fail('renderer on Linux'); }, stop() {}, cancel() {} });
  f.s._transcribeWhisperBuffer = async () => '';
  await f.s.startRecording(); assert.equal(f.recordings.length, 1);
  f.s.handleAudioChunkFromRenderer(Buffer.from([1, 0])); assert.equal(f.s.segmentBytes, 0);
  f.recordings[0].stream().emit('data', Buffer.from([2, 0])); assert.equal(f.s.segmentBytes, 2);
  await f.s.stopRecording(); assert(f.recordings[0].stopped);
});
test('Whisper stop waits for in-flight transcription and final renderer tail once', async () => {
  const f = speechFixture(), s = f.s, first = deferred(), second = deferred(); let count = 0;
  s.setRendererCapture({ start: async () => {}, stop: async () => s.handleAudioChunkFromRenderer(Buffer.from([2, 0])), cancel() {} });
  s._transcribeWhisperBuffer = () => (++count === 1 ? first.promise : second.promise);
  await s.startRecording(); s.handleAudioChunkFromRenderer(Buffer.from([1, 0])); const flushing = s._flushWhisperSegment({ final: false });
  let done = false; const stopping = s.stopRecording().then(() => { done = true; }); await tick();
  assert(!done); first.resolve('first'); await tick(); assert(!done); assert.equal(count, 2);
  second.resolve('tail'); await Promise.all([flushing, stopping]);
  assert.deepEqual(f.events.filter(e => e[0] === 'transcription').map(e => e[1]), ['first', 'tail']);
  assert.equal(count, 2);
});
test('cancellation discards pending Whisper output and old stop cleanup cannot close a newer session', async () => {
  const f = speechFixture(), s = f.s, pending = deferred(); let releases = 0;
  s.whisperWorker.releaseWhenIdle = () => releases++;
  s.setRendererCapture({ start: async () => {}, stop: async () => {}, cancel() {} });
  s._transcribeWhisperBuffer = () => pending.promise;
  await s.startRecording(); s.handleAudioChunkFromRenderer(Buffer.from([1, 0]));
  const stopping = s.stopRecording(); await tick(); s.cancelRecording(); await s.startRecording();
  pending.resolve('must not appear'); await stopping;
  assert(s.isRecording); assert.equal(releases, 0); assert(!f.events.some(e => e[0] === 'transcription'));
  s.cancelRecording();
});
test('incomplete microphone stop still transcribes already accepted PCM once', async () => {
  const f = speechFixture(), s = f.s, buffers = [];
  s.setRendererCapture({ start: async () => {}, stop: async () => ({ incomplete: true }), cancel() {} });
  s._transcribeWhisperBuffer = async b => { buffers.push(b); return 'received words'; };
  await s.startRecording(); s.handleAudioChunkFromRenderer(Buffer.from([1, 0, 2, 0])); await s.stopRecording();
  assert.equal(buffers.length, 1); assert.equal(buffers[0].length, 4);
  assert.deepEqual(f.events.filter(e => e[0] === 'transcription'), [['transcription', 'received words']]);
  assert.match(f.events.filter(e => e[0] === 'status').at(-1)[1], /final audio could not be recovered/);
});
test('Azure stale start/recognizer callbacks are inert after cancel and provider replacement', async () => {
  const f = speechFixture('darwin', { pendingAzure: true }), s = f.s; s.provider = 'azure';
  s.setRendererCapture({ start: async () => {}, stop: async () => {}, cancel() {} });
  const starting = s.startRecording(); await tick(); const old = f.recognizers[0], recognized = old.recognized, canceled = old.canceled;
  s.cancelRecording(); await starting; assert(old.closed);
  s.provider = 'whisper'; await s.startRecording();
  old.startFail('raw provider details'); old.startOK();
  recognized(null, { result: { reason: 2, text: 'stale' } }); canceled(null, { reason: 1 });
  assert(s.isRecording); assert(!f.events.some(e => ['transcription', 'error'].includes(e[0])));
  s.cancelRecording();
});
test('Azure stop releases capture before provider callback, accepts final results, then rejects stale results', async () => {
  const f = speechFixture('win32', { pendingStop: true }), s = f.s; s.provider = 'azure'; let released = false;
  s.setRendererCapture({ start: async () => {}, stop: async () => { released = true; }, cancel() {} });
  await s.startRecording(); const rec = f.recognizers[0], recognized = rec.recognized;
  const stop = s.stopRecording(); await tick(); assert(released); assert(!rec.closed);
  recognized(null, { result: { reason: 2, text: 'final' } }); rec.stopOK(); await stop;
  recognized(null, { result: { reason: 2, text: 'late' } });
  assert.deepEqual(f.events.filter(e => e[0] === 'transcription').map(e => e[1]), ['final']);
});
test('SDK push-stream construction works in Node without fake browser globals or microphone access', async () => {
  const originals = { URL: globalThis.URL, Blob: globalThis.Blob, window: globalThis.window };
  const sdk = require('microsoft-cognitiveservices-speech-sdk');
  const f = speechFixture('win32', { sdk });
  f.s.provider = 'azure'; f.s.speechConfig = sdk.SpeechConfig.fromSubscription('offline-fixture', 'westus');
  const result = await f.s.testConnection(); assert.equal(result.success, true, result.message);
  assert.equal(f.sandbox.window, undefined); assert.equal(f.sandbox.URL, undefined); assert.equal(f.sandbox.Blob, undefined);
  assert.equal(globalThis.URL, originals.URL); assert.equal(globalThis.Blob, originals.Blob); assert.equal(globalThis.window, originals.window);
  f.s.cancelRecording();
});
test('microphone IPC requires index owner identity and main frame', () => {
  const frame = { url: pathToFileURL(path.join(root, 'index.html')).href }, owner = { mainFrame: frame };
  assert.doesNotThrow(() => assertMicrophoneOwner({ sender: owner, senderFrame: frame }, owner, root));
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: owner, senderFrame: { ...frame } }, { sender: owner }]) {
    assert.throws(() => assertMicrophoneOwner(event, owner, root));
  }
  for (const url of [pathToFileURL(path.join(root, 'chat.html')).href, 'https://example.invalid/index.html']) {
    frame.url = url; assert.throws(() => assertMicrophoneOwner({ sender: owner, senderFrame: frame }, owner, root));
  }
});
