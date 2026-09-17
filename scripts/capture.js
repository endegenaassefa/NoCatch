/**
 * net-capture — Playwright network-capture utility.
 *
 * Injects a helper via page.addInitScript (before any page script runs) that
 * monkey-patches window.fetch, XMLHttpRequest.prototype.send,
 * navigator.sendBeacon, and WebSocket.prototype.send. Every call is streamed
 * back to Node through an exposed bridge function, logged to capture.json
 * (plus a streaming capture.jsonl), and scanned for test configuration keys
 * which are written to config.json.
 *
 * Usage:
 *   node capture.js <URL> [options]
 *   TARGET_URL=<URL> node capture.js [options]
 */

import { chromium } from 'playwright';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_KEYS = [
  'enable_proctoring',
  'candidateTabSwitch',
  'trackEditorPaste',
  'enable_keystroke_tracking',
];

const MAX_STRING = 50000;   // cap on captured request bodies
const MAX_RESPONSE = 50000; // cap on captured response bodies

function truncate(str, max) {
  if (str == null) return str;
  str = String(str);
  if (str.length <= max) return str;
  return str.slice(0, max) + `…[truncated ${str.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(`
net-capture — capture outgoing network traffic and extract runtime config.

Usage:
  node capture.js <URL> [options]
  TARGET_URL=<URL> node capture.js [options]

Options:
  --headed                 Run with a visible browser (default: headless).
  --interactive            Keep capturing until you press Enter (or close the
                           browser). Use with --headed. Ignores the default
                           --wait timer; pass --wait <ms> to set a max limit.
  --wait <ms>              How long to capture after load (default: 15000).
  --out <dir>              Output directory (default: current dir).
  --storage-state <file>   Load a saved browser session (cookies/localStorage).
  --save-storage <file>    Save the session after capture (e.g. after manual login).
  --config-keys <csv>      Comma-separated config keys to extract.
  --timeout <ms>           Navigation timeout (default: 45000).
  -h, --help               Show this help.

Outputs (in --out dir):
  capture.json             Full structured array of captured events.
  capture.jsonl            Newline-delimited stream of events (arrival order).
  config.json              Extracted runtime configuration.
`);
}

function parseArgs(argv) {
  const opts = {
    url: process.env.TARGET_URL || null,
    headless: process.env.HEADLESS !== 'false',
    waitMs: Number(process.env.WAIT_MS) || 15000,
    outDir: process.env.OUT_DIR || '.',
    storageState: process.env.STORAGE_STATE || null,
    saveStorage: process.env.SAVE_STORAGE || null,
    configKeys: null,
    timeout: Number(process.env.GOTO_TIMEOUT) || 45000,
    interactive: process.env.INTERACTIVE === 'true',
    waitMsExplicit: process.env.WAIT_MS != null,
    help: false,
  };
  const args = argv.slice(2);
  const next = (i) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--headed': opts.headless = false; break;
      case '--wait': opts.waitMs = Number(next(i++)); opts.waitMsExplicit = true; break;
      case '--interactive':
      case '--until-enter': opts.interactive = true; break;
      case '--out': opts.outDir = next(i++); break;
      case '--storage-state': opts.storageState = next(i++); break;
      case '--save-storage': opts.saveStorage = next(i++); break;
      case '--config-keys': opts.configKeys = next(i++); break;
      case '--timeout': opts.timeout = Number(next(i++)); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (!a.startsWith('--') && !opts.url) opts.url = a;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// In-page init script (serialized by Playwright, runs before page scripts)
// ---------------------------------------------------------------------------
function initScript() {
  if (window.__netCaptureInstalled) return;
  window.__netCaptureInstalled = true;
  if (!window.__netEvents) window.__netEvents = [];

  function emit(payload) {
    try { window.__netEvents.push(payload); } catch (e) {}
    try {
      if (typeof window.__netCaptureBridge === 'function') {
        window.__netCaptureBridge(payload);
      }
    } catch (e) {}
  }

  function messageOf(e) {
    try { return (e && e.message) ? String(e.message) : String(e); }
    catch (e2) { return 'unknown error'; }
  }

  function trunc(s, max) {
    if (s == null) return s;
    s = String(s);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…[truncated ' + (s.length - max) + ' chars]';
  }

  function toBase64(u8) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function serializeHeaders(headers) {
    if (headers == null) return {};
    const out = {};
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach(function (v, k) { out[String(k)] = String(v); });
        return out;
      }
      if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i++) {
          const pair = headers[i];
          if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
        }
        return out;
      }
      if (typeof headers === 'object') {
        for (const k in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, k)) out[k] = String(headers[k]);
        }
        return out;
      }
    } catch (e) {}
    return out;
  }

  function serializeBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return trunc(body, 50000);
    if (typeof File !== 'undefined' && body instanceof File) {
      return { _type: 'File', name: body.name, size: body.size, mimeType: body.type || null };
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return { _type: 'Blob', size: body.size, mimeType: body.type || null };
    }
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      return { _type: 'ArrayBuffer', base64: toBase64(new Uint8Array(body)) };
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
      const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      return { _type: 'ArrayBufferView', base64: toBase64(view) };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const entries = [];
      body.forEach(function (value, key) {
        if (typeof File !== 'undefined' && value instanceof File) {
          entries.push({ name: key, _type: 'File', fileName: value.name, size: value.size, mimeType: value.type || null });
        } else if (typeof value === 'string') {
          entries.push({ name: key, value: trunc(value, 50000) });
        } else {
          entries.push({ name: key, value: String(value) });
        }
      });
      return { _type: 'FormData', entries: entries };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return trunc(body.toString(), 50000);
    }
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return { _type: 'ReadableStream' };
    }
    try {
      return JSON.parse(JSON.stringify(body));
    } catch (e) {
      try { return trunc(String(body), 50000); } catch (e2) { return null; }
    }
  }

  function isTextual(contentType) {
    if (!contentType) return true;
    const ct = String(contentType).toLowerCase();
    return ct.indexOf('json') !== -1 ||
      ct.indexOf('text') !== -1 ||
      ct.indexOf('javascript') !== -1 ||
      ct.indexOf('xml') !== -1 ||
      ct.indexOf('x-www-form-urlencoded') !== -1 ||
      ct.indexOf('form-data') !== -1 ||
      ct.indexOf('graphql') !== -1;
  }

  function newId(prefix, started) {
    return prefix + '-' + started + '-' + Math.random().toString(36).slice(2, 8);
  }

  // --- window.fetch ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const started = Date.now();
      init = init || {};
      const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
      const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
      const headers = init.headers !== undefined ? init.headers : (input && input.headers);
      const body = init.body !== undefined ? init.body : undefined;
      const id = newId('fetch', started);
      const req = { id: id, type: 'fetch', url: url, method: method, headers: serializeHeaders(headers), body: serializeBody(body), started: started };

      let promise;
      try {
        promise = origFetch.apply(this, arguments);
      } catch (e) {
        emit(Object.assign({}, req, { error: messageOf(e), duration: Date.now() - started }));
        throw e;
      }

      promise.then(function (resp) {
        try {
          const base = { status: resp.status, responseHeaders: serializeHeaders(resp.headers), duration: Date.now() - started };
          const ct = String(resp.headers.get('content-type') || '');
          if (!isTextual(ct)) {
            emit(Object.assign({}, req, base));
            return;
          }
          resp.clone().text().then(function (text) {
            emit(Object.assign({}, req, base, { responseBody: trunc(text, 50000) }));
          }).catch(function () {
            emit(Object.assign({}, req, base));
          });
        } catch (e) {
          emit(Object.assign({}, req, { error: messageOf(e), duration: Date.now() - started }));
        }
      }).catch(function (e) {
        emit(Object.assign({}, req, { error: messageOf(e), duration: Date.now() - started }));
      });

      return promise;
    };
  }

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__capture = { method: String(method).toUpperCase(), url: String(url), requestHeaders: {} };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__capture) this.__capture.requestHeaders[String(name)] = String(value);
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const cap = xhr.__capture || { method: 'GET', url: '', requestHeaders: {} };
    cap.body = body;
    const started = Date.now();

    xhr.addEventListener('loadend', function () {
      let responseBody = null;
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') {
          responseBody = trunc(xhr.responseText, 50000);
        } else if (xhr.responseType === 'json' && xhr.response != null) {
          responseBody = trunc(JSON.stringify(xhr.response), 50000);
        }
      } catch (e) {}

      emit({
        id: newId('xhr', started),
        type: 'xhr',
        url: cap.url,
        method: cap.method,
        headers: cap.requestHeaders || {},
        body: serializeBody(cap.body),
        status: xhr.status,
        responseHeaders: parseHeaders(xhr.getAllResponseHeaders()),
        responseBody: responseBody,
        error: (xhr.readyState === 4 && xhr.status === 0) ? 'request-failed-or-aborted' : null,
        started: started,
        duration: Date.now() - started,
      });
    });

    return origSend.apply(this, arguments);
  };

  function parseHeaders(raw) {
    const out = {};
    if (!raw) return out;
    raw.trim().split(/[\r\n]+/).forEach(function (line) {
      const idx = line.indexOf(':');
      if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return out;
  }

  // --- navigator.sendBeacon ---
  const origBeacon = navigator.sendBeacon;
  if (typeof origBeacon === 'function') {
    navigator.sendBeacon = function (url, data) {
      const started = Date.now();
      const id = newId('beacon', started);
      let ok = false;
      let error = null;
      try { ok = origBeacon.apply(this, arguments); } catch (e) { error = messageOf(e); }
      emit({ id: id, type: 'beacon', url: String(url), method: 'POST', body: serializeBody(data), ok: ok, error: error, started: started, duration: Date.now() - started });
      return ok;
    };
  }

  // --- WebSocket.prototype.send ---
  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const started = Date.now();
    const id = newId('ws', started);
    emit({ id: id, type: 'websocket-send', url: this.url || '', body: serializeBody(data), started: started, duration: Date.now() - started });
    return origWsSend.apply(this, arguments);
  };
}

// ---------------------------------------------------------------------------
// Config extraction (Node side)
// ---------------------------------------------------------------------------
function normalizeKey(s) {
  return String(s).toLowerCase().replace(/[_\-\s.]/g, '');
}

function search(value, source, found, sources, keys) {
  if (value == null) return;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed != null && typeof parsed === 'object') search(parsed, source, found, sources, keys);
    } catch (e) {}
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) search(item, source, found, sources, keys);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const nk = normalizeKey(k);
      for (const key of keys) {
        if (nk === normalizeKey(key) && !(key in found)) {
          found[key] = v;
          sources[key] = source;
        }
      }
      search(v, source, found, sources, keys);
    }
  }
}

function extractConfig(events, keys) {
  const found = {};
  const sources = {};
  events.forEach((ev, i) => {
    const label = (ev.type || 'event') + ' ' + (ev.url || '') + ' (#event ' + i + ')';
    for (const field of ['body', 'responseBody', 'headers', 'responseHeaders']) {
      const v = ev[field];
      if (v != null) search(v, label + '.' + field, found, sources, keys);
    }
  });
  return { config: found, sources };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return; }
  if (!opts.url) {
    console.error('ERROR: no target URL provided.');
    printHelp();
    process.exitCode = 1;
    return;
  }

  mkdirSync(opts.outDir, { recursive: true });
  const captureFile = path.join(opts.outDir, 'capture.json');
  const ndjsonFile = path.join(opts.outDir, 'capture.jsonl');
  const configFile = path.join(opts.outDir, 'config.json');

  try { writeFileSync(ndjsonFile, ''); } catch (e) {}

  const events = [];
  const seen = new Set();

  function handleEvent(payload) {
    try {
      if (!payload || typeof payload !== 'object') return;
      const id = payload.id;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      payload.capturedAt = new Date().toISOString();
      events.push(payload);
      appendFileSync(ndjsonFile, JSON.stringify(payload) + '\n');
    } catch (e) {}
  }

  const configKeys = opts.configKeys
    ? opts.configKeys.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CONFIG_KEYS;

  console.log('Launching Chromium (headless=' + opts.headless + ')...');
  const browser = await chromium.launch({ headless: opts.headless });

  const contextOptions = { viewport: { width: 1440, height: 900 } };
  if (opts.storageState && existsSync(opts.storageState)) {
    contextOptions.storageState = opts.storageState;
  }
  const context = await browser.newContext(contextOptions);

  await context.exposeFunction('__netCaptureBridge', handleEvent);
  await context.addInitScript(initScript);

  const page = await context.newPage();
  page.on('pageerror', (err) => {
    handleEvent({ id: 'pageerror-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), type: 'pageerror', message: String(err && err.message ? err.message : err) });
  });

  const startedAt = new Date().toISOString();
  console.log('Navigating to ' + opts.url + ' ...');
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
  } catch (e) {
    console.warn('Navigation warning: ' + e.message);
  }

  if (opts.interactive) {
    const ceiling = opts.waitMsExplicit ? opts.waitMs : 30 * 60 * 1000;
    console.log('');
    console.log('  ==> Browser is open. Click around, log in, do whatever you need.');
    console.log('  ==> When you are DONE, come back to this Terminal window and press Enter.');
    if (opts.waitMsExplicit) console.log('  ==> Auto-stop after ' + ceiling + ' ms.');
    else console.log('  ==> Safety auto-stop after 30 minutes.');
    console.log('');
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (why) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (why) console.log(why);
        try { process.stdin.pause(); } catch (e) {}
        resolve();
      };
      try {
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', () => finish('Enter pressed — stopping capture.'));
        process.stdin.once('end', () => finish('Input closed — stopping capture.'));
      } catch (e) {}
      browser.on('disconnected', () => finish('Browser window closed — stopping capture.'));
      timer = setTimeout(() => finish('Auto-stop limit reached — stopping capture.'), ceiling);
    });
  } else {
    console.log('Capturing for ' + opts.waitMs + ' ms ...');
    await new Promise((r) => setTimeout(r, opts.waitMs));
  }

  if (opts.saveStorage) {
    try {
      await context.storageState({ path: opts.saveStorage });
      console.log('Saved storage state to ' + opts.saveStorage);
    } catch (e) {
      console.warn('Could not save storage state: ' + e.message);
    }
  }

  // Drain the in-page buffer as a fallback (deduped by id).
  try {
    const buffered = await page.evaluate(() => {
      try { return window.__netEvents || []; } catch (e) { return []; }
    });
    if (Array.isArray(buffered)) for (const p of buffered) handleEvent(p);
  } catch (e) {}

  // Scan window globals for config (covers inline config objects not sent over the wire).
  let windowConfig = {};
  try {
    windowConfig = await page.evaluate((keys) => {
      const normalize = (s) => String(s).toLowerCase().replace(/[_\-\s.]/g, '');
      const normalizedKeys = keys.map(normalize);
      const found = {};
      const visited = new Set();

      function safeClone(v) {
        try {
          if (typeof v === 'object' && v !== null) return JSON.parse(JSON.stringify(v));
          return v;
        } catch (e) { return String(v); }
      }

      function visit(obj, depth) {
        if (obj == null || depth > 3) return;
        if (typeof obj !== 'object') return;
        if (visited.has(obj)) return;
        visited.add(obj);
        let names;
        try { names = Object.keys(obj); } catch (e) { return; }
        for (let i = 0; i < names.length; i++) {
          const k = names[i];
          try {
            const v = obj[k];
            const nk = normalize(k);
            for (let j = 0; j < normalizedKeys.length; j++) {
              if (nk === normalizedKeys[j] && !(keys[j] in found)) {
                found[keys[j]] = safeClone(v);
              }
            }
            if (v && typeof v === 'object' && depth < 3) visit(v, depth + 1);
          } catch (e) {}
        }
      }

      try { visit(window, 0); } catch (e) {}
      return found;
    }, configKeys);
  } catch (e) {}

  try { await browser.close(); } catch (e) {}

  writeFileSync(captureFile, JSON.stringify(events, null, 2));

  const { config, sources } = extractConfig(events, configKeys);
  for (const [k, v] of Object.entries(windowConfig)) {
    if (!(k in config)) {
      config[k] = v;
      sources[k] = 'window global';
    }
  }

  writeFileSync(configFile, JSON.stringify({
    targetUrl: opts.url,
    capturedAt: startedAt,
    eventCount: events.length,
    configKeys,
    config,
    sources,
  }, null, 2));

  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

  console.log('\nDone.');
  console.log('Events captured: ' + events.length + ' ' + JSON.stringify(byType));
  console.log('Wrote: ' + captureFile);
  console.log('Wrote: ' + ndjsonFile);
  console.log('Wrote: ' + configFile);
  console.log('\nExtracted config:');
  for (const k of configKeys) {
    const val = k in config ? JSON.stringify(config[k]) : '(not found)';
    const src = k in sources ? ' [' + sources[k] + ']' : '';
    console.log('  ' + k + ' => ' + val + src);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
