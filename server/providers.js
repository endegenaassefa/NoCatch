'use strict';
const { PromptLoader } = require('../prompt-loader');
const prompts = new PromptLoader();
const failure = (code, message) => Object.assign(new Error(message), { code });

// Streaming upstream response parser bounds wire bytes and individual events.
async function readSSE(response, signal, consume) {
  if (!response.ok) {
    await response.body?.cancel();
    throw failure(response.status === 429 ? 'provider_busy' : 'provider_error', 'The AI provider could not complete this request.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw failure('provider_response_limit', 'The AI response exceeded the service limit.');
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      // CRLF may straddle a chunk: normalize again after concatenation.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) consume(data);
      }
      if (buffer.length > 256 * 1024) throw failure('provider_response_limit', 'The AI response exceeded the service limit.');
    }
    if (buffer.trim()) throw failure('provider_interrupted', 'The AI provider stream ended unexpectedly.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function createProvider(config, testEndpoints = {}) {
  prompts.loadPrompts();
  return async function generate(input, { signal, onDelta }) {
    const system = input.skill === 'general'
      ? 'You are a helpful assistant. Answer the user clearly and accurately.'
      : prompts.getSkillPrompt(input.skill, input.language);
    if (!system) throw failure('invalid_skill', 'Unknown skill.');
    let url, headers, body, finished = false;
    if (input.provider === 'gemini') {
      url = testEndpoints.gemini || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:streamGenerateContent?alt=sse`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiKey };
      const parts = [{ text: input.text || 'Describe the image and answer the question shown.' }];
      if (input.image) parts.push({ inlineData: input.image });
      body = { systemInstruction: { parts: [{ text: system }] },
        contents: [...input.history.map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })), { role: 'user', parts }],
        generationConfig: { maxOutputTokens: config.limits.outputTokens } };
    } else {
      url = testEndpoints.deepseek || 'https://api.deepseek.com/chat/completions';
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deepseekKey}` };
      body = { model: config.deepseekModel, stream: true, max_tokens: config.limits.outputTokens,
        messages: [{ role: 'system', content: system }, ...input.history, { role: 'user', content: input.text }] };
    }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
    await readSSE(response, signal, data => {
      if (data === '[DONE]') { finished = true; return; }
      let message;
      try { message = JSON.parse(data); } catch { throw failure('provider_error', 'The AI provider returned an invalid response.'); }
      if (message.error) throw failure('provider_error', 'The AI provider could not complete this request.');
      if (input.provider === 'gemini') {
        if (message.promptFeedback?.blockReason) throw failure('provider_refused', 'The AI provider declined this request.');
        const candidate = message.candidates?.[0];
        for (const part of candidate?.content?.parts || []) if (typeof part.text === 'string' && !part.thought) onDelta(part.text);
        if (candidate?.finishReason) {
          if (!['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw failure('provider_refused', 'The AI provider declined this request.');
          finished = true;
        }
      } else {
        const choice = message.choices?.[0];
        if (typeof choice?.delta?.content === 'string') onDelta(choice.delta.content);
        if (choice?.finish_reason) {
          if (!['stop', 'length'].includes(choice.finish_reason)) throw failure('provider_refused', 'The AI provider declined this request.');
          finished = true;
        }
      }
    });
    if (!finished) throw failure('provider_interrupted', 'The AI provider stream ended unexpectedly.');
  };
}
module.exports = { createProvider, readSSE };
