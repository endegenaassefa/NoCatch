'use strict';
const $ = id => document.getElementById(id);
let state, renderedRun, renderedQuestion, reviewGeneration, reviewLoaded, navigationKey, liveKey, rendering = false;
const api = window.playground;
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
function error(message) { $('error').hidden = !message; $('error').textContent = message || ''; }
async function call(action, payload) {
  const result = await api.invoke(action, payload);
  if (!result.success) throw new Error(result.error);
  return result.value;
}
async function act(action, payload) {
  error('');
  try { const result = await call(action, typeof payload === 'function' ? payload() : payload); if (result?.phase) render(result); return result; }
  catch (problem) { error(problem.message); }
}
function bind(id, action, payload) { $(id).addEventListener('click', () => act(action, payload)); }
function dialog(id, open) { const d = $(id); if (open && !d.open) d.showModal(); else if (!open && d.open) d.close(); }
function time() {
  const seconds = state?.expiresAt ? Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000)) : 5400;
  $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}
function sourceLabel(source) { return `${source.name || source.filename || source.documentId || 'Source'} · ${source.kind || 'page'} ${source.page || source.slide || '?'}`; }
function showSources(container, sources, preview = false) {
  for (const source of sources || []) {
    const div = node('div', undefined, 'evidence'); div.append(node('h3', sourceLabel(source)), node('p', source.text || source.excerpt || '', 'answer-text'));
    if (source.id) div.append(node('p', `Citation: ${source.id}`));
    if (preview && source.documentId && source.page) {
      const button = node('button', 'Open source', 'secondary'); button.addEventListener('click', async () => {
        const generation = state.generation;
        const result = await act('preview', { documentId: source.documentId, page: source.page });
        if (!result || state.generation !== generation) return;
        $('source-content').replaceChildren(node('h3', `${result.name} · ${result.kind || 'page'} ${result.page}`), node('p', result.text || '', 'answer-text'), node('p', result.notes ? `Speaker notes: ${result.notes}` : '', 'answer-text'));
        for (const image of result.images || []) addImage($('source-content'), image);
        dialog('source-dialog', true);
      }); div.append(button);
    }
    container.append(div);
  }
}
function addImage(container, image) {
  if (!image || !['image/png','image/jpeg','image/webp'].includes(image.mimeType) || typeof image.data !== 'string') return;
  const img = node('img'); img.alt = 'Actual captured question or source image'; img.src = `data:${image.mimeType};base64,${image.data}`; container.append(img);
}
function showRecord(container, record, review = false) {
  const div = node('div', undefined, 'evidence'); div.append(node('h3', record.kind));
  if (review) addImage(div, record.image);
  if (record.imageNotice) div.append(node('p', record.imageNotice));
  if (record.transcription) div.append(node('h3', 'Screenshot transcription'), node('p', record.transcription, 'answer-text'));
  div.append(node('p', `${record.materialStatus || 'Pending'}${record.strategy ? ` · ${record.strategy}` : ''}${record.materialNotice ? ` · ${record.materialNotice}` : ''}`));
  if (record.text) div.append(node('p', record.text, 'answer-text'));
  if (record.error) div.append(node('p', record.error));
  if (review) {
    div.append(node('h3', 'Selected evidence')); showSources(div, record.retrievedSources, true);
    div.append(node('h3', 'Returned citation coordinates')); showSources(div, record.sources);
    div.append(node('pre', (record.stages || []).map(s => `${s.event}: ${s.elapsedMs} ms`).join('\n')));
  } else if (record.kind.startsWith('Local text')) showSources(div, record.retrievedSources);
  container.append(div);
}
async function loadReview() {
  const generation = state.generation;
  if (reviewGeneration === generation) return;
  reviewGeneration = generation; $('review-content').replaceChildren(node('p', 'Loading the answer key and run evidence…'));
  try {
    const review = await call('review');
    if (state.generation !== generation || !['completed','exited'].includes(state.phase)) return;
    reviewLoaded = review; $('review-content').replaceChildren();
    for (const [index, question] of state.questions.entries()) {
      const item = node('section', undefined, 'review-question'), expected = review.oracle.questions.find(q => q.id === question.id);
      item.append(node('h2', `${index + 1}. ${question.title}`), node('p', question.text), node('h3', 'Your answer'), node('p', state.answers[question.id] || 'No answer entered.', 'answer-text'));
      const records = review.records.filter(r => r.questionId === question.id);
      if (!records.length) item.append(node('p', 'No NoCatch request recorded for this question.'));
      for (const record of records) showRecord(item, record, true);
      if (expected) { item.append(node('h3', 'Expected answer'), node('p', expected.expected, 'answer-text'), node('h3', 'Independent rubric')); const list = node('ul'); for (const text of expected.rubric || []) list.append(node('li', text)); item.append(list); showSources(item, expected.sources); }
      $('review-content').append(item);
    }
  } catch (problem) { error(problem.message); }
}
function render(next) {
  if (rendering) return; rendering = true;
  try {
    state = next; time();
    if (renderedRun !== state.runId) { renderedRun = state.runId; $('exit-reason').value = ''; }
    const running = state.phase === 'running', reviewing = ['completed','exited'].includes(state.phase), paused = state.focusAcknowledgementRequired || state.exitConfirmationRequired;
    $('setup').hidden = state.phase !== 'idle'; $('exam').hidden = !running || paused; $('review').hidden = !reviewing; $('expired').hidden = state.phase !== 'expired';
    if (!reviewing) { reviewLoaded = null; reviewGeneration = null; $('review-content').replaceChildren(); $('source-content').replaceChildren(); dialog('source-dialog', false); }
    const material = state.materials || {}, prep = material.preparation || {};
    $('material-status').textContent = `Materials: ${material.state || 'idle'} · ${(material.documents || []).length} files · Preparation: ${prep.state || 'idle'}${prep.strategy ? ` · ${prep.strategy}` : ''}${prep.phase ? ` · ${prep.phase}` : ''}${prep.total ? ` · ${prep.completed}/${prep.total}` : ''}${material.error ? ` · ${material.error}` : ''}`;
    $('course-path').textContent = state.courseFolder || 'No course folder exported yet.';
    $('open-course').disabled = !state.courseFolder;
    $('recovery-status').textContent = state.recoveryRegistered ? 'Emergency recovery: Ctrl+Shift+Alt+Escape is registered. The on-screen Emergency exit is also available.' : 'The emergency shortcut could not be registered. Use Emergency exit or Windows recovery controls.';
    $('event-log').textContent = (state.events || []).map(e => `${e.at}  ${e.message}`).join('\n') || 'No events recorded.';
    if (running) {
      $('mode-notice').textContent = state.mode === 'restriction' ? 'Restriction run · Native capture protection requested. OS task switching pauses this exam. NoCatch answers are disabled; this run measures restrictions only.' : 'Diagnostic run · NoCatch may capture this question and use the selected materials. Capture question can use paid model calls; Inspect retrieval is local and free.';
      const question = state.questions[state.questionIndex];
      if (renderedQuestion !== `${state.runId}:${question.id}`) {
        renderedQuestion = `${state.runId}:${question.id}`;
        $('question-panel').dataset.questionId = question.id;
        $('question-number').textContent = `Question ${state.questionIndex + 1} of ${state.questions.length}`;
        $('question-title').textContent = question.title; $('question-text').textContent = question.text;
        $('choices').replaceChildren(...(question.choices || []).map(choice => node('li', choice)));
        $('student-answer').value = state.answers[question.id] || ''; $('save-status').textContent = '';
      }
      const nextNavigationKey = `${state.runId}:${state.questionIndex}:${state.busy}`;
      if (navigationKey !== nextNavigationKey) {
      navigationKey = nextNavigationKey;
      $('question-nav').replaceChildren(...state.questions.map((q, index) => { const button = node('button', String(index + 1), 'secondary'); button.setAttribute('aria-label', `Question ${index + 1}: ${q.title}`); button.setAttribute('aria-current', String(index === state.questionIndex)); button.disabled = state.busy; button.addEventListener('click', () => act('question', { index })); return button; }));
      }
      $('diagnostic-actions').hidden = state.mode !== 'diagnostic';
      $('capture-question').disabled = state.busy; $('inspect-retrieval').disabled = state.busy || !state.materialSession;
      $('finish').disabled = false; $('student-answer').disabled = state.busy;
      $('request-status').textContent = state.busy ? 'NoCatch is working. Question navigation is held until the request completes; Exit cancels it.' : '';
      const latest = (state.records || []).filter(r => r.questionId === question.id).at(-1);
      const nextLiveKey = JSON.stringify(latest || null);
      if (liveKey !== nextLiveKey) { liveKey = nextLiveKey; $('live-result').replaceChildren(); if (latest) showRecord($('live-result'), latest); }
    } else { renderedQuestion = null; navigationKey = null; liveKey = null; $('student-answer').value = ''; $('live-result').replaceChildren(); }
    dialog('focus-dialog', running && state.focusAcknowledgementRequired && !state.exitConfirmationRequired);
    dialog('exit-dialog', running && state.exitConfirmationRequired);
    if (reviewing) loadReview();
    // Acknowledge only after removing all review/oracle DOM. Main keeps capture protection until this point.
    if (running && state.mode === 'diagnostic') api.invoke('rendered', { generation: state.generation }).catch(() => {});
  } finally { rendering = false; }
}
bind('export-course','exportCourse'); bind('open-course','openCourse'); bind('materials','materials'); bind('settings','settings');
bind('start','start', () => ({ mode: document.querySelector('[name=mode]:checked').value, context: document.querySelector('[name=context]:checked').value, consent: $('consent').checked }));
bind('exit','exit');
for (const id of ['emergency','emergency-focus','emergency-exit','emergency-close','emergency-source']) $(id).addEventListener('click', () => {
  reviewLoaded = null; reviewGeneration = null; $('review-content').replaceChildren(); $('source-content').replaceChildren(); $('live-result').replaceChildren();
  for (const modal of document.querySelectorAll('dialog')) if (modal.open) modal.close();
  act('emergency');
}); bind('finish','finish'); bind('focus-exit','exit'); bind('acknowledge-focus','acknowledge');
bind('confirm-exit','confirmExit', () => ({ reason: $('exit-reason').value })); bind('cancel-exit','cancelExit');
for (const id of ['clear-setup','clear-review','clear-expired']) bind(id,'clear');
for (const id of ['quit-setup','quit-review']) $(id).addEventListener('click', () => dialog('close-dialog', true));
bind('confirm-close','quit'); $('cancel-close').addEventListener('click', () => dialog('close-dialog', false));
$('close-source').addEventListener('click', () => { dialog('source-dialog', false); $('source-content').replaceChildren(); });
bind('inspect-retrieval','retrieve');
bind('capture-question','capture', () => { const rect = $('question-panel').getBoundingClientRect(); return { questionId: state.questions[state.questionIndex].id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }; });
$('student-answer').addEventListener('input', async () => {
  const questionId = state.questions[state.questionIndex].id, text = $('student-answer').value;
  try { await call('answer', { questionId, text }); if (state.phase === 'running' && state.questions[state.questionIndex].id === questionId) $('save-status').textContent = 'Saved in this run.'; }
  catch (problem) { error(problem.message); }
});
for (const name of ['copy','cut','paste','contextmenu']) document.addEventListener(name, event => { event.preventDefault(); api.invoke('event', { name }).catch(() => {}); });
for (const d of document.querySelectorAll('dialog')) d.addEventListener('cancel', event => { event.preventDefault(); if (d.id === 'source-dialog') { d.close(); $('source-content').replaceChildren(); } else act('exit'); });
api.onState(render); api.onError(error); api.onExit(() => dialog('close-dialog', true));
setInterval(time, 250);
act('state');
