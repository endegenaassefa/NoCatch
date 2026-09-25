// Shared by Node tests and the AudioWorklet. Each input sample spans 16000
// ticks; each output sample spans `rate` ticks. Carry the partially integrated
// sample between pushes, so callback boundaries never change timing or PCM.
(function (root) {
  'use strict';
  class Pcm16Encoder {
    constructor(rate) {
      if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('Invalid sample rate');
      this.rate = rate;
      this.ticks = 0;
      this.area = 0;
    }

    push(input) {
      if (!(input instanceof Float32Array)) throw new TypeError('Expected mono Float32Array');
      const output = [];
      for (const sample of input) {
        const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
        let remaining = 16000;
        while (remaining > 0) {
          const width = Math.min(remaining, this.rate - this.ticks);
          this.area += value * width;
          this.ticks += width;
          remaining -= width;
          if (this.ticks >= this.rate) {
            const normalized = Math.max(-1, Math.min(1, this.area / this.rate));
            output.push(Math.round(normalized * (normalized < 0 ? 32768 : 32767)));
            this.ticks = 0;
            this.area = 0;
          }
        }
      }
      return Int16Array.from(output);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { Pcm16Encoder };
  else root.Pcm16Encoder = Pcm16Encoder;
})(globalThis);
