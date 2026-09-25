const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const config = require('../core/config');
const WhisperWorkerService = require('./whisper-worker.service');
const { resolveWhisperRuntime } = require('../core/whisper-runtime');

let sdk = null;
try {
  sdk = require('microsoft-cognitiveservices-speech-sdk');
} catch (error) {
  logger.warn('Azure Speech SDK unavailable', { error: error.message });
}

let recorder = null;
try {
  recorder = require('node-record-lpcm16');
} catch (error) {
  logger.warn('Local audio recorder dependency unavailable', { error: error.message });
}

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.recognizer = null;
    this.isRecording = false;
    this.audioConfig = null;
    this.speechConfig = null;
    this.sessionStartTime = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.pushStream = null;
    this.recording = null;
    this.available = false;
    this.provider = 'disabled';
    this.runtimeSettings = {};
    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.segmentTimer = null;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this.audioProgram = null;
    this.whisperCommand = null;
    this.whisperWorker = new WhisperWorkerService();
    this.isProcessingAudio = false;
    this.manualStopRequested = false;
    this._resetVadState();

    this.initializeClient();
  }

  initializeClient() {
    this.cancelRecording();
    this.provider = 'disabled';
    this.available = false;
    this.speechConfig = null;
    this.whisperCommand = null;

    const provider = this._getConfiguredProvider();
    this.provider = provider;

    if (provider === 'azure') {
      this._initializeAzureClient();
      return;
    }

    if (provider === 'whisper') {
      this._initializeWhisperClient();
      return;
    }

    const reason = 'Speech recognition disabled. Configure Azure or local Whisper.';
    logger.warn(reason);
    this.emit('status', reason);
  }

  _initializeAzureClient() {
    try {
      if (!sdk) {
        throw new Error('Azure Speech SDK dependency is not installed');
      }

      if (process.platform === 'linux' && (!recorder || typeof recorder.record !== 'function')) {
        throw new Error('Local microphone recorder dependency is not installed');
      }

      const subscriptionKey = this._getSetting('azureKey') || process.env.AZURE_SPEECH_KEY;
      const region = this._getSetting('azureRegion') || process.env.AZURE_SPEECH_REGION;

      // Treat placeholder values (your_*_here) as missing — they used to
      // count as valid credentials, which showed a fake mic button and a
      // false "configured" status in first-run (R1/R2 audit finding).
      const isPlaceholder = (value) =>
        !value || /^your[_ ]/i.test(value || '') || /_here$/i.test(value || '');

      if (!subscriptionKey || !region || isPlaceholder(subscriptionKey) || isPlaceholder(region)) {
        const reason = 'Azure Speech credentials not found. Speech recognition disabled.';
        logger.warn('Speech service disabled (missing Azure credentials)');
        this.emit('status', reason);
        return;
      }

      this.speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, region);

      const azureConfig = config.get('speech.azure') || {};
      this.speechConfig.speechRecognitionLanguage = azureConfig.language || 'en-US';
      this.speechConfig.outputFormat = sdk.OutputFormat.Detailed;
      this.speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, '5000');
      this.speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '2000');
      this.speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, '2000');

      if (azureConfig.enableDictation) {
        this.speechConfig.enableDictation();
      }

      if (azureConfig.enableAudioLogging) {
        this.speechConfig.enableAudioLogging();
      }

      this.available = true;
      logger.info('Azure Speech service initialized successfully', {
        region,
        language: azureConfig.language || 'en-US'
      });
      this.emit('status', 'Azure Speech Services ready');
    } catch (error) {
      logger.error('Failed to initialize Azure Speech client', {
        error: error.message,
        stack: error.stack
      });
      this.available = false;
      this.emit('status', 'Azure speech unavailable');
    }
  }

  _initializeWhisperClient() {
    try {
      this.whisperCommand = this._resolveWhisperCommand();
      if (!this.whisperCommand) {
        const reason = 'Local Whisper unavailable. Install the Whisper CLI or set WHISPER_COMMAND.';
        logger.warn(reason);
        this.emit('status', reason);
        return;
      }

      this.available = this.whisperCommand.kind !== 'bundled' ||
        this.modelPreparation?.isReady?.(this._getWhisperModel()) === true;
      this._configureWhisperWorker();
      logger.info('Local Whisper service initialized successfully', {
        command: [this.whisperCommand.command, ...this.whisperCommand.baseArgs].join(' '),
        model: this._getWhisperModel(),
        language: this._getWhisperLanguage()
      });
      this.emit('status', this.available ? 'Local Whisper ready' : 'Prepare the selected voice model in Settings before recording.');
    } catch (error) {
      logger.error('Failed to initialize local Whisper client', {
        error: error.message,
        stack: error.stack
      });
      this.available = false;
      this.emit('status', error.code?.startsWith('BUNDLED_RUNTIME_') ? error.message : 'Local Whisper unavailable');
    }
  }

  setRendererCapture(adapter) {
    this.cancelRecording();
    this.rendererCapture = adapter;
  }

  setModelPreparation(service) {
    this.modelPreparation = service;
  }

  startRecording() {
    if (this._shutdownPromise) return Promise.resolve();
    if (this.whisperCommand?.kind !== 'bundled' || this.provider !== 'whisper' ||
        !this.available || this.isRecording || this.isProcessingAudio || this._stopping) {
      return this._startRecordingReady();
    }
    if (this._preparingRecordingPromise) return this._preparingRecordingPromise;
    const generation = this._generation || 0;
    const pending = Promise.resolve().then(async () => {
      if (!this.modelPreparation) throw new Error('Prepare the selected voice model in Settings before recording.');
      const checkpoint = await this.modelPreparation.requireReady(this._getWhisperModel());
      if ((this._generation || 0) !== generation) return;
      this._preparedModelPath = checkpoint;
      return this._startRecordingReady();
    }).catch(error => {
      if ((this._generation || 0) === generation) this.emit('error', error.message);
    }).finally(() => {
      if (this._preparingRecordingPromise === pending) this._preparingRecordingPromise = null;
    });
    this._preparingRecordingPromise = pending;
    this.emit('status', 'Checking the selected voice model…');
    return pending;
  }

  _startRecordingReady() {
    if (!this.available) {
      this.emit('error', `Speech provider "${this.provider}" is not available`);
      return Promise.resolve();
    }
    if (this.isRecording) return this._startPromise || Promise.resolve();
    if (this.isProcessingAudio || this._stopping) {
      this.emit('status', 'Please wait for the current transcription to finish');
      return Promise.resolve();
    }
    this._cleanup();
    const generation = this._generation = (this._generation || 0) + 1;
    this.useRendererCapture = process.platform === 'win32' || process.platform === 'darwin';
    this.sessionStartTime = Date.now();
    this.isRecording = true;
    this._captureReady = false;
    this.manualStopRequested = false;
    this.emit('status', 'Waiting for microphone audio…');
    this._startPromise = (async () => {
      try {
        if (this.provider === 'azure') await this._startAzureRecording(generation);
        else if (this.provider === 'whisper') await this._startWhisperRecording(generation);
        else throw new Error('Unsupported speech provider');
        // Capture and provider startup must both belong to this live session.
        // A late Azure callback after stop/cancel cannot illuminate the UI.
        if (this._generation === generation && this.isRecording && this._captureReady && !this._stopping) {
          this.emit('recording-started');
        }
      } catch (_) {
        if (this._generation === generation) {
          this.cancelRecording();
          this.emit('error', 'Speech capture could not start. Check microphone access and the selected speech provider, then retry.');
        }
      }
    })();
    return this._startPromise;
  }

  async _startCapture(generation) {
    if (this.useRendererCapture) {
      if (!this.rendererCapture) throw new Error('Renderer capture unavailable');
      await this.rendererCapture.start();
    } else {
      this._startMicrophoneCapture();
    }
    if (this._generation !== generation || !this.isRecording || this._stopping) return false;
    this._captureReady = true;
    return true;
  }

  async _startAzureRecording(generation) {
    if (!this.speechConfig) throw new Error('Azure Speech client not initialized');
    this.pushStream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
    this.audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);
    const recognizer = this.recognizer = new sdk.SpeechRecognizer(this.speechConfig, this.audioConfig);
    const current = () => this._generation === generation && this.recognizer === recognizer;
    recognizer.recognizing = (_sender, event) => {
      if (current() && event.result.reason === sdk.ResultReason.RecognizingSpeech) {
        this.emit('interim-transcription', event.result.text);
      }
    };
    recognizer.recognized = (_sender, event) => {
      if (current() && event.result.reason === sdk.ResultReason.RecognizedSpeech && event.result.text?.trim()) {
        this.emit('transcription', event.result.text);
      }
    };
    recognizer.canceled = (_sender, event) => {
      if (!current()) return;
      if (event.reason === sdk.CancellationReason.Error) {
        this.cancelRecording();
        this.emit('error', 'Azure speech stopped. Check your connection and Azure speech settings, then retry.');
      } else if (!this._stopping) this.stopRecording();
    };
    recognizer.sessionStopped = () => {
      if (current() && !this._stopping) this.stopRecording();
    };
    if (!await this._startCapture(generation) || !current() || this._stopping) return;
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        if (this._abortAzureStart === abort) this._abortAzureStart = null;
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('Azure startup cancelled'));
      const timer = setTimeout(() => finish(new Error('Azure startup timed out')), 10000);
      this._abortAzureStart = abort;
      try {
        recognizer.startContinuousRecognitionAsync(() => finish(), () => finish(new Error('Azure startup failed')));
      } catch (_) { finish(new Error('Azure startup failed')); }
    });
    if (current() && !this._stopping) this.emit('status', 'Azure recording started');
  }

  async _startWhisperRecording(generation) {
    const model = this.whisperCommand?.kind === 'bundled' ? this._preparedModelPath : this._getWhisperModel();
    if (this.whisperCommand?.kind === 'bundled' && (!model || !path.isAbsolute(model))) {
      throw new Error('Prepare the selected voice model in Settings before recording.');
    }
    if (!await this._startCapture(generation)) return;
    this.emit('status', 'Local Whisper recording started');
    if (this.whisperWorker.isConfigured()) {
      try {
        // Optional warmup shares transcription's confirmed-exit barrier.
        this._assertWhisperProcessAvailable();
        this.whisperWorker.warmup({
          model, modelDir: this._getWhisperModelDir(), device: this._getWhisperDevice()
        }).catch(() => { /* Transcription retains the existing CLI fallback. */ });
      } catch (_) {
        // Capture can continue; transcription rechecks ownership before use.
      }
    }
    if (!this._isManualCaptureMode()) this._startSegmentWatchdog();
  }

  /**
   * Reset the voice-activity-detection state machine. VAD replaces the old
   * fixed-interval segmentation: instead of cutting audio every N seconds
   * (which split sentences mid-word and transcribed silent windows), we
   * accumulate audio while the user is speaking and flush a segment once a
   * natural pause is detected. State is intentionally simple so it works for
   * both the renderer (Web Audio) and native (sox/arecord) capture paths.
   */
  _resetVadState() {
    this.vadSpeaking = false;        // currently inside an utterance
    this.vadSpeechMs = 0;            // accumulated voiced audio in this segment
    this.vadSilenceMs = 0;           // trailing silence since last voiced chunk
    this.vadNoiseFloor = 0;          // adaptive EMA of background energy
    this.vadNoiseInit = false;       // has the noise floor been seeded
    this.vadPreRoll = [];            // ring of recent pre-speech chunks
    this.vadPreRollMs = 0;           // duration held in the pre-roll ring
    this.vadLastChunkAt = 0;         // timestamp of the last ingested chunk
  }

  /**
   * Lightweight watchdog. Silence is normally detected from incoming chunks
   * (which keep flowing at low energy), but if the capture pipeline stalls
   * mid-utterance we still want to flush what we have. The watchdog also
   * enforces the max-utterance cap as a backstop.
   */
  _startSegmentWatchdog() {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
    }
    this.segmentTimer = setInterval(() => {
      if (!this.isRecording || this.provider !== 'whisper') {
        return;
      }

      // VAD disabled (fallback): preserve the legacy fixed-window behaviour by
      // flushing once the accumulated audio reaches the configured segment size.
      if (!this._isVadEnabled()) {
        if (this.segmentBytes && this.vadSpeechMs >= this._getWhisperSegmentMs()) {
          this._endUtteranceFlush();
        }
        return;
      }

      // If we're mid-utterance and no audio has arrived recently, the mic may
      // have stalled — flush what we captured rather than holding it forever.
      const sinceLastChunk = this.vadLastChunkAt ? Date.now() - this.vadLastChunkAt : 0;
      const stalled = this.vadSpeaking && sinceLastChunk > 1500;
      const tooLong = this.vadSpeaking && this.vadSpeechMs >= this._getMaxUtteranceMs();
      if (stalled || tooLong) {
        this._endUtteranceFlush();
      }
    }, 500);
  }

  /**
   * Receive raw 16kHz mono 16-bit PCM audio from the renderer and add it to
   * the current Whisper segment buffer.
   */
  handleAudioChunkFromRenderer(chunk) {
    if (!this.isRecording || !this.useRendererCapture || !chunk?.length) return;
    this._handleAudioChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  /**
   * Compute the RMS energy (normalized to 0..1) of a 16-bit little-endian PCM
   * buffer. Used as the voice-activity signal.
   */
  _chunkRmsEnergy(buffer) {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) {
      return 0;
    }
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }

  /**
   * Single ingest path for both capture backends. Runs the VAD state machine:
   * accumulate audio while the user speaks, and flush the segment to Whisper
   * once a natural pause (trailing silence) is detected. Falls back to plain
   * buffering when VAD is disabled.
   */
  _ingestWhisperAudio(buffer) {
    if (!buffer || !buffer.length) {
      return;
    }

    if (this._isManualCaptureMode()) {
      this.segmentBuffers.push(buffer);
      this.segmentBytes += buffer.length;
      this.vadLastChunkAt = Date.now();

      const capturedMs = this.segmentBytes / 32;
      if (!this.manualStopRequested && capturedMs >= this._getManualCaptureMaxMs()) {
        this.manualStopRequested = true;
        this.emit('status', 'Maximum recording duration reached; processing audio');
        const generation = this._generation;
        setImmediate(() => { if (this._generation === generation) this.stopRecording(); });
      }
      return;
    }

    if (!this._isVadEnabled()) {
      // Legacy behaviour: the watchdog/max-utterance cap drives flushing.
      this.segmentBuffers.push(buffer);
      this.segmentBytes += buffer.length;
      this.vadSpeaking = true;
      this.vadSpeechMs += this._chunkDurationMs(buffer);
      this.vadLastChunkAt = Date.now();
      return;
    }

    this.vadLastChunkAt = Date.now();
    const chunkMs = this._chunkDurationMs(buffer);
    const energy = this._chunkRmsEnergy(buffer);

    const floor = this._getVadEnergyFloor();
    // Seed / adapt the background noise floor while not actively speaking so
    // the threshold tracks the room rather than a hard-coded constant. Seed
    // conservatively: if the very first chunk is already loud (the user started
    // talking immediately), clamp to the configured floor so a high seed can't
    // push the enter-threshold out of reach and stall VAD for the whole session.
    if (!this.vadNoiseInit) {
      this.vadNoiseFloor = Math.min(energy, floor);
      this.vadNoiseInit = true;
    }
    // Hysteresis: it takes more energy to *start* an utterance than to keep
    // one going, so a brief dip mid-sentence doesn't end it prematurely.
    const enterThreshold = Math.max(floor, this.vadNoiseFloor * 2.5);
    const exitThreshold = Math.max(floor * 0.7, this.vadNoiseFloor * 1.6);
    const isVoiced = this.vadSpeaking ? energy >= exitThreshold : energy >= enterThreshold;

    if (!this.vadSpeaking) {
      if (isVoiced) {
        // Speech onset: prepend the pre-roll so the first syllable survives.
        this.vadSpeaking = true;
        this.vadSpeechMs = 0;
        this.vadSilenceMs = 0;
        for (const pre of this.vadPreRoll) {
          this.segmentBuffers.push(pre);
          this.segmentBytes += pre.length;
        }
        this.vadPreRoll = [];
        this.vadPreRollMs = 0;
        this.segmentBuffers.push(buffer);
        this.segmentBytes += buffer.length;
        this.vadSpeechMs += chunkMs;
      } else {
        // Background: adapt the noise floor and keep a short pre-roll ring.
        this.vadNoiseFloor = this.vadNoiseFloor * 0.95 + energy * 0.05;
        this.vadPreRoll.push(buffer);
        this.vadPreRollMs += chunkMs;
        const preRollLimit = this._getPreRollMs();
        while (this.vadPreRollMs > preRollLimit && this.vadPreRoll.length > 1) {
          const dropped = this.vadPreRoll.shift();
          this.vadPreRollMs -= this._chunkDurationMs(dropped);
        }
      }
      return;
    }

    // Already speaking: keep capturing (including trailing silence so word
    // endings aren't clipped) and watch for a pause that ends the utterance.
    this.segmentBuffers.push(buffer);
    this.segmentBytes += buffer.length;
    if (isVoiced) {
      this.vadSpeechMs += chunkMs;
      this.vadSilenceMs = 0;
    } else {
      this.vadSilenceMs += chunkMs;
    }

    const pausedLongEnough = this.vadSilenceMs >= this._getSilenceHangoverMs();
    const haveRealSpeech = this.vadSpeechMs >= this._getMinUtteranceMs();
    const tooLong = this.vadSpeechMs >= this._getMaxUtteranceMs();

    if ((pausedLongEnough && haveRealSpeech) || tooLong) {
      this._endUtteranceFlush();
    } else if (pausedLongEnough && !haveRealSpeech) {
      // Just noise (cough/click) with no real speech — discard, don't waste a
      // Whisper spawn or risk a hallucinated transcript.
      this.segmentBuffers = [];
      this.segmentBytes = 0;
      this.vadSpeaking = false;
      this.vadSpeechMs = 0;
      this.vadSilenceMs = 0;
    }
  }

  /** Flush the accumulated utterance and reset VAD for the next one. */
  _endUtteranceFlush() {
    this.vadSpeaking = false;
    this.vadSpeechMs = 0;
    this.vadSilenceMs = 0;
    this.vadPreRoll = [];
    this.vadPreRollMs = 0;
    this._flushWhisperSegment({ final: false }).catch((error) => {
      logger.error('Whisper segment transcription failed', { error: error.message });
    });
  }

  _chunkDurationMs(buffer) {
    // 16kHz mono 16-bit => 2 bytes/sample => 32 bytes/ms.
    return buffer.length / 32;
  }

  stopRecording() {
    if (this._preparingRecordingPromise && !this.isRecording) {
      this.cancelRecording();
      return Promise.resolve();
    }
    if (this._stopPromise) return this._stopPromise;
    if (!this.isRecording) return Promise.resolve();
    if (!this._captureReady) {
      this.cancelRecording();
      return Promise.resolve();
    }
    const generation = this._generation;
    this._stopping = true;
    this.isProcessingAudio = true;
    clearInterval(this.segmentTimer);
    this.segmentTimer = null;
    // Keep accepting owned PCM until the renderer's stopped ACK: its final
    // worklet tail precedes that ACK on the same ordered IPC channel.
    this._stopPromise = Promise.resolve().then(() => this._drainRecording(generation));
    return this._stopPromise;
  }

  async _drainRecording(generation) {
    // A queued stop may belong to a capture cancelled before this microtask ran.
    // Check ownership before touching the shared adapter or native recorder.
    if (this._generation !== generation) return;
    let incompleteCapture = false;
    try {
      if (this.useRendererCapture) {
        const receipt = await this.rendererCapture.stop();
        incompleteCapture = receipt?.incomplete === true;
        if (incompleteCapture && this._generation === generation) this.emit('status', 'Microphone stopped before the final audio arrived. Processing the audio already received.');
      }
      else if (this.recording) {
        const recording = this.recording;
        this.recording = null;
        recording.stop();
      }
      if (this._generation !== generation) return;
      this.isRecording = false;
      this.emit('recording-stopped');
      if (this.provider === 'whisper') {
        this.emit('status', 'Processing local speech…');
        await this._flushWhisperSegment({ final: true });
      } else if (this.recognizer) {
        // EOF follows the final PCM. Keep recognized callbacks valid until
        // the SDK's stop callback (or bounded failure), then close this session.
        this.pushStream?.close();
        const recognizer = this.recognizer;
        await new Promise(resolve => {
          const finish = () => {
            clearTimeout(timer);
            if (this._finishAzureStop === finish) this._finishAzureStop = null;
            resolve();
          };
          const timer = setTimeout(finish, 3000);
          this._finishAzureStop = finish;
          try { recognizer.stopContinuousRecognitionAsync(finish, finish); }
          catch (_) { finish(); }
        });
      }
    } catch (_) {
      if (this._generation === generation) this.emit('error', 'Speech processing failed. Check the selected speech provider and retry.');
    } finally {
      // An old stop must never close a newer microphone or reset its buffers.
      if (this._generation === generation) {
        this._generation = (this._generation || 0) + 1;
        this._cleanup();
        this.isRecording = false;
        this.isProcessingAudio = false;
        this._stopping = false;
        this._stopPromise = null;
        this.whisperWorker?.releaseWhenIdle();
        this.emit('status', incompleteCapture ? 'Recording stopped. The final audio could not be recovered; only received audio was processed.' : 'Recording stopped');
      }
    }
  }

  cancelRecording() {
    const wasActive = this.isRecording || this.isProcessingAudio || Boolean(this._preparingRecordingPromise);
    this._preparingRecordingPromise = null;
    this._preparedModelPath = null;
    this._generation = (this._generation || 0) + 1;
    this.isRecording = false;
    this.isProcessingAudio = false;
    this._stopping = false;
    this._stopPromise = null;
    this._startPromise = null;
    this._captureReady = false;
    this.rendererCapture?.cancel();
    this._cleanup();
    this.whisperWorker?.close();
    for (const child of this._whisperChildren || []) {
      this._whisperCancellations?.get(child)?.();
    }
    if (wasActive) {
      this.emit('recording-stopped');
      this.emit('recording-cancelled');
      this.emit('status', 'Recording cancelled');
    }
  }

  _cleanup() {
    this._abortAzureStart?.();
    this._finishAzureStop?.();
    this._flushPromise = null;
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.recognizer) {
      try {
        this.recognizer.recognizing = undefined;
        this.recognizer.recognized = undefined;
        this.recognizer.canceled = undefined;
        this.recognizer.sessionStopped = undefined;
        this.recognizer.close();
      } catch (error) {
        logger.error('Error closing recognizer', { error: error.message });
      }
      this.recognizer = null;
    }

    if (this.audioConfig) {
      try {
        // Push-stream lifetime is owned by pushStream.close(). The SDK's
        // AudioConfig.close() assumes a Promise-returning source, which its
        // push source does not supply. File/native sources retain close().
        if (!this.pushStream && typeof this.audioConfig.close === 'function') {
          this.audioConfig.close();
        }
      } catch (error) {
        logger.error('Error closing audio config', { error: error.message });
      }
      this.audioConfig = null;
    }

    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping audio recording', { error: error.message });
      }
      this.recording = null;
    }

    if (this.pushStream) {
      try {
        if (typeof this.pushStream.close === 'function') {
          this.pushStream.close();
        }
      } catch (error) {
        logger.error('Error closing push stream', { error: error.message });
      }
      this.pushStream = null;
    }

    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this._resetVadState();
    this._audioDataLogged = false;
    this.useRendererCapture = false;
  }

  async recognizeFromFile(audioFilePath) {
    if (this.provider === 'azure') {
      if (!this.speechConfig) {
        throw new Error('Speech service not initialized');
      }

      if (!fs.existsSync(audioFilePath)) {
        throw new Error(`Audio file not found: ${audioFilePath}`);
      }

      const audioConfig = sdk.AudioConfig.fromWavFileInput(audioFilePath);
      const recognizer = new sdk.SpeechRecognizer(this.speechConfig, audioConfig);

      return await new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(
          (result) => {
            resolve(result.reason === sdk.ResultReason.RecognizedSpeech ? result.text : '');
            recognizer.close();
            audioConfig.close();
          },
          (error) => {
            reject(new Error(`File recognition error: ${error}`));
            recognizer.close();
            audioConfig.close();
          }
        );
      });
    }

    if (this.provider === 'whisper') {
      return this._transcribeWhisperFile(audioFilePath);
    }

    throw new Error('Speech service not initialized');
  }

  async testConnection() {
    if (this.provider === 'azure') {
      if (!this.speechConfig) {
        throw new Error('Speech service not initialized');
      }

      try {
        const stream = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
        const audioConfig = sdk.AudioConfig.fromStreamInput(stream);
        const recognizer = new sdk.SpeechRecognizer(this.speechConfig, audioConfig);
        recognizer.close();
        stream.close();
        return { success: true, message: 'Azure SDK configuration is ready. Start recording to test microphone access and the live service.' };
      } catch (error) {
        return { success: false, message: error.message };
      }
    }

    if (this.provider === 'whisper') {
      if (!this.whisperCommand) {
        return { success: false, message: 'Local Whisper CLI not found' };
      }
      // Actually probe the executable to confirm it works
      const probe = spawnSync(
        this.whisperCommand.command,
        [...this.whisperCommand.baseArgs, '--help'],
        { encoding: 'utf8', timeout: 10000 }
      );
      if (probe.error || probe.status !== 0) {
        const err = probe.error ? probe.error.message : `exit code ${probe.status}`;
        return {
          success: false,
          message: `Local Whisper CLI detected but probe failed: ${err}`
        };
      }
      return {
        success: true,
        message: `Local Whisper CLI works: ${this.whisperCommand.command}`
      };
    }

    return { success: false, message: 'Speech service not initialized' };
  }

  getStatus() {
    return {
      provider: this.provider,
      isRecording: this.isRecording,
      isStarting: Boolean(this._preparingRecordingPromise) || Boolean(this.isRecording && !this._captureReady),
      isProcessingAudio: this.isProcessingAudio,
      isInitialized: this.provider === 'azure' ? !!this.speechConfig : !!this.whisperCommand,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      retryCount: this.retryCount,
      effectiveSettings: {
        speechProvider: this.provider,
        azureKey: this._getSetting('azureKey') || '',
        azureRegion: this._getSetting('azureRegion') || process.env.AZURE_SPEECH_REGION || '',
        whisperCommand: this._getSetting('whisperCommand') || process.env.WHISPER_COMMAND || '',
        whisperModelDir: this._getWhisperModelDir(),
        whisperModel: this._getWhisperModel(),
        whisperLanguage: this._getWhisperLanguage(),
        whisperCaptureMode: this._getWhisperCaptureMode(),
        whisperDevice: this._getWhisperDevice(),
        whisperSegmentMs: String(this._getWhisperSegmentMs())
      },
      config: {
        azure: config.get('speech.azure') || {},
        whisper: config.get('speech.whisper') || {},
        selectedProvider: this.provider
      }
    };
  }

  isAvailable() {
    if (this.provider === 'azure') {
      return !!this.speechConfig && !!this.available;
    }

    if (this.provider === 'whisper') {
      return !!this.whisperCommand && !!this.available;
    }

    return false;
  }

  isManualCaptureMode() {
    return this.provider === 'whisper' && this._getWhisperCaptureMode() === 'manual';
  }

  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    // Subscribe before cancellation can close a child. A sent kill signal does
    // not establish that its process or inherited stdio have exited.
    const children = new Set(this._whisperChildren || []);
    if (this.whisperWorker?.process) children.add(this.whisperWorker.process);
    const closed = [...children].map(child => new Promise(resolve => child.once('close', resolve)));
    this._shutdownPromise = Promise.all(closed);
    this.cancelRecording();
    return this._shutdownPromise;
  }

  updateSettings(settings = {}) {
    const speechKeys = ['speechProvider', 'azureKey', 'azureRegion', 'whisperCommand', 'whisperModelDir', 'whisperModel', 'whisperLanguage', 'whisperCaptureMode', 'whisperDevice', 'whisperSegmentMs', 'whisperVadEnabled', 'whisperSilenceHangoverMs', 'whisperMinUtteranceMs', 'whisperMaxUtteranceMs', 'whisperPreRollMs', 'whisperVadEnergyFloor'];
    let changed = false;

    for (const key of speechKeys) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        this.runtimeSettings[key] = settings[key];
        changed = true;
      }
    }

    if (changed) {
      this.initializeClient();
    }

    return this.getStatus();
  }

  _getConfiguredProvider() {
    const provider = String(this._getSetting('speechProvider') || process.env.SPEECH_PROVIDER || '').trim().toLowerCase();

    if (provider === 'azure' || provider === 'whisper') {
      return provider;
    }

    const hasAzure = !!((this._getSetting('azureKey') || process.env.AZURE_SPEECH_KEY) &&
      (this._getSetting('azureRegion') || process.env.AZURE_SPEECH_REGION));

    if (hasAzure) {
      return 'azure';
    }

    return 'whisper';
  }

  _getWhisperModel() {
    return this._getSetting('whisperModel') || process.env.WHISPER_MODEL || config.get('speech.whisper.model') || 'small';
  }

  _getWhisperModelDir() {
    const configured = this._getSetting('whisperModelDir') || process.env.WHISPER_MODEL_DIR || '';
    // Honor an absolute configured dir. Empty or relative values (the old
    // `.whisper-models` default resolved against an unstable cwd) are replaced
    // with the stable userData location the installer downloads weights into,
    // so --model_dir and download_root always agree.
    if (configured && path.isAbsolute(configured)) {
      return configured;
    }
    return this._getUserDataModelDir() || configured;
  }

  /**
   * Absolute model-weights dir under Electron userData — matches
   * WhisperInstaller.modelDir so transcription finds downloaded models.
   */
  _getUserDataModelDir() {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('userData'), '.whisper-models');
    } catch (_) {
      return '';
    }
  }

  _getWhisperLanguage() {
    return this._getSetting('whisperLanguage') || process.env.WHISPER_LANGUAGE || config.get('speech.whisper.language') || 'auto';
  }

  _getWhisperSegmentMs() {
    const rawValue = this._getSetting('whisperSegmentMs') || process.env.WHISPER_SEGMENT_MS || config.get('speech.whisper.segmentMs') || 4000;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? Math.max(2000, parsed) : 4000;
  }

  _vadNumber(settingKey, envKey, configPath, fallback, min) {
    const raw = this._getSetting(settingKey) || process.env[envKey] || config.get(configPath) || fallback;
    const parsed = Number(raw);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return typeof min === 'number' ? Math.max(min, value) : value;
  }

  _isVadEnabled() {
    const override = this._getSetting('whisperVadEnabled');
    if (override === false || override === 'false') return false;
    if (override === true || override === 'true') return true;
    if (process.env.WHISPER_VAD_ENABLED === 'false') return false;
    const configured = config.get('speech.whisper.vadEnabled');
    return configured !== false;
  }

  _getSilenceHangoverMs() {
    return this._vadNumber('whisperSilenceHangoverMs', 'WHISPER_SILENCE_HANGOVER_MS', 'speech.whisper.silenceHangoverMs', 700, 200);
  }

  _getMinUtteranceMs() {
    return this._vadNumber('whisperMinUtteranceMs', 'WHISPER_MIN_UTTERANCE_MS', 'speech.whisper.minUtteranceMs', 350, 100);
  }

  _getMaxUtteranceMs() {
    return this._vadNumber('whisperMaxUtteranceMs', 'WHISPER_MAX_UTTERANCE_MS', 'speech.whisper.maxUtteranceMs', 15000, 2000);
  }

  _getPreRollMs() {
    return this._vadNumber('whisperPreRollMs', 'WHISPER_PRE_ROLL_MS', 'speech.whisper.preRollMs', 300, 0);
  }

  _getVadEnergyFloor() {
    return this._vadNumber('whisperVadEnergyFloor', 'WHISPER_VAD_ENERGY_FLOOR', 'speech.whisper.vadEnergyFloor', 0.008, 0.0005);
  }

  _getSetting(key) {
    const value = this.runtimeSettings[key];
    return value === '' ? null : value;
  }

  _isManualCaptureMode() {
    return this._getWhisperCaptureMode() === 'manual';
  }

  _getWhisperCaptureMode() {
    const configured = String(
      this._getSetting('whisperCaptureMode') || process.env.WHISPER_CAPTURE_MODE || ''
    ).trim().toLowerCase();
    if (configured === 'manual' || configured === 'vad') {
      return configured;
    }

    // Backward compatibility for existing local configurations.
    if (process.env.WHISPER_MANUAL_CAPTURE !== undefined) {
      return process.env.WHISPER_MANUAL_CAPTURE === 'false' ? 'vad' : 'manual';
    }
    return 'vad';
  }

  _getManualCaptureMaxMs() {
    const parsed = Number(process.env.WHISPER_MANUAL_MAX_MS || 90000);
    return Number.isFinite(parsed) ? Math.max(5000, parsed) : 90000;
  }

  _getWhisperDevice() {
    return String(process.env.WHISPER_DEVICE || 'auto').trim().toLowerCase();
  }

  _getWhisperPythonPath() {
    if (this.whisperCommand?.kind === 'bundled') return this.whisperCommand.pythonPath;
    const configuredPython = String(process.env.WHISPER_PYTHON || '').trim();
    if (configuredPython) {
      const resolvedPython = path.isAbsolute(configuredPython)
        ? path.normalize(configuredPython)
        : path.resolve(configuredPython);
      if (fs.existsSync(resolvedPython)) {
        return resolvedPython;
      }
    }

    // The resolved command already applies explicit-config/app-venv priority.
    // Derive its interpreter instead of silently switching runtimes here.
    if (!this.whisperCommand) {
      return null;
    }

    const command = path.normalize(this.whisperCommand.command);
    const moduleIndex = this.whisperCommand.baseArgs.indexOf('-m');
    if (
      moduleIndex !== -1 &&
      this.whisperCommand.baseArgs[moduleIndex + 1] === 'whisper' &&
      fs.existsSync(command)
    ) {
      return command;
    }

    const pythonName = process.platform === 'win32' ? 'python.exe' : 'python';
    const siblingPython = path.join(path.dirname(command), pythonName);
    return fs.existsSync(siblingPython) ? siblingPython : null;
  }

  _getWhisperWorkerScriptPath() {
    const sourcePath = path.resolve(__dirname, '..', '..', 'scripts', 'whisper_worker.py');
    return sourcePath.split(path.sep).map(part => part === 'app.asar' ? 'app.asar.unpacked' : part).join(path.sep);
  }

  _configureWhisperWorker() {
    const pythonPath = this._getWhisperPythonPath();
    const scriptPath = this._getWhisperWorkerScriptPath();
    const idleUnloadMs = Math.max(10000, Number(process.env.WHISPER_GPU_IDLE_MS || 60000));
    this.whisperWorker.configure({ pythonPath, scriptPath, idleUnloadMs, env: this.whisperCommand?.env || null });

    logger.info('Whisper worker configuration', {
      configured: this.whisperWorker.isConfigured(),
      pythonPath,
      scriptPath,
      device: this._getWhisperDevice(),
      idleUnloadMs
    });
  }

  /**
   * Build a whisper candidate pointing at the app-local venv inside
   * Electron's userData directory. This is where the onboarding installer
   * creates the venv in packaged builds.
   */
  _getUserDataWhisperCandidate() {
    try {
      const { app } = require('electron');
      const userData = app.getPath('userData');
      const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
      const ext = process.platform === 'win32' ? '.exe' : '';
      const python = path.join(userData, '.venv-whisper', binDir, `python${ext}`);
      if (fs.existsSync(python)) {
        return { command: python, baseArgs: ['-m', 'whisper'] };
      }
    } catch (_) {
      // electron may not be available in unit tests
    }
    return null;
  }

  _resolveWhisperCommand() {
    let isPackaged = false;
    try { isPackaged = Boolean(require('electron').app.isPackaged); } catch (_) { /* Node tooling */ }
    const bundled = resolveWhisperRuntime({
      isPackaged, resourcesPath: process.resourcesPath,
      configuredCommand: this._getSetting('whisperCommand')
    });
    if (bundled) return bundled;
    const configured = this._getSetting('whisperCommand') || process.env.WHISPER_COMMAND;
    const candidates = [];

    if (configured) {
      candidates.push(...this._expandConfiguredWhisperCandidates(configured));
    }

    // Persistent app venv (highest priority after explicit config)
    const userDataVenv = this._getUserDataWhisperCandidate();
    if (userDataVenv) {
      candidates.push({ ...userDataVenv, source: 'app userData venv' });
    }

    // Platform-aware fallback candidates (higher priority = tried first)
    candidates.push({ command: 'whisper', baseArgs: [], source: 'system PATH' });
    if (process.platform === 'win32') {
      candidates.push({ command: 'whisper.exe', baseArgs: [], source: 'system PATH (exe)' });
      candidates.push({ command: 'py', baseArgs: ['-3', '-m', 'whisper'], source: 'py launcher' });
    }
    candidates.push({ command: 'python3', baseArgs: ['-m', 'whisper'], source: 'python3 module' });
    candidates.push({ command: 'python', baseArgs: ['-m', 'whisper'], source: 'python module' });

    for (const candidate of candidates) {
      if (!candidate || !candidate.command) {
        continue;
      }

      const resolved = this._probeWhisperCandidate(candidate);
      if (resolved) {
        logger.info('Whisper command resolved', {
          command: resolved.command,
          baseArgs: resolved.baseArgs,
          source: resolved.source || candidate.source || 'unknown'
        });
        return resolved;
      }
    }

    logger.warn('No Whisper CLI candidate succeeded after probing all fallbacks');
    return null;
  }

  /**
   * Fast, torch-free check for python `-m whisper` candidates. Importing the
   * whisper package pulls in torch/numba and can take well over 8 s on a cold
   * cache (first run after install), which made `--help` time out and the mic
   * button stay hidden until a second launch. `importlib.util.find_spec`
   * confirms the module is installed without importing it, returning in well
   * under a second. Returns the candidate on success, else null.
   */
  _probeWhisperModuleFast(candidate) {
    const mIdx = candidate.baseArgs.indexOf('-m');
    if (mIdx === -1 || candidate.baseArgs[mIdx + 1] !== 'whisper') {
      return null; // not a `-m whisper` form (e.g. a whisper binary)
    }
    const pyArgs = candidate.baseArgs.slice(0, mIdx);
    const script = 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("whisper") else 1)';
    try {
      // No shell: an absolute .exe runs directly. shell:true on Windows does
      // NOT quote args, so a spaced path like
      //   C:\Users\CANDAN SINGH\...\python.exe
      // would be split at the space and the probe would wrongly fail —
      // hiding the mic for any user whose profile name contains a space.
      const probe = spawnSync(candidate.command, [...pyArgs, '-c', script], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) {
        return candidate;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  /**
   * Probe a single candidate: exists check → fast module check → spawn --help.
   * Returns the working candidate object, or null on failure.
   */
  _probeWhisperCandidate(candidate) {
    const cmd = candidate.command;
    const args = [...candidate.baseArgs, '--help'];

    // Fast path: skip spawnSync if the file clearly doesn't exist
    if (path.isAbsolute(cmd) || cmd.includes(path.sep) || cmd.includes('/')) {
      try {
        const normalized = path.normalize(cmd);
        if (!fs.existsSync(normalized)) {
          logger.debug('Whisper probe skipped: file does not exist', {
            command: cmd,
            normalized
          });
          return null;
        }
      } catch (e) {
        // fs.existsSync can throw on invalid paths; treat as missing
        return null;
      }
    }

    // Cheap torch-free check first so the mic appears on the first run.
    const fast = this._probeWhisperModuleFast(candidate);
    if (fast) {
      logger.debug('Whisper module confirmed via find_spec', { command: cmd });
      return fast;
    }

    let probe;
    try {
      probe = spawnSync(cmd, args, {
        encoding: 'utf8',
        // First `import whisper` (torch/numba) can be slow on a cold cache.
        timeout: 30000,
        windowsHide: true,
        // No shell — see _probeWhisperModuleFast: shell:true on Windows splits
        // spaced paths (e.g. "C:\Users\CANDAN SINGH\...") and breaks the probe.
      });
    } catch (spawnErr) {
      logger.debug('Whisper probe spawn error', {
        command: cmd,
        error: spawnErr.message
      });
      return null;
    }

    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
    const noModule = output.includes('No module named whisper');
    const isHelpOutput = output.includes('usage:') || output.includes('whisper') || output.includes('options');

    if (!probe.error && probe.status === 0 && !noModule) {
      return candidate;
    }

    // Some whisper builds exit with non-zero on --help but still print usage
    if (!probe.error && !noModule && isHelpOutput) {
      logger.debug('Whisper probe accepted non-zero help output', {
        command: cmd,
        status: probe.status
      });
      return candidate;
    }

    logger.debug('Whisper probe failed', {
      command: cmd,
      status: probe.status,
      error: probe.error ? probe.error.message : null,
      noModule,
      isHelpOutput,
      outputPreview: output.substring(0, 200)
    });
    return null;
  }

  _expandConfiguredWhisperCandidates(rawCommand) {
    const parsed = this._parseCommand(rawCommand);
    if (!parsed) {
      return [];
    }

    const candidates = [];
    // Normalize forward slashes to platform separator before trying anything
    const normalizedCmd = path.normalize(parsed.command);

    candidates.push({
      command: normalizedCmd,
      baseArgs: parsed.baseArgs,
      source: 'configured (normalized)'
    });

    const resolvedPath = path.resolve(normalizedCmd);
    if (resolvedPath !== normalizedCmd) {
      candidates.push({
        command: resolvedPath,
        baseArgs: parsed.baseArgs,
        source: 'configured (resolved)'
      });
    }

    if (process.platform === 'win32') {
      const base = normalizedCmd;
      // Try .exe / .cmd / .bat variants when extension is missing
      if (!/\.(exe|cmd|bat)$/i.test(base)) {
        candidates.push({ command: `${base}.exe`, baseArgs: parsed.baseArgs, source: 'configured (.exe)' });
        candidates.push({ command: `${base}.cmd`, baseArgs: parsed.baseArgs, source: 'configured (.cmd)' });
        if (resolvedPath !== base) {
          candidates.push({ command: `${resolvedPath}.exe`, baseArgs: parsed.baseArgs, source: 'configured (resolved .exe)' });
        }
      }
      // Some Windows venvs create whisper-script.py alongside whisper.exe
      const scriptPath = base + '-script.py';
      candidates.push({ command: 'python', baseArgs: [scriptPath, ...parsed.baseArgs], source: 'configured (script.py)' });
      // Try using the venv's own python with -m whisper
      const venvPython = path.join(path.dirname(base), 'python.exe');
      if (fs.existsSync(venvPython)) {
        candidates.push({ command: venvPython, baseArgs: ['-m', 'whisper', ...parsed.baseArgs], source: 'configured (venv python -m whisper)' });
      }
    } else {
      // On Unix, try the directory's python3 with -m whisper if the configured path looks like a venv entry point
      const venvPython3 = path.join(path.dirname(normalizedCmd), 'python3');
      if (fs.existsSync(venvPython3)) {
        candidates.push({ command: venvPython3, baseArgs: ['-m', 'whisper', ...parsed.baseArgs], source: 'configured (venv python3 -m whisper)' });
      }
      const venvPython = path.join(path.dirname(normalizedCmd), 'python');
      if (fs.existsSync(venvPython)) {
        candidates.push({ command: venvPython, baseArgs: ['-m', 'whisper', ...parsed.baseArgs], source: 'configured (venv python -m whisper)' });
      }
    }

    return candidates;
  }

  _parseCommand(rawCommand) {
    // Respect double-quoted segments so Windows userData paths like
    // "C:\Users\CANDAN SINGH\...\python.exe" survive intact.
    const trimmed = String(rawCommand || '').trim();
    if (!trimmed) {
      return null;
    }
    const parts = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) || [trimmed];
    const normalized = parts.map((p) => p.replace(/^"|"$/g, '')).filter(Boolean);
    if (normalized.length === 0) {
      return null;
    }

    return {
      command: normalized[0],
      baseArgs: normalized.slice(1)
    };
  }

  _startMicrophoneCapture() {
    if (!recorder || typeof recorder.record !== 'function') {
      this.cancelRecording();
      this.emit('error', 'Local microphone capture dependency is missing. Run npm install to restore speech recording support.');
      return;
    }

    // node-record-lpcm16 only ships two recorder modules: `sox` and `arecord`.
    // `recorder` is the option it actually reads (the old `recordProgram` name
    // was silently ignored, so every attempt fell back to sox). Each entry maps
    // the recorder module to the binary we must verify is on PATH.
    // Linux remains on ALSA/sox; Windows and macOS use the owned renderer.
    const candidates = [{ recorder: 'arecord', bin: 'arecord' }, { recorder: 'sox', bin: 'sox' }];
    this._startMicrophoneCaptureWithFallback(candidates);
  }

  /**
   * Whether an audio capture binary is on PATH. node-record-lpcm16 spawns
   * these directly and, when the binary is missing, emits an `error` on its
   * child process with no listener — which would otherwise crash the whole
   * app. We pre-filter to binaries that exist so the library never receives a
   * missing program.
   */
  _audioProgramExists(bin) {
    try {
      const r = spawnSync(
        process.platform === 'win32' ? 'where' : 'which',
        [bin],
        { windowsHide: true, timeout: 4000 }
      );
      return r.status === 0;
    } catch (_) {
      return false;
    }
  }

  _startMicrophoneCaptureWithFallback(candidates) {
    const generation = this._generation;
    const available = candidates.filter((c) => this._audioProgramExists(c.bin));

    if (available.length === 0) {
      const hint = 'Install one with `sudo apt install alsa-utils` (arecord) or `sudo apt install sox`.';
      logger.warn('No audio capture program available', {
        tried: candidates.map((c) => c.bin),
        platform: process.platform,
      });
      this.cancelRecording();
      this.emit('error', `Microphone capture needs sox or arecord, but none was found. ${hint}`);
      return;
    }

    const queue = [...available];

    const tryNextProgram = () => {
      if (this._generation !== generation || !this.isRecording || this._stopping) return;
      const candidate = queue.shift();
      if (!candidate) {
        this.cancelRecording();
        this.emit('error', 'Could not start microphone capture with any available audio program');
        return;
      }

      const program = candidate.bin;
      try {
        this.recording = recorder.record({
          sampleRate: 16000,
          sampleRateHertz: 16000,
          channels: 1,
          threshold: 0,
          verbose: false,
          recorder: candidate.recorder,
          silence: '10.0s'
        });

        const ownedRecording = this.recording;
        const stream = ownedRecording.stream();
        this.audioProgram = program;

        // Guard the spawned child process directly. A spawn failure (e.g. the
        // binary disappeared between our probe and the spawn, or a permission
        // error) emits `error` on the child, which node-record-lpcm16 leaves
        // unhandled — fatal without this listener.
        const child = this.recording.process;
        if (child && typeof child.on === 'function') {
          child.on('error', (error) => {
            if (this._generation !== generation || this.recording !== ownedRecording) return;
            logger.error('Audio recording process error', { error: error.message, program });
            if (this.recording) {
              try { this.recording.stop(); } catch (_) { /* ignore */ }
              this.recording = null;
            }
            if (this.isRecording) tryNextProgram();
          });
        }

        stream.on('error', (error) => {
          if (this._generation !== generation || this.recording !== ownedRecording) return;
          logger.error('Audio recording stream error', { error: error.message, program });
          if (this.recording) {
            try {
              this.recording.stop();
            } catch (stopError) {
              logger.error('Error stopping failed recording program', { error: stopError.message });
            }
            this.recording = null;
          }

          if (this.isRecording) {
            tryNextProgram();
          }
        });

        stream.on('data', (chunk) => {
          if (this._generation === generation && this.recording === ownedRecording) this._handleAudioChunk(chunk);
        });
      } catch (error) {
        logger.error('Failed to start microphone capture program', { program, error: error.message });
        tryNextProgram();
      }
    };

    tryNextProgram();
  }

  _handleAudioChunk(chunk) {
    if (!chunk || !chunk.length || !this.isRecording) {
      return;
    }

    if (this.provider === 'azure' && this.pushStream) {
      try {
        this.pushStream.write(chunk);
      } catch (error) {
        this.cancelRecording();
        this.emit('error', 'Azure audio capture failed. Check the selected provider and retry.');
      }
      return;
    }

    if (this.provider === 'whisper') {
      this._ingestWhisperAudio(Buffer.from(chunk));
    }
  }

  _flushWhisperSegment({ final }) {
    if (this._flushPromise) {
      this.pendingFlush = true;
      this.pendingFinal = this.pendingFinal || final;
      return this._flushPromise;
    }
    if (!this.segmentBytes) return Promise.resolve();
    const generation = this._generation;
    this.transcriptionInFlight = true;
    const drain = async () => {
      let failure;
      do {
        this.pendingFlush = false;
        this.pendingFinal = false;
        const audioBuffer = Buffer.concat(this.segmentBuffers, this.segmentBytes);
        this.segmentBuffers = [];
        this.segmentBytes = 0;
        try {
          const transcript = await this._transcribeWhisperBuffer(audioBuffer);
          if (this._generation !== generation) return;
          const clean = transcript ? transcript.trim() : '';
          if (clean && !this._isHallucinatedTranscript(clean)) this.emit('transcription', clean);
        } catch (error) {
          if (this._generation !== generation) return;
          failure = error;
        }
      } while (this._generation === generation && this.pendingFlush && this.segmentBytes);
      if (failure) throw failure;
    };
    const promise = drain().finally(() => {
      if (this._generation !== generation) return;
      this.transcriptionInFlight = false;
      this.pendingFlush = false;
      this.pendingFinal = false;
      this._flushPromise = null;
    });
    this._flushPromise = promise;
    return promise;
  }

  /**
   * Whisper reliably hallucinates a small set of stock phrases when fed near-
   * silence or non-speech audio (training-data artifacts from video captions).
   * VAD already prevents most silent flushes; this is the final guard so these
   * phantom phrases never reach the chat or the LLM.
   */
  _isHallucinatedTranscript(text) {
    const normalized = text.toLowerCase().replace(/[\s.,!?¡¿"'`]+/g, ' ').trim();
    if (!normalized) {
      return true;
    }
    const HALLUCINATIONS = new Set([
      'thank you',
      'thank you for watching',
      'thanks for watching',
      'thank you so much for watching',
      'please subscribe',
      'like and subscribe',
      'you',
      'bye',
      'bye bye',
      'okay',
      'ok',
      'so',
      'the end',
      'subtitles by the amara org community'
    ]);
    return HALLUCINATIONS.has(normalized);
  }

  async _transcribeWhisperBuffer(audioBuffer) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-whisper-'));
    const audioFilePath = path.join(tempDir, 'segment.wav');
    // The operation holds one lease across worker-to-CLI fallback. Each
    // reader holds another until its response or confirmed process close.
    let owners = 0;
    const retainInput = () => {
      owners++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--owners === 0) this._removeTempDir(tempDir);
      };
    };
    const releaseInput = retainInput();

    try {
      fs.writeFileSync(audioFilePath, this._createWavBuffer(audioBuffer));
      return await this._transcribeWhisperFile(audioFilePath, retainInput);
    } finally {
      releaseInput();
    }
  }

  _assertWhisperProcessAvailable() {
    if (this.whisperWorker.isTerminationPending?.()) {
      throw new Error('Whisper worker termination is unconfirmed; retry after the process exits');
    }
    if (this._whisperChildren?.size) {
      throw new Error('Whisper CLI is still running or awaiting confirmed termination; retry after the process exits');
    }
  }

  async _transcribeWhisperFile(audioFilePath, retainInput) {
    const generation = this._generation;
    if (!this.whisperCommand) {
      throw new Error('Local Whisper CLI not configured');
    }
    let model = this._getWhisperModel();
    if (this.whisperCommand.kind === 'bundled') {
      if (!this.modelPreparation) throw new Error('Prepare the selected voice model in Settings before recording.');
      model = await this.modelPreparation.requireReady(model);
      if (this._generation !== generation) throw new Error('Transcription cancelled');
    }
    this._assertWhisperProcessAvailable();

    if (this.whisperWorker.isConfigured()) {
      const startedAt = Date.now();
      try {
        const result = await this.whisperWorker.transcribe(audioFilePath, {
          model,
          language: this._getWhisperLanguage(),
          modelDir: this._getWhisperModelDir(),
          device: this._getWhisperDevice(),
          retainInput
        });
        if (this._generation !== generation) throw new Error('Transcription cancelled');
        logger.info('Persistent Whisper transcription completed', {
          processingTime: Date.now() - startedAt,
          model: result.model,
          device: result.device,
          gpu: result.gpu,
          detectedLanguage: result.language
        });
        return result.text || '';
      } catch (error) {
        if (this._generation !== generation) throw new Error('Transcription cancelled');
        if (this.whisperCommand.allowCliFallback === false) {
          if (!['WHISPER_WORKER_CLOSED', 'WHISPER_WORKER_TERMINATION_UNCONFIRMED'].includes(error.code)) {
            error.message = `The included speech engine could not transcribe: ${error.message}. Check the voice model in Settings, then restart the app. If the engine still cannot start, reinstall the app.`;
          }
          throw error;
        }
        if (error.code === 'WHISPER_WORKER_CLOSED' || error.code === 'WHISPER_WORKER_TERMINATION_UNCONFIRMED' || this.whisperWorker.isTerminationPending?.()) {
          throw error;
        }
        logger.warn('Persistent Whisper worker failed; falling back to CLI', {
          error: error.message,
          workerTraceback: error.workerTraceback
        });
      }
    }

    if (this.whisperCommand.allowCliFallback === false) {
      throw new Error('The included speech worker is unavailable. Restart the app and retry.');
    }
    this._assertWhisperProcessAvailable();
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-whisper-out-'));
    const args = [
      ...this.whisperCommand.baseArgs,
      audioFilePath,
      '--model', this._getWhisperModel(),
      '--task', 'transcribe',
      '--output_format', 'txt',
      '--output_dir', outputDir,
      '--verbose', 'False',
      '--fp16', 'False'
    ];

    const language = this._getWhisperLanguage();
    if (language && language !== 'auto' && language !== 'detect') {
      args.push('--language', language);
    }

    if (this._getWhisperModelDir()) {
      args.push('--model_dir', this._getWhisperModelDir());
    }

    const device = this._getWhisperDevice();
    if (device === 'cpu' || device === 'cuda') {
      args.push('--device', device);
    }

    let child = null;
    let closed = false;
    let finished = false;
    try {
      await new Promise((resolve, reject) => {
        child = spawn(this.whisperCommand.command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        this._whisperChildren ||= new Set();
        this._whisperChildren.add(child);
        const releaseInput = retainInput?.();
        let settled = false;
        let failure = null;
        let executionTimer = null;
        let terminationTimer = null;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(executionTimer);
          clearTimeout(terminationTimer);
          if (error) reject(error);
          else resolve();
        };
        const terminate = (error) => {
          if (failure || closed) return;
          failure = error;
          clearTimeout(executionTimer);
          terminationTimer = setTimeout(() => {
            settle(new Error(`${failure.message}; process termination is unconfirmed`));
          }, 5000);
          try { child.kill(); } catch (_) { /* Wait for close or the grace deadline. */ }
        };
        this._whisperCancellations ||= new Map();
        this._whisperCancellations.set(child, () => {
          const error = new Error('Transcription cancelled');
          terminate(error);
          settle(error);
        });
        executionTimer = setTimeout(() => {
          terminate(new Error('Whisper CLI timed out after 180000ms'));
        }, 180000);

        // Drain both pipes so child output cannot stall transcription.
        child.stdout.resume();
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk.toString()).slice(-16384);
        });

        child.on('error', (error) => {
          terminate(error);
        });

        child.once('close', (code) => {
          closed = true;
          this._whisperChildren.delete(child);
          this._whisperCancellations.delete(child);
          releaseInput?.();
          const error = failure || (this._generation !== generation
            ? new Error('Transcription cancelled')
            : code === 0 ? null : new Error(stderr.trim() || `Whisper exited with code ${code}`));
          settle(error);
          // If the grace deadline already rejected, close now owns cleanup.
          if (finished) this._removeTempDir(outputDir);
        });
      });

      const transcriptPath = path.join(outputDir, `${path.parse(audioFilePath).name}.txt`);
      if (!fs.existsSync(transcriptPath)) {
        return '';
      }

      return fs.readFileSync(transcriptPath, 'utf8').trim();
    } finally {
      finished = true;
      // Do not delete output while a timed-out child could still be writing.
      if (!child || closed) this._removeTempDir(outputDir);
    }
  }

  _createWavBuffer(rawPcmBuffer) {
    const header = Buffer.alloc(44);
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawPcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(rawPcmBuffer.length, 40);

    return Buffer.concat([header, rawPcmBuffer]);
  }

  _removeTempDir(tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      logger.error('Failed to remove Whisper temp directory', {
        tempDir,
        error: error.message
      });
    }
  }

  /**
   * Speak text using system TTS.
   * @param {string} text - Text to speak
   * @param {Object} options - TTS options
   * @param {string} options.voice - Voice name (optional)
   * @param {number} options.rate - Speech rate (optional)
   * @returns {Promise<void>}
   */
  async speak(text, options = {}) {
    const ttsEnabled = config.get('speech.ttsEnabled') || false;
    if (!ttsEnabled) {
      logger.debug('TTS disabled, skipping speak', { textLength: text.length });
      return;
    }

    const voice = options.voice || config.get('speech.ttsVoice') || '';
    const rate = options.rate || config.get('speech.ttsRate') || 200;

    return new Promise((resolve, reject) => {
      let command, args;

      if (process.platform === 'darwin') {
        command = 'say';
        args = [];
        if (voice) args.push('-v', voice);
        if (rate) args.push('-r', String(rate));
        args.push(text);
      } else if (process.platform === 'win32') {
        command = 'powershell';
        args = [
          '-Command',
          `Add-Type -AssemblyName System.Speech; ` +
          `$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
          (voice ? `$speak.SelectVoice('${voice}'); ` : '') +
          `$speak.Rate = ${Math.round(rate / 50)}; ` +
          `$speak.Speak('${text.replace(/'/g, "''")}');`
        ];
      } else {
        // Linux
        command = 'espeak';
        args = [];
        if (voice) args.push('-v', voice);
        if (rate) args.push('-s', String(rate));
        args.push(text);
      }

      const child = spawn(command, args, { stdio: 'ignore' });

      child.on('error', (error) => {
        logger.error('TTS failed', { error: error.message, command });
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`TTS exited with code ${code}`));
        }
      });
    });
  }
}

module.exports = new SpeechService();
