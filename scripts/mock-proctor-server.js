#!/usr/bin/env node
/**
 * Mock Proctor Server
 * 
 * Serves the test-proctor.html page and provides a /log endpoint
 * that receives captured events. Run this alongside capture.js
 * to verify the full capture pipeline works.
 * 
 * Usage:
 *   node scripts/mock-proctor-server.js [port]
 * 
 * Then open http://localhost:3000 in your browser with capture.js injected
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 3000;

// Auto-save every received event to these JSONL files.
// Heartbeats (periodic keepalives) go to a SEPARATE file from real proctor
// tells (window_blur / visibilitychange / keydown / paste / copy / ...), so
// log growth no longer reads as "caught" and real events are easy to diff.
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'mock-proctor-events.jsonl');
const HEARTBEAT_FILE = path.join(LOG_DIR, 'mock-proctor-heartbeats.jsonl');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function appendToFile(filePath, line) {
  try {
    fs.appendFileSync(filePath, line + '\n');
  } catch (e) {
    console.error('Could not write log file:', e.message);
  }
}

function saveEvent(body) {
  let isHeartbeat = false;
  try {
    const parsed = JSON.parse(body);
    isHeartbeat = parsed && parsed.type === 'heartbeat';
  } catch (_) { /* raw body — treat as a real event */ }
  appendToFile(isHeartbeat ? HEARTBEAT_FILE : LOG_FILE, body);
}

function saveMarker(note) {
  const marker = JSON.stringify({
    type: 'marker',
    data: { note: String(note || '') },
    ts: new Date().toISOString()
  });
  appendToFile(LOG_FILE, marker);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve the test page
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, '..', 'test-proctor.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading test page');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Log endpoint - receives captured events
  if (url.pathname === '/log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const timestamp = new Date().toISOString();
      saveEvent(body); // heartbeats → heartbeats file, real events → events file
      console.log(`\n[${timestamp}] CAPTURED EVENT:`);
      try {
        const parsed = JSON.parse(body);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log('Raw body:', body);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true, timestamp }));
    });
    return;
  }

  // Marker endpoint - stamps a run boundary into the REAL-events file so
  // automated test matrices can attribute events to specific actions.
  if (url.pathname === '/marker' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let note = '';
      try { note = JSON.parse(body).note || ''; } catch (_) { note = body; }
      saveMarker(note);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ marked: true, note, timestamp: new Date().toISOString() }));
    });
    return;
  }

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Mock Proctor Server running at http://localhost:${PORT}`);
  console.log(`\nTo test:`);
  console.log(`1. Open http://localhost:${PORT} in your browser`);
  console.log(`2. Inject capture.js into the page (via console or bookmarklet)`);
  console.log(`3. Type, switch tabs, click the screenshot button`);
  console.log(`4. Watch this console for captured events`);
  console.log(`\nPress Ctrl+C to stop\n`);
});
