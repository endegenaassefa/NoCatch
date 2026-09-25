'use strict';
const crypto = require('node:crypto');
const { readJson } = require('../managed/network');

// A setup attempt is one explicit request. Existing chat retry/fallback policies
// are intentionally not used here: an ambiguous failure needs a user decision.
function createDirectSetupAnswer({ llmService, fetchImpl = globalThis.fetch }) {
  return async ({ text, image, provider }, { signal } = {}) => {
    if (!llmService.isInitialized || llmService.provider !== provider) {
      throw new Error('Select and configure this provider in Advanced Settings first.');
    }
    const request = { contents: [{ role: 'user', parts: [{ text }, ...(image ? [{ inlineData: image }] : [])] }] };
    const requestId = `direct-${crypto.randomUUID()}`;
    const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    try {
    if (provider === 'gemini') {
      const result = await llmService.client.models.generateContent({ model: llmService.model, contents: request.contents,
        config: { abortSignal, maxOutputTokens: 4096, httpOptions: { timeout: 60000, retryOptions: { attempts: 1 } } } });
      return { text: llmService.extractTextFromCandidates(result).text, requestId };
    }
    const client = llmService.deepseekClient;
    if (provider !== 'deepseek' || !client) throw new Error('Select and configure DeepSeek in Advanced Settings first.');
    const response = await fetchImpl(`${client.baseUrl}/chat/completions`, {
      method: 'POST', signal: abortSignal, redirect: 'error',
      headers: { Authorization: `Bearer ${client.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(client.buildChatBody({ ...request, generationConfig: { maxOutputTokens: 4096 } }))
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Direct provider request failed (HTTP ${response.status}). You can explicitly try again.`);
    }
    const result = await readJson(response, 2 * 1024 * 1024);
    return { text: result.choices?.[0]?.message?.content, requestId };
    } catch (_) {
      // SDK errors can contain URLs, headers or credentials. They are never UI copy.
      if (signal?.aborted) throw Object.assign(new Error('The operation was cancelled.'), { code: 'CANCELLED' });
      throw Object.assign(new Error('The direct provider request failed. Check your connection and provider settings, then try again.'), { code: 'DIRECT_REQUEST_FAILED' });
    }
  };
}

module.exports = { createDirectSetupAnswer };
