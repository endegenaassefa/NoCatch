'use strict';
const net = require('node:net');
const options = JSON.parse(process.argv[2]);
const sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.once('data', () => socket.end(JSON.stringify({ protocol: 1,
    pid: options.wrongPid ? process.pid + 1 : process.pid,
    mode: options.mode || 'system', ready: options.badReady ? 'true' : true }) + '\n'));
});
server.listen({ path: '\\\\.\\pipe\\OpenCluely-session-' + options.sessionId + '-v1', readableAll: true, writableAll: true }, () => process.send({ event: 'ready', pid: process.pid }));
process.on('message', message => { if (message === 'close') { for (const socket of sockets) socket.destroy(); server.close(() => process.disconnect()); } });
