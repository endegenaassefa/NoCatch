'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function assertMicrophoneOwner(event, owner, root) {
  if (!owner || event?.sender !== owner || !event.senderFrame || event.senderFrame !== owner.mainFrame) {
    throw new Error('Untrusted microphone frame');
  }
  let file;
  try { file = fileURLToPath(event.senderFrame.url); } catch (_) { throw new Error('Untrusted microphone URL'); }
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(file) !== normalize(path.join(root, 'index.html'))) throw new Error('Untrusted microphone page');
}
module.exports = { assertMicrophoneOwner };
