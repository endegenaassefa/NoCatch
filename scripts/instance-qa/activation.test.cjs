'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = process.env.NOCATCH_QA_SOURCE || path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const start = source.indexOf('class ApplicationController {');
const end = source.indexOf('const gotSingleInstanceLock', start);
assert(start >= 0 && end > start, 'real production controller boundary exists');
function fixture({ ready = true, onboarding = false, playground = false } = {}) {
  const output = [];
  const window = { isMinimized: () => true, restore: () => output.push('restore') };
  const Controller = vm.runInNewContext(source.slice(start, end) + '\nApplicationController', {
    logger: { info() {}, error() {} }, app: { isReady: () => true, whenReady: () => Promise.resolve() },
    windowManager: { getWindow: () => window, showAllWindows: () => output.push('show-all'), showOnCurrentDesktop: w => { assert.equal(w, window); output.push('show-current-desktop'); } },
  });
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, { isReady: ready, isFirstRun: onboarding, ingestionPlayground: playground,
    showOnboarding: async () => output.push('onboarding'), playground: { reveal: () => output.push('playground') } });
  return { controller, output };
}
test('duplicate request while Electron ready but app still starting does not reveal incomplete windows', () => {
  const f = fixture({ ready: false }); f.controller.handleSecondInstance(); assert.deepEqual(f.output, []);
});
test('duplicate launch during first run reveals onboarding', () => {
  const f = fixture({ onboarding: true }); f.controller.handleSecondInstance(); assert.deepEqual(f.output, ['onboarding']);
});
test('duplicate launch restores minimized session on current desktop', () => {
  const f = fixture(); f.controller.handleSecondInstance(); assert.deepEqual(f.output, ['restore', 'show-all', 'show-current-desktop']);
});
test('duplicate playground launch reveals its own surface', () => {
  const f = fixture({ playground: true }); f.controller.handleSecondInstance(); assert.deepEqual(f.output, ['playground']);
});
