'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const MiB = 1024 * 1024;
  let decks = [], deadline = null, view = 'prepare', skipped = false;
  const names = ['Transactions and isolation', 'Database design', 'Query planning', 'Indexes and storage', 'Concurrency control', 'Recovery and logging', 'Distributed databases', 'Data modeling', 'Replication', 'Review notes'];
  const sample = i => ({ id: `sample-${i}`, name: `${names[i]}.pptx`, bytes: (8 + i) * MiB, slides: 60, state: 'ready', text: 'Snapshot isolation uses a consistent snapshot. Concurrent writes to the same record may produce a write conflict. Check the stated isolation level.', kind: 'sample', warning: null });
  const ready = () => decks.filter(d => ['ready', 'partial'].includes(d.state));
  const remaining = () => deadline === null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  function modal(title, paragraphs) {
    const content = $('detailContent'); content.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = title; content.append(heading);
    for (const text of paragraphs) { const p = document.createElement('p'); p.textContent = text; content.append(p); }
    if (!$('detail').open) $('detail').showModal();
  }
  function expire(reason = 'The 90 minute window has ended.') {
    decks = []; deadline = null; skipped = false; view = 'expired'; $('draft').value = ''; $('consent').checked = false; $('expiryReason').textContent = reason;
    $('sampleAnswer').textContent = ''; $('detailContent').replaceChildren(); if ($('detail').open) $('detail').close(); render();
  }
  function checkDeadline() { if (deadline !== null && Date.now() >= deadline) { expire(); return false; } return true; }
  function render() {
    $('prepare').hidden = view !== 'prepare'; $('active').hidden = view !== 'active'; $('expired').hidden = view !== 'expired';
    $('materialsNav').hidden = deadline === null; $('step').textContent = deadline ? 'Session in progress' : view === 'expired' ? 'Session ended' : 'Prepare your session';
    $('empty').hidden = decks.length > 0; $('capacity').textContent = `${decks.length} of 10 files · ${Math.round(decks.reduce((n, d) => n + d.bytes, 0) / MiB)} MiB`;
    $('deckList').replaceChildren();
    for (const deck of decks) {
      const li = document.createElement('li'); li.className = 'deck';
      const badge = document.createElement('span'); badge.className = 'deckbadge'; badge.textContent = deck.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'PPTX';
      const info = document.createElement('div'); const name = document.createElement('strong'); name.className = 'deckname'; name.textContent = deck.name; info.append(name);
      const meta = document.createElement('div'); meta.className = 'deckmeta';
      meta.textContent = deck.kind === 'selection' ? `${(deck.bytes / MiB).toFixed(1)} MiB · Preview only; content not read` : `${deck.slides} slides · ${(deck.bytes / MiB).toFixed(1)} MiB · ${deck.state === 'failed' ? 'Import failed' : deck.state === 'partial' ? 'Partially read' : 'Ready (sample)'}`; info.append(meta);
      if (deck.warning) { const warning = document.createElement('p'); warning.className = deck.state === 'failed' ? 'deckerror' : 'deckwarning'; warning.textContent = deck.warning; info.append(warning); }
      const actions = document.createElement('div'); actions.className = 'actions';
      if (deck.kind === 'sample' && deck.state !== 'failed') { const preview = document.createElement('button'); preview.className = 'quiet'; preview.textContent = 'Preview'; preview.addEventListener('click', () => { if (checkDeadline()) modal(`${deck.name} — sample slide 18`, [deck.text, deck.warning || 'Slide text and speaker notes were read in this sample scenario.']); }); actions.append(preview); }
      if (deck.state === 'failed') { const retry = document.createElement('button'); retry.className = 'quiet'; retry.textContent = 'Try again'; retry.addEventListener('click', () => modal('Choose a corrected file', ['This sample deck is unreadable. In the proposed app, retry reselects or downloads a corrected file. It does not make a damaged file ready.'])); actions.append(retry); }
      const remove = document.createElement('button'); remove.className = 'quiet'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${deck.name}`); remove.addEventListener('click', () => { if (!checkDeadline()) return; decks = decks.filter(d => d !== deck); $('status').textContent = 'Material removed. The session deadline stays the same.'; render(); }); actions.append(remove);
      li.append(badge, info, actions); $('deckList').append(li);
    }
    const usable = ready().length;
    $('consent').disabled = false;
    $('start').disabled = (!usable && decks.length > 0) || (usable > 0 && !$('consent').checked);
    $('start').textContent = deadline ? 'Return to session' : 'Start 90 minute session'; $('skip').hidden = deadline !== null;
    const seconds = remaining(); $('clock').textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    $('activeSummary').textContent = usable ? `${usable} material${usable === 1 ? '' : 's'} available until the original deadline.` : 'No uploaded materials are included.';
    $('activeState').textContent = usable ? `${usable} ready · ${decks.filter(d => d.state === 'failed').length} failed` : 'General assistance';
    const strict = $('policy').value === 'strict';
    const supported = ready().some(d => d.id === 'sample-0');
    $('sampleAnswer').textContent = view !== 'active' ? '' : supported ? 'The sample material describes snapshot isolation: conflicting writes may cause one transaction to fail. The outcome depends on the stated isolation level. [Transactions and isolation, slide 18]' : strict ? 'I cannot answer this question from the available sample materials. Add the relevant slide or more information.' : 'General knowledge: databases handle concurrent writes according to their isolation level, often by locking, detecting a conflict, or retrying a transaction.';
    $('source').hidden = view !== 'active' || !supported;
  }
  function add(files) {
    if (!checkDeadline()) return;
    for (const file of files) {
      if (decks.length >= 10) { $('status').textContent = '10 file limit reached. Remove a file before adding another.'; break; }
      if (!/\.(pptx|pdf)$/i.test(file.name)) { $('status').textContent = `${file.name}: use .pptx or .pdf. Save older .ppt files as .pptx first.`; continue; }
      if (!file.size || file.size > 50 * MiB) { $('status').textContent = `${file.name}: choose a nonempty file no larger than 50 MiB.`; continue; }
      if (decks.reduce((n, d) => n + d.bytes, 0) + file.size > 250 * MiB) { $('status').textContent = '250 MiB total limit reached. Remove a file or upload a smaller copy.'; continue; }
      if (decks.some(d => d.name === file.name && d.bytes === file.size)) { $('status').textContent = 'Possible duplicate skipped in this preview. The finished app must compare file contents, not just names.'; continue; }
      decks.push({ id: `selected-${Date.now()}-${decks.length}`, name: file.name, bytes: file.size, state: 'preview', kind: 'selection', warning: 'Content extraction is not implemented in this prototype. This file will not be used for answers.' });
    }
    render();
  }
  function reset() { decks = []; deadline = null; view = 'prepare'; skipped = false; $('consent').checked = false; $('status').textContent = ''; $('draft').value = ''; $('detailContent').replaceChildren(); if ($('detail').open) $('detail').close(); }
  $('choose').addEventListener('click', () => $('files').click());
  $('files').addEventListener('change', event => { add(Array.from(event.target.files)); event.target.value = ''; });
  $('google').addEventListener('click', () => modal('Upload a Google Slides copy', ['Open the presentation in Google Slides. Choose File → Download → Microsoft PowerPoint (.pptx) or PDF.', 'Return here and choose the downloaded file. For the first release, Google Slides copies use the same upload flow as other PowerPoint and PDF files.', 'This prototype previews names and sizes only. Direct Google account selection is a later integration.']));
  $('dropzone').addEventListener('dragover', e => { e.preventDefault(); $('dropzone').classList.add('drag'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('drag'));
  $('dropzone').addEventListener('drop', e => { e.preventDefault(); $('dropzone').classList.remove('drag'); add(Array.from(e.dataTransfer.files)); });
  $('consent').addEventListener('change', render);
  $('start').addEventListener('click', () => { if (!checkDeadline()) return; if ($('start').disabled) return; if (deadline === null) deadline = Date.now() + 90 * 60 * 1000; view = 'active'; render(); });
  $('skip').addEventListener('click', () => { decks = []; skipped = true; deadline = Date.now() + 90 * 60 * 1000; view = 'active'; $('consent').checked = false; render(); });
  for (const id of ['manage', 'materialsNav']) $(id).addEventListener('click', () => { if (checkDeadline()) { view = 'prepare'; render(); } });
  $('end').addEventListener('click', () => expire('You ended the session early.'));
  $('newSession').addEventListener('click', () => { reset(); render(); });
  $('source').addEventListener('click', () => { if (!checkDeadline()) return; const deck = ready().find(d => d.id === 'sample-0'); if (!deck) return; modal('Sample source: Transactions and isolation, slide 18', [deck.text, 'The finished app must show the actual retrieved slide and distinguish speaker notes from visible slide text.']); });
  $('ask').addEventListener('click', () => { if (!checkDeadline()) return; modal('Illustrative answer policy', [$('policy').value === 'strict' ? 'If the answer is missing from the materials, say so and request the relevant slide or information.' : 'Use material citations for supported claims. Label an answer from general knowledge when the uploaded material does not support it.', 'This control demonstrates wording. No question is sent to an AI provider.']); });
  $('policy').addEventListener('change', render);
  document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => {
    const scenario = button.dataset.scenario;
    if (scenario === 'reset') reset();
    else if (scenario === 'five' || scenario === 'ten') { reset(); decks = Array.from({ length: scenario === 'five' ? 5 : 10 }, (_, i) => sample(i)); }
    else if (scenario === 'partial') { reset(); decks = [sample(0), { ...sample(1), state: 'partial', warning: '42 of 60 slides read. 18 diagram or image slides need visual processing. Only extracted text is available.' }]; }
    else if (scenario === 'failed') { reset(); decks = [sample(0), { ...sample(1), state: 'failed', warning: 'This presentation could not be read. Open it in PowerPoint and save a new .pptx copy, or upload a PDF.' }]; }
    else if (scenario === 'duplicate') { if (!checkDeadline()) return; if (!decks.length) decks = [sample(0)]; $('status').textContent = 'Duplicate sample deck skipped. The finished app compares a content hash before accepting it.'; }
    else if (scenario === 'overlimit') { if (!checkDeadline()) return; decks = Array.from({ length: 10 }, (_, i) => sample(i)); $('status').textContent = 'An eleventh deck was rejected. Remove an existing deck first.'; }
    else if (scenario === 'resume') { reset(); decks = Array.from({ length: 5 }, (_, i) => sample(i)); deadline = Date.now() + 23 * 60 * 1000; view = 'active'; $('consent').checked = true; }
    else if (scenario === 'expire') { expire(); return; }
    render();
  }));
  setInterval(() => { if (deadline !== null && checkDeadline()) { const seconds = remaining(); $('clock').textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; } }, 1000);
  document.addEventListener('visibilitychange', checkDeadline);
  render();
})();
