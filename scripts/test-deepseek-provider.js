/**
 * Plain-Node verification for the DeepSeek provider integration.
 *
 * Run:
 *   node --test scripts/test-deepseek-provider.js
 *
 * Covers:
 *   - Gemini→OpenAI request translation (DeepSeekClient.toChatMessages / buildChatBody)
 *   - SSE delta extraction
 *   - config defaults (llm.provider, llm.deepseek)
 *   - LLMService provider switching (env-driven initializeClient / updateApiKey / getStats)
 *   - FirstRunManager treating a DeepSeek key as "configured"
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DeepSeekClient } = require('../src/services/deepseek.client');
const config = require('../src/core/config');
const llmService = require('../src/services/llm.service');
const FirstRunManager = require('../src/core/first-run');

// ---------------------------------------------------------------------------
// Translation: Gemini request → OpenAI chat messages
// ---------------------------------------------------------------------------

test('translates systemInstruction into a system message', () => {
  const request = {
    systemInstruction: { parts: [{ text: 'You are a helpful assistant.' }] },
    contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
  };
  const messages = DeepSeekClient.toChatMessages(request);
  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[0].content, 'You are a helpful assistant.');
  assert.strictEqual(messages[1].role, 'user');
  assert.strictEqual(messages[1].content, 'Hello');
});

test('single text part collapses to a plain string', () => {
  const messages = DeepSeekClient.toChatMessages({
    contents: [{ role: 'user', parts: [{ text: 'What is 2+2?' }] }]
  });
  assert.strictEqual(messages[0].content, 'What is 2+2?');
});

test('translates image inlineData into an image_url data URL', () => {
  const messages = DeepSeekClient.toChatMessages({
    contents: [{
      role: 'user',
      parts: [
        { text: 'Analyze this image' },
        { inlineData: { data: 'aGVsbG8=', mimeType: 'image/png' } }
      ]
    }]
  });
  const content = messages[0].content;
  assert.ok(Array.isArray(content), 'expected array of content blocks');
  assert.strictEqual(content[0].type, 'text');
  assert.strictEqual(content[1].type, 'image_url');
  assert.strictEqual(content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
});

test('maps model role to assistant', () => {
  const messages = DeepSeekClient.toChatMessages({
    contents: [{ role: 'model', parts: [{ text: 'The answer is 42.' }] }]
  });
  assert.strictEqual(messages[0].role, 'assistant');
});

test('skips contents with no usable parts', () => {
  const messages = DeepSeekClient.toChatMessages({
    systemInstruction: { parts: [] },
    contents: [
      { role: 'user', parts: [] },
      { role: 'user', parts: [{ text: '' }] },
      { role: 'user', parts: [{ text: 'Real message' }] }
    ]
  });
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].content, 'Real message');
});

test('buildChatBody maps generationConfig to OpenAI parameters', () => {
  const client = new DeepSeekClient({ apiKey: 'sk-test', model: 'deepseek-flash' });
  const body = client.buildChatBody({
    contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    generationConfig: { temperature: 0.3, topP: 0.8, maxOutputTokens: 2048 }
  }, true);

  assert.strictEqual(body.model, 'deepseek-flash');
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.temperature, 0.3);
  assert.strictEqual(body.top_p, 0.8);
  assert.strictEqual(body.max_tokens, 2048);
  assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

test('extractSSEDelta returns delta content', () => {
  assert.strictEqual(
    DeepSeekClient.extractSSEDelta({ choices: [{ delta: { content: 'Hel' } }] }),
    'Hel'
  );
});

test('extractSSEDelta returns empty for non-content chunks', () => {
  assert.strictEqual(DeepSeekClient.extractSSEDelta({ choices: [{ delta: { role: 'assistant' } }] }), '');
  assert.strictEqual(DeepSeekClient.extractSSEDelta({ choices: [{ delta: {} }] }), '');
  assert.strictEqual(DeepSeekClient.extractSSEDelta({ choices: [] }), '');
  assert.strictEqual(DeepSeekClient.extractSSEDelta({ usage: { total_tokens: 5 } }), '');
  assert.strictEqual(DeepSeekClient.extractSSEDelta(null), '');
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

test('config defaults to gemini provider with deepseek section present', () => {
  assert.strictEqual(config.get('llm.provider'), 'gemini');
  assert.strictEqual(config.get('llm.deepseek.model'), 'deepseek-flash');
  assert.strictEqual(config.get('llm.deepseek.baseUrl'), 'https://api.deepseek.com');
});

// ---------------------------------------------------------------------------
// LLMService provider switching
// ---------------------------------------------------------------------------

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    // Re-sync the service to a deterministic state afterwards.
    llmService.initializeClient();
  }
}

test('initializeClient switches to DeepSeek when LLM_PROVIDER=deepseek', () => {
  withEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-test-key' }, () => {
    llmService.initializeClient();
    assert.strictEqual(llmService.provider, 'deepseek');
    assert.strictEqual(llmService._isDeepSeek(), true);
    assert.strictEqual(llmService.isInitialized, true);
    assert.strictEqual(llmService.model, 'deepseek-flash');
    assert.ok(llmService.deepseekClient, 'deepseekClient should be created');

    const stats = llmService.getStats();
    assert.strictEqual(stats.provider, 'deepseek');
    assert.strictEqual(stats.hasApiKey, true);
    assert.strictEqual(stats.config.model, 'deepseek-flash');
  });
});

test('DeepSeek init fails cleanly without a key', () => {
  withEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: '' }, () => {
    llmService.initializeClient();
    assert.strictEqual(llmService.provider, 'deepseek');
    assert.strictEqual(llmService.isInitialized, false);
    assert.strictEqual(llmService.getStats().hasApiKey, false);
  });
});

test('updateApiKey targets the active provider env var', () => {
  withEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-old' }, () => {
    llmService.updateApiKey('sk-new');
    assert.strictEqual(process.env.DEEPSEEK_API_KEY, 'sk-new');
    assert.strictEqual(llmService.provider, 'deepseek');
  });

  withEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-old' }, () => {
    llmService.updateApiKey('g-new');
    assert.strictEqual(process.env.GEMINI_API_KEY, 'g-new');
    assert.strictEqual(llmService.provider, 'gemini');
  });
});

test('_fallbackEnabled is true by default for both providers', () => {
  withEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-test-key' }, () => {
    llmService.initializeClient();
    assert.strictEqual(llmService._fallbackEnabled(), true);
  });
  assert.strictEqual(llmService._fallbackEnabled(), true); // gemini (restored)
});

test('getGenerationConfig is provider-aware', () => {
  withEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-test-key' }, () => {
    llmService.initializeClient();
    const gen = llmService.getGenerationConfig();
    assert.strictEqual(gen.temperature, 0.7);
    assert.strictEqual(gen.maxOutputTokens, 4096);
  });
});

test('streaming dispatch uses DeepSeek client when provider is deepseek', async () => {
  await withEnv({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-test-key' }, async () => {
    llmService.initializeClient();
    // Point the client at a fake base URL; execution should fail with a
    // network error — the point is that it takes the DeepSeek path.
    llmService.deepseekClient.baseUrl = 'https://127.0.0.1:1';
    await assert.rejects(
      () => llmService._executeStreaming(
        { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        () => {}
      ),
      /DeepSeek/
    );
  });
});

// ---------------------------------------------------------------------------
// FirstRunManager with a DeepSeek key
// ---------------------------------------------------------------------------

test('first-run is satisfied by a DeepSeek key alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-test-'));
  try {
    const envPath = path.join(dir, '.env');
    const sentinelPath = path.join(dir, '.sentinel');
    fs.writeFileSync(envPath, 'LLM_PROVIDER=deepseek\nDEEPSEEK_API_KEY=sk-abc123\n', 'utf8');
    fs.writeFileSync(sentinelPath, 'done', 'utf8');

    const manager = new FirstRunManager({ cwd: dir, envPath, sentinelPath });
    assert.strictEqual(manager.needsOnboarding(), false);

    const status = manager.getStatus();
    assert.strictEqual(status.deepseekConfigured, true);
    assert.strictEqual(status.geminiConfigured, false);
    assert.strictEqual(status.llmProvider, 'deepseek');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first-run still works with a Gemini key alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-test-'));
  try {
    const envPath = path.join(dir, '.env');
    const sentinelPath = path.join(dir, '.sentinel');
    fs.writeFileSync(envPath, 'GEMINI_API_KEY=AIza123\n', 'utf8');
    fs.writeFileSync(sentinelPath, 'done', 'utf8');

    const manager = new FirstRunManager({ cwd: dir, envPath, sentinelPath });
    assert.strictEqual(manager.needsOnboarding(), false);
    assert.strictEqual(manager.getStatus().geminiConfigured, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first-run is required when no LLM key is present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sru-test-'));
  try {
    const envPath = path.join(dir, '.env');
    const sentinelPath = path.join(dir, '.sentinel');
    fs.writeFileSync(envPath, 'SPEECH_PROVIDER=whisper\n', 'utf8');
    fs.writeFileSync(sentinelPath, 'done', 'utf8');

    const manager = new FirstRunManager({ cwd: dir, envPath, sentinelPath });
    assert.strictEqual(manager.needsOnboarding(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
