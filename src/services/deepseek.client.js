/**
 * DeepSeek (OpenAI-compatible) client.
 *
 * DeepSeek exposes a standard Chat Completions API at
 * https://api.deepseek.com/chat/completions. This client translates the
 * Gemini-shaped request objects produced by llm.service.js (contents +
 * systemInstruction + generationConfig) into OpenAI chat messages and
 * executes them, both streaming and non-streaming.
 *
 * The `deepseek-flash` model accepts images (JPEG/PNG/GIF/WebP) as
 * `image_url` data URLs inside user messages — see
 * https://api-docs.deepseek.com/guides/vision/
 */

const https = require('https');
const logger = require('../core/logger').createServiceLogger('DeepSeek');

class DeepSeekClient {
  constructor(options = {}) {
    this.provider = options.provider || 'deepseek';
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'deepseek-flash';
    this.baseUrl = String(options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.timeout = options.timeout || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.fallbackModels = options.fallbackModels || [];
    this.generation = options.generation || {};
    this.userAgent = options.userAgent || `Node.js/${process.version} (${process.platform}; ${process.arch})`;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Translation: Gemini-shaped request → OpenAI chat messages
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Convert a Gemini contents array into OpenAI chat messages.
   * @param {object} geminiRequest - { systemInstruction, contents, generationConfig }
   * @returns {Array<{role: string, content: string|Array}>}
   */
  static toChatMessages(geminiRequest) {
    const messages = [];

    const systemText = DeepSeekClient._systemText(geminiRequest.systemInstruction);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }

    for (const item of geminiRequest.contents || []) {
      const role = item.role === 'model' ? 'assistant' : 'user';
      const parts = Array.isArray(item.parts) ? item.parts : [];
      const content = DeepSeekClient.partsToContent(parts);
      if (content === null) continue; // no usable parts
      messages.push({ role, content });
    }

    return messages;
  }

  static _systemText(systemInstruction) {
    if (!systemInstruction || !Array.isArray(systemInstruction.parts)) return '';
    return systemInstruction.parts
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .join('\n')
      .trim();
  }

  /**
   * Convert Gemini parts to OpenAI content. A single text part collapses to
   * a plain string; anything with images (or multiple parts) becomes an
   * array of content blocks.
   * @param {Array} parts - Gemini parts ({text} and/or {inlineData})
   * @returns {string|Array|null} OpenAI content, or null when empty
   */
  static partsToContent(parts) {
    const usable = parts.filter(
      (p) => p && ((typeof p.text === 'string' && p.text.length > 0) ||
        (p.inlineData && p.inlineData.data))
    );
    if (usable.length === 0) return null;

    const blocks = usable.map((p) => {
      if (p.inlineData && p.inlineData.data) {
        const mimeType = p.inlineData.mimeType || 'image/png';
        return {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${p.inlineData.data}` }
        };
      }
      return { type: 'text', text: p.text };
    });

    if (blocks.length === 1 && blocks[0].type === 'text') {
      return blocks[0].text;
    }
    return blocks;
  }

  /**
   * Build a full Chat Completions body from a Gemini-shaped request.
   * @param {object} geminiRequest
   * @param {boolean} stream
   */
  buildChatBody(geminiRequest, stream = false) {
    const {getProviderCapabilities} = require('../core/ai-providers');
    if ((geminiRequest.contents || []).some(c => (c.parts || []).some(p => p.inlineData)) && !getProviderCapabilities(this.provider, this.model, this.baseUrl).vision) throw new Error('The selected model does not support images.');
    const gen = geminiRequest.generationConfig || this.generation || {};
    const body = {
      model: this.model,
      messages: DeepSeekClient.toChatMessages(geminiRequest),
      stream,
      // Disable DeepSeek's hidden reasoning phase. Without this, reasoning
      // tokens are spent before any answer content is emitted, and on image
      // requests the reasoning alone can consume the whole max_tokens budget
      // — the API then ends with finish_reason "length" and ZERO answer
      // content. (Validated live: thinking disabled returns content in ~36
      // tokens instead of burning the entire cap.) The reasoning text was
      // never surfaced in the UI anyway, so this is pure latency/cost saved.
      ...(this.provider === 'deepseek' ? {thinking: { type: 'disabled' }} : this.baseUrl.includes('maas.aliyuncs.com') || this.baseUrl.includes('dashscope') ? {enable_thinking: false} : this.baseUrl.includes('openrouter.ai') ? {reasoning: {enabled: false}} : {})
    };

    if (gen.temperature !== undefined && gen.temperature !== null) {
      body.temperature = gen.temperature;
    }
    if (gen.topP !== undefined && gen.topP !== null) {
      body.top_p = gen.topP;
    }
    if (gen.maxOutputTokens !== undefined && gen.maxOutputTokens !== null) {
      body.max_tokens = gen.maxOutputTokens;
    }

    return body;
  }

  // ─────────────────────────────────────────────────────────────────────
  // SSE helpers (pure, exported for tests)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Extract the incremental text delta from one parsed SSE JSON object.
   * Returns '' for non-content chunks (usage, role-only deltas, etc).
   */
  static extractSSEDelta(json) {
    try {
      const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) return '';
      return typeof delta.content === 'string' ? delta.content : '';
    } catch (_) {
      return '';
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Deterministic-empty errors (no content, or the API hit its output cap
   * before emitting any content) are NOT retryable: the request completed,
   * the response was just empty. Retrying burns ~20s per attempt and delays
   * the honest fallback. Only transport/overload errors retry.
   */
  static isDeterministicEmpty(error) {
    return /Empty (streamed )?response|finish_reason.?=.?length/i.test(error && error.message ? error.message : '');
  }

  async executeNonStreaming(geminiRequest) {
    const modelsToTry = [this.model, ...(this.fallbackModels || [])];
    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const body = { ...this.buildChatBody(geminiRequest, false), model: modelName };
          const text = await this._post(body, modelName);

          if (!text || !text.trim()) {
            throw new Error('Empty response from DeepSeek API');
          }

          logger.debug('DeepSeek request successful', {
            attempt,
            model: modelName,
            responseLength: text.length
          });
          return text;
        } catch (error) {
          lastError = error;
          const isUnavailable = /503|overloaded|busy|rate.?limit|insufficient_quota/i.test(error.message);
          const deterministic = DeepSeekClient.isDeterministicEmpty(error);
          logger.warn(`DeepSeek attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            remainingAttempts: this.maxRetries - attempt,
            model: modelName,
            retryable: !deterministic
          });

          if (deterministic) {
            break; // empty-but-complete responses never improve on retry
          }
          if (isUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break; // try the next fallback model
          }
          if (attempt === this.maxRetries) {
            break;
          }
          await this._delay(1500 * attempt + Math.random() * 1000);
        }
      }
    }

    throw lastError || new Error('DeepSeek request failed');
  }

  async executeStreaming(geminiRequest, onDelta) {
    const modelsToTry = [this.model, ...(this.fallbackModels || [])];
    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const body = { ...this.buildChatBody(geminiRequest, true), model: modelName };
          const fullText = await this._postStream(body, modelName, onDelta);

          if (!fullText) {
            throw new Error('Empty streamed response from DeepSeek API');
          }

          logger.debug('DeepSeek streaming request successful', {
            attempt,
            model: modelName,
            responseLength: fullText.length
          });
          return fullText;
        } catch (error) {
          lastError = error;
          const isUnavailable = /503|overloaded|busy|rate.?limit|insufficient_quota/i.test(error.message);
          const deterministic = DeepSeekClient.isDeterministicEmpty(error);
          logger.warn(`DeepSeek streaming attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            remainingAttempts: this.maxRetries - attempt,
            model: modelName,
            retryable: !deterministic
          });

          if (deterministic) {
            break;
          }
          if (isUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break;
          }
          if (attempt === this.maxRetries) {
            break;
          }
          await this._delay(1500 * attempt + Math.random() * 1000);
        }
      }
    }

    throw lastError || new Error('DeepSeek streaming request failed');
  }

  _post(body, modelName) {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/chat/completions`;
      const postData = JSON.stringify(body);

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': this.userAgent
        },
        timeout: this.timeout
      };

      const req = https.request(url, options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              let apiMessage = '';
              try {
                const parsed = JSON.parse(data);
                apiMessage = parsed?.error?.message || '';
              } catch (_) { /* keep raw body */ }
              reject(new Error(`Provider HTTP ${res.statusCode}`));
              return;
            }
            const json = JSON.parse(data);
            const choice = json?.choices?.[0] || {};
            const text = choice?.message?.content || '';
            const finishReason = choice?.finish_reason || '';
            if (!text.trim() && finishReason === 'length') {
              reject(new Error('Response cut off by token limit before any content was produced (finish_reason=length)'));
              return;
            }
            resolve(text.trim());
          } catch (parseError) {
            reject(new Error(`Failed to parse DeepSeek response: ${parseError.message}`));
          }
        });
        res.on('error', (error) => reject(new Error(`DeepSeek response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`DeepSeek request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('DeepSeek request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  _postStream(body, modelName, onDelta) {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl}/chat/completions`;
      const postData = JSON.stringify(body);

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'text/event-stream',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': this.userAgent
        },
        timeout: this.timeout
      };

      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`Provider HTTP ${res.statusCode}`)));
          return;
        }

        let fullText = '';
        let buffer = '';
        let finishReason = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload) {
              continue;
            }
            if (payload === '[DONE]') {
              continue;
            }
            try {
              const json = JSON.parse(payload);
              if (json?.choices?.[0]?.finish_reason) {
                finishReason = json.choices[0].finish_reason;
              }
              const piece = DeepSeekClient.extractSSEDelta(json);
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') {
                  onDelta(piece);
                }
              }
            } catch (_) {
              // Skip lines that don't parse cleanly.
            }
          }
        });

        res.on('end', () => {
          if (!fullText.trim() && finishReason === 'length') {
            reject(new Error('Response cut off by token limit before any content was produced (finish_reason=length)'));
            return;
          }
          resolve(fullText.trim());
        });
        res.on('error', (error) => reject(new Error(`DeepSeek stream error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`DeepSeek streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('DeepSeek streaming request timeout'));
      });

      req.write(postData);
      req.end();
    });
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { DeepSeekClient };
