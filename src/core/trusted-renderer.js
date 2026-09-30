const path = require('node:path');
const { fileURLToPath } = require('node:url');
function assertTrustedRenderer(event, root) {
  const frame = event?.senderFrame;
  if (!frame || frame !== event.sender?.mainFrame) throw new Error('Untrusted application frame');
  let file;
  try { file = fileURLToPath(frame.url); } catch (_) { throw new Error('Untrusted application URL'); }
  const pages = ['index.html', 'chat.html', 'llm-response.html', 'settings.html', 'onboarding.html', 'materials.html'];
  if (!pages.some(name => path.resolve(file) === path.resolve(root, name))) throw new Error('Untrusted application page');
}
module.exports = { assertTrustedRenderer };
