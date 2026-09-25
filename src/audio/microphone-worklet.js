import './pcm16-encoder.js';

class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.encoder = new globalThis.Pcm16Encoder(sampleRate);
    this.pending = new Int16Array(640); // 40 ms at 16 kHz, independent of hardware rate
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.action !== 'stop' || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: 'stopped' });
    };
  }

  flush() {
    if (!this.length) return;
    const buffer = new ArrayBuffer(this.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this.length; i++) view.setInt16(i * 2, this.pending[i], true);
    this.length = 0;
    this.port.postMessage({ type: 'audio', buffer }, [buffer]);
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i++) mono[i] += (Number.isFinite(channel[i]) ? channel[i] : 0) / channels.length;
    }
    for (const sample of this.encoder.push(mono)) {
      this.pending[this.length++] = sample;
      if (this.length === this.pending.length) this.flush();
    }
    return true;
  }
}
registerProcessor('owned-microphone', MicrophoneProcessor);
