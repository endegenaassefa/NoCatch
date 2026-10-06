'use strict';

// A profile lock cannot coordinate normal and elevated Chromium profiles.
// Windows named pipes have atomic first-owner creation and disappear when
// the owning process dies. This pipe carries status/activation only: never
// commands, paths, settings, secrets, or privileged shutdown requests.
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let detectedSessionId;
function currentSessionId() {
  if (detectedSessionId !== undefined) return detectedSessionId;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const value = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).SessionId`],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error('Cannot identify the interactive Windows session.');
  }
  detectedSessionId = Number(value);
  return detectedSessionId;
}

function pipeName(sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error('Invalid Windows session.');
  return `\\\\.\\pipe\\OpenCluely-session-${sessionId}-v1`;
}

function requestOwner(endpoint, action = 'activate') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let body = '';
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(2500, () => finish(new Error('The existing OpenCluely session did not respond.')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(action + '\n'));
    socket.on('data', data => {
      body += data.toString('utf8');
      if (body.length > 1024) return finish(new Error('Invalid OpenCluely session response.'));
      if (!body.includes('\n')) return;
      try {
        const status = JSON.parse(body.split('\n')[0]);
        if (status.protocol !== 1 || !Number.isSafeInteger(status.pid) || status.pid < 1 ||
            !['normal', 'administrator', 'system'].includes(status.mode) || typeof status.ready !== 'boolean') {
          throw new Error('Invalid OpenCluely session response.');
        }
        finish(null, status);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!body.includes('\n')) finish(new Error('Incomplete OpenCluely session response.')); });
  });
}

async function acquire({ integrity, onActivate, isReady, sessionId = currentSessionId() }) {
  if (!['system', 'high', 'medium', 'medium-plus', 'low', 'untrusted'].includes(integrity)) {
    throw new Error('Cannot verify this process permission level.');
  }
  const endpoint = pipeName(sessionId);
  const mode = integrity === 'system' ? 'system' : integrity === 'high' ? 'administrator' : 'normal';
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(1500, () => socket.destroy());
    let request = '';
    socket.on('data', data => {
      request += data.toString('utf8');
      if (request.length > 64) { socket.destroy(); return; }
      if (!request.includes('\n')) return;
      const action = request.trim();
      if (!['status', 'activate'].includes(action)) { socket.destroy(); return; }
      socket.removeAllListeners('data');
      socket.end(JSON.stringify({ protocol: 1, pid: process.pid, mode, ready: !!isReady() }) + '\n');
      if (action === 'activate') onActivate();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: endpoint, readableAll: true, writableAll: true }, resolve);
    });
  } catch (error) {
    if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    // Never interpret inaccessible/unresponsive ownership as permission to
    // create another controller. Fail closed and let the user retry/Stop.
    const owner = await requestOwner(endpoint);
    return { acquired: false, owner };
  }
  return {
    acquired: true,
    mode,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

module.exports = { acquire, currentSessionId, pipeName, requestOwner };
