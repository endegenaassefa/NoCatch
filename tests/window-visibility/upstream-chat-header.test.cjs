'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('chat header has no extra Hide chat X beside capture controls', () => {
  // OpenCluely 0a9da751 has only Clear history in this header. NoCatch adds
  // capture and exam controls; this guards against an adjacent destructive X.
  const html = fs.readFileSync(path.resolve(__dirname, '../../chat.html'), 'utf8');
  const actions = html.match(/<div class="header-actions">([\s\S]*?)<\/div>/)?.[1];
  assert(actions, 'chat header actions exist');
  assert.doesNotMatch(actions, /<button\b[^>]*(?:id="chatCloseBtn"|title="Hide chat"|aria-label="Hide chat")/i,
    'the header must not add a Hide chat control beside capture');
});
