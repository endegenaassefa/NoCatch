'use strict';
const fs = require('node:fs');
const path = require('node:path');

const properties = new Set(['issuer', 'clientId', 'apiBaseUrl', 'audience', 'scopes', 'loopbackPorts']);
const missing = () => ({ configured: false, reason: 'Managed service is not configured in this build.' });
const invalid = () => ({ configured: false, reason: 'Managed service configuration is incomplete or invalid.' });

function secureUrl(value) {
  // URL parsing otherwise silently accepts whitespace, backslashes and coercible values.
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\?#]/.test(value) || /[\x00-\x1F\x7F]/.test(value)) throw new Error('Invalid deployment URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Invalid deployment URL');
  return url.toString().replace(/\/$/, '');
}

function validateConfig(raw) {
  try {
    if (raw === undefined || raw === null) return missing();
    if (typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return invalid();
    // This is public desktop configuration. Never silently discard a secret-bearing field.
    if (Reflect.ownKeys(raw).some(key => !properties.has(key))) return invalid();
    if (!Object.keys(raw).length) return missing();
    secureUrl(raw.issuer);
    // OIDC discovery compares issuer identifiers exactly, including a trailing slash.
    const issuer = raw.issuer, apiBaseUrl = secureUrl(raw.apiBaseUrl);
    if ([raw.clientId, raw.audience].some(value => typeof value !== 'string' || !value.trim() || /[\x00-\x1F\x7F]/.test(value))) return invalid();
    if (!Array.isArray(raw.scopes) || !raw.scopes.includes('openid') || [...raw.scopes].some(s => typeof s !== 'string' || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s))) return invalid();
    const loopbackPorts = raw.loopbackPorts === undefined ? [0] : raw.loopbackPorts;
    if (!Array.isArray(loopbackPorts) || !loopbackPorts.length || loopbackPorts.length > 8 || [...loopbackPorts].some(p => !Number.isInteger(p) || (p !== 0 && (p < 1024 || p > 65535)))) return invalid();
    return { configured: true, issuer, apiBaseUrl, clientId: raw.clientId, audience: raw.audience, scopes: [...new Set(raw.scopes)], loopbackPorts: [...loopbackPorts] };
  } catch { return invalid(); }
}

function loadConfig(app, env = process.env) {
  try {
    const filename = path.join(app.getAppPath(), 'managed-config.json');
    let raw = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
    if (!app.isPackaged && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      raw = { ...raw };
      for (const [key, name] of Object.entries({ issuer: 'ISSUER', clientId: 'CLIENT_ID', apiBaseUrl: 'API_BASE_URL', audience: 'AUDIENCE', scopes: 'SCOPES' })) {
        if (env[`NOCATCH_MANAGED_${name}`]) raw[key] = key === 'scopes' ? env[`NOCATCH_MANAGED_${name}`].split(/\s+/) : env[`NOCATCH_MANAGED_${name}`];
      }
    }
    return validateConfig(raw);
  } catch { return invalid(); }
}
module.exports = { loadConfig, validateConfig, secureUrl };
