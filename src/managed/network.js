'use strict';
const { ManagedError } = require('./errors');
async function readJson(response, maximum = 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maximum) throw new ManagedError('invalid_response');
  if (!response.body) throw new ManagedError('invalid_response');
  const reader = response.body.getReader(); let total = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maximum) throw new ManagedError('invalid_response'); chunks.push(Buffer.from(value)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ManagedError('invalid_response'); }
  } finally { await reader.cancel().catch(() => {}); }
}
function sameOriginUrl(base, target) {
  const root = new URL(base), url = new URL(target, `${base}/`);
  if (url.origin !== root.origin || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new ManagedError('invalid_request');
  return url.toString();
}
async function* events(response) {
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new ManagedError('invalid_response');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (block.length > 1024 * 1024) throw new ManagedError('invalid_response');
        let event = 'message', id = '', data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) { let parsed; try { parsed = JSON.parse(data.join('\n')); } catch { throw new ManagedError('invalid_response'); } yield { event, id, data: parsed }; }
      }
      if (buffer.length > 1024 * 1024) throw new ManagedError('invalid_response');
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
}
module.exports = { readJson, sameOriginUrl, events };
