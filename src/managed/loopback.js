'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { ManagedError } = require('./errors');
async function createLoopback({ signal, timeoutMs = 180000, ports = [0] }) {
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let settled = false, timer, resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  code.catch(() => {});
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
    server.close(); server.closeIdleConnections?.();
    if (error) rejectCode(error); else resolveCode(value);
  };
  const aborted = () => finish(new ManagedError('cancelled'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { res.writeHead(400); res.end('Invalid sign-in response.'); return; }
    if (req.headers.host !== `127.0.0.1:${server.address()?.port}`) { res.writeHead(400); res.end('Invalid sign-in response.'); return; }
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback') { res.writeHead(404); res.end('Not found.'); return; }
    const supplied = url.searchParams.get('state') || '';
    const a = Buffer.from(supplied), b = Buffer.from(state);
    const validState = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (settled || !validState || url.searchParams.getAll('state').length !== 1) { res.writeHead(400); res.end('Invalid sign-in response.'); return; }
    const value = url.searchParams.get('code');
    if (url.searchParams.has('error') || !value || value.length > 8192 || url.searchParams.getAll('code').length !== 1) {
      res.writeHead(400); res.end('Sign-in was not completed.'); finish(new ManagedError('auth_failed')); return;
    }
    res.end('Sign-in response received. You can return to NoCatch.'); finish(null, value);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  let listening = false;
  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
      }); listening = true; break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw new ManagedError('auth_failed'); }
  }
  if (!listening) throw new ManagedError('callback_unavailable');
  server.on('error', () => finish(new ManagedError('auth_failed')));
  const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  timer = setTimeout(() => finish(new ManagedError('auth_expired')), timeoutMs);
  signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
  return { state, verifier, challenge, redirectUri, code, close: aborted };
}
module.exports = { createLoopback };
