'use strict';
const { createHash } = require('node:crypto');

function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error(`${name} must be an HTTPS URL without credentials, query or fragment`);
  return url;
}
function integer(env, name, fallback, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be 1..${maximum}`);
  return value;
}
function readConfig(env = process.env) {
  const issuer = httpsUrl(env.OIDC_ISSUER, 'OIDC_ISSUER').href;
  const jwksUrl = httpsUrl(env.OIDC_JWKS_URL, 'OIDC_JWKS_URL').href;
  if (!env.OIDC_AUDIENCE?.trim()) throw new Error('OIDC_AUDIENCE is required');
  if (!env.GEMINI_API_KEY && !env.DEEPSEEK_API_KEY && !env.QWEN_API_KEY) throw new Error('At least one AI provider key is required');
  const qwen = require('../src/core/ai-providers').resolveProvider({provider:'qwen'},env);
  return {
    issuer, jwksUrl, audience: env.OIDC_AUDIENCE,
    allowedSubjects: (env.OIDC_ALLOWED_SUBJECTS || '').split(',').map(s => s.trim()).filter(Boolean),
    port: integer(env, 'PORT', 8080, 65535), host: env.HOST || '0.0.0.0',
    database: env.DATABASE_PATH || './data/managed.sqlite',
    qwenKey:qwen.apiKey,qwenModel:qwen.model,qwenBaseUrl:qwen.baseUrl,geminiKey: env.GEMINI_API_KEY, deepseekKey: env.DEEPSEEK_API_KEY,
    geminiModel: env.GEMINI_MODEL || 'gemini-3.1-flash-lite', deepseekBaseUrl: require('../src/core/ai-providers').resolveProvider({provider:'deepseek'},env).baseUrl, deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-flash',
    limits: {
      dailyAccount: integer(env, 'DAILY_ACCOUNT_REQUESTS', 50, 10000),
      dailyGlobal: integer(env, 'DAILY_GLOBAL_REQUESTS', 1000, 100000),
      activeAccount: integer(env, 'ACTIVE_ACCOUNT_REQUESTS', 2, 10),
      activeGlobal: integer(env, 'ACTIVE_GLOBAL_REQUESTS', 20, 100),
      maxRecords: integer(env, 'MAX_STORED_REQUESTS', 2000, 10000),
      retentionMs: integer(env, 'RETENTION_HOURS', 24, 168) * 3600000,
      timeoutMs: integer(env, 'REQUEST_TIMEOUT_SECONDS', 90, 180) * 1000,
      bodyBytes: 8 * 1024 * 1024, imageBytes: 2 * 1024 * 1024,
      inputChars: 96000, historyTurns: 20, outputChars: 32768, outputTokens: 4096,
      eventsPerRequest: 512, subscribersPerRequest: 3, subscribersGlobal: 100
    }
  };
}
async function createAuthenticator(config, testKeyResolver) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const keys = testKeyResolver || createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000, cooldownDuration: 30000 });
  return async function authenticate(req) {
    const match = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(req.headers.authorization || '');
    if (!match) throw Object.assign(new Error('Sign in to continue.'), { status: 401, code: 'unauthorized' });
    try {
      const { payload } = await jwtVerify(match[1], keys, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5
      });
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 ||
          (payload.sid !== undefined && (typeof payload.sid !== 'string' || !payload.sid || payload.sid.length > 256))) throw new Error('Invalid subject/session');
      if (config.allowedSubjects?.length && !config.allowedSubjects.includes(payload.sub))
        throw Object.assign(new Error('This account has not been invited.'), { status: 403, code: 'not_invited' });
      const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      return { subject: payload.sub, account: hash([config.issuer, payload.sub]),
        owner: hash([config.issuer, payload.sub, payload.sid || null]), expiresAt: payload.exp * 1000 };
    } catch (error) {
      if (error.code === 'not_invited') throw error;
      throw Object.assign(new Error('Your session is invalid or expired. Sign in again.'), { status: 401, code: 'unauthorized' });
    }
  };
}
module.exports = { readConfig, createAuthenticator };
