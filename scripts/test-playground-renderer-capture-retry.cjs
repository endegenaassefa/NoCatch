'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = process.env.PLAYGROUND_PROJECT || path.resolve(__dirname, '..');

// Execute the shipped renderer and its actual registered click callback. The DOM
// adapter models only the layout dependency at issue: a visible banner adds 64px
// above the question panel. Native browser validation remains a separate gate.
async function renderer() {
  const elements = new Map(), measurements = [], captures = [];
  let onError;
  const make = id => ({
    id, hidden: false, open: false, disabled: false, value: '', checked: false,
    textContent: '', dataset: {}, listeners: new Map(), children: [],
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect() {
      const bannerHidden = element('error').hidden;
      measurements.push({ bannerHidden });
      return { x: 240, y: bannerHidden ? 140 : 204, width: 760, height: 330 };
    }
  });
  function element(id) { if (!elements.has(id)) elements.set(id, make(id)); return elements.get(id); }
  const current = { phase: 'running', mode: 'diagnostic', runId: 'retry-run', generation: 7,
    questionIndex: 0, questions: [{ id: 'Q05', title: 'Lost acknowledgment', text: 'Which key is reused?' }],
    answers: {}, records: [], events: [], busy: false, materialSession: null,
    focusAcknowledgementRequired: false, exitConfirmationRequired: false };
  const api = {
    onState() {}, onError(fn) { onError = fn; }, onExit() {},
    async invoke(action, payload) {
      if (action === 'state') return { success: true, value: current };
      if (action === 'capture') {
        const expected = { x: 240, y: element('error').hidden ? 140 : 204, width: 760, height: 330 };
        const accepted = JSON.stringify(expected) === JSON.stringify(payload.rect);
        captures.push({ payload, expected, accepted });
        return accepted ? { success: true, value: null } : { success: false, error: 'The question panel moved. Use Capture question again.' };
      }
      return { success: true, value: null };
    }
  };
  const context = vm.createContext({ window: { playground: api },
    document: { getElementById: element, createElement: make, addEventListener() {},
      querySelectorAll() { return []; }, querySelector() { throw new Error('Unexpected selector'); } },
    setInterval() {}, Date, console });
  const filename = path.join(project, 'src/ui/playground.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  await new Promise(resolve => setImmediate(resolve));
  return { element, measurements, captures, showError: message => onError(message),
    async clickCapture() {
      const handler = element('capture-question').listeners.get('click');
      assert.equal(typeof handler, 'function', 'real renderer must register Capture question');
      await handler();
      await new Promise(resolve => setImmediate(resolve));
    } };
}

test('actual renderer captures current question when no error banner is present', async () => {
  const r = await renderer();
  await r.clickCapture();
  assert.equal(r.captures.length, 1);
  assert.equal(r.captures[0].payload.questionId, 'Q05');
  assert.equal(r.captures[0].accepted, true);
});

test('actual renderer retry clears its error banner before measuring the question panel', async () => {
  const r = await renderer();
  r.showError('The question panel moved. Use Capture question again.');
  assert.equal(r.element('error').hidden, false, 'precondition: prior capture error visible');
  await r.clickCapture();
  assert.equal(r.measurements.length, 1, 'one measurement from actual payload callback');
  assert.equal(r.measurements[0].bannerHidden, true, 'clear layout-changing error BEFORE measuring capture rect');
  assert.equal(r.captures.length, 1, 'retry should reach capture boundary exactly once');
  assert.equal(r.captures[0].payload.questionId, 'Q05');
  assert.equal(r.captures[0].accepted, true, 'submitted rectangle must match panel after banner clearing');
  assert.equal(r.element('error').hidden, true, 'successful retry must leave no stale error');
});
