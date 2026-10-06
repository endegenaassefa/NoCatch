'use strict';
(() => {
  const api = window.electronAPI;
  if (!api) return;
  const chat = document.getElementById('chatMessages');
  const entries = new Map();
  let scope = null, resolved = false, statusEvents = 0, previewEpoch = 0, previewOwner = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'material-source-dialog';
  dialog.setAttribute('aria-label', 'Source preview');
  const heading = document.createElement('h2');
  const text = document.createElement('pre');
  const images = document.createElement('div');
  const body = document.createElement('div');
  body.className = 'material-source-body';
  body.tabIndex = 0;
  body.setAttribute('aria-label', 'Source content');
  const close = document.createElement('button');
  close.textContent = 'Close source preview';
  close.onclick = () => closePreview();
  body.append(images, text);
  dialog.append(heading, body, close);
  document.body.append(dialog);

  function closePreview() {
    previewEpoch++;
    previewOwner = null;
    dialog.close();
    heading.textContent = '';
    text.textContent = '';
    images.replaceChildren();
  }
  dialog.addEventListener('close', () => {
    // A queued close event from an earlier preview must not clear a reopened one.
    if (dialog.open) return;
    previewEpoch++;
    previewOwner = null;
    text.textContent = '';
    images.replaceChildren();
  });
  const current = marker => marker && Number.isFinite(marker.expiresAt) && Date.now() < marker.expiresAt &&
    (!resolved || (scope && scope.sessionId === marker.sessionId && scope.generation === marker.generation && Date.now() < scope.expiresAt));

  function removeEntry(owner) {
    const entry = entries.get(owner);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (previewOwner === owner) closePreview();
    entry.host.remove();
    for (const button of owner.querySelectorAll('.source-reference')) {
      const label = document.createElement('span');
      label.textContent = button.textContent;
      label.title = 'Source no longer available';
      button.replaceWith(label);
    }
    entries.delete(owner);
  }
  function clear() {
    for (const owner of entries.keys()) removeEntry(owner);
    closePreview();
  }
  function prune() {
    for (const [owner, entry] of entries) {
      if (!owner.isConnected || !current(entry.marker)) removeEntry(owner);
    }
  }
  function status(next) {
    statusEvents++;
    resolved = true;
    scope = next?.state === 'active' ? { sessionId: next.id, generation: next.generation, expiresAt: next.expiresAt } : null;
    prune();
    for (const [owner, entry] of entries) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => removeEntry(owner), Math.max(1, Math.min(entry.marker.expiresAt, scope.expiresAt) - Date.now()));
    }
  }
  api.onMaterialsStatus?.(status);
  const initialEvents = statusEvents;
  api.getMaterialsStatus?.().then(reply => {
    if (statusEvents === initialEvents) status(reply.status || reply);
  }).catch(() => { if (statusEvents === initialEvents) status(null); });

  const sourceLabel = source => `${source.name} · ${source.kind} ${source.page}`;
  async function preview(owner, source) {
    const entry = entries.get(owner);
    if (!entry || !current(entry.marker) || !owner.isConnected) return;
    const epoch = ++previewEpoch;
    previewOwner = owner;
    heading.textContent = sourceLabel(source);
    images.replaceChildren();
    text.textContent = 'Loading source…';
    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;
    const valid = () => epoch === previewEpoch && dialog.open && entries.get(owner) === entry &&
      owner.isConnected && current(entry.marker);
    try {
      const result = await api.previewMaterial(source.documentId, source.page);
      if (!valid()) return;
      if (result.success === false || !result.preview) {
        text.textContent = result.error?.message || 'This source is unavailable. Close the preview and try again.';
        return;
      }
      text.textContent = [result.preview.text, result.preview.notes && `Speaker notes\n${result.preview.notes}`].filter(Boolean).join('\n\n') || 'No text is available for this page.';
      for (const image of result.preview.images || []) {
        if (!['image/png', 'image/jpeg'].includes(image.mimeType) || typeof image.data !== 'string') continue;
        const img = document.createElement('img');
        img.alt = image.kind === 'page-render' ? 'Original PDF page' : 'Embedded slide image; full layout unavailable';
        img.style.cssText = 'display:block;max-width:100%;height:auto;margin:12px auto';
        img.src = `data:${image.mimeType};base64,${image.data}`;
        images.append(img);
      }
    } catch {
      if (valid()) text.textContent = 'This source is unavailable. Close the preview and try again.';
    }
  }

  function cite(owner, sources) {
    const target = owner.querySelector('.message-text') || owner.querySelector('#full-markdown') || owner;
    const byId = new Map(sources.map((source, index) => [source.id, { source, index: index + 1 }]));
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent.includes('[') || node.parentElement.closest('pre,code,a,.math,.source-reference,.material-source-links')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    for (let node; (node = walker.nextNode());) nodes.push(node);
    for (const node of nodes) {
      const value = node.textContent;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of value.matchAll(/\[([^\]\n]{1,250})\]/g)) {
        const ids = match[1].split(/[,;\s]+/).filter(Boolean);
        // Arrays, option labels and arbitrary bracketed prose are not citations.
        if (!ids.length || !ids.every(id => byId.has(id) || /^[^\s:]+:(?:page|slide):\d+$/i.test(id) || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) continue;
        fragment.append(document.createTextNode(value.slice(last, match.index)));
        ids.forEach((id, index) => {
          if (index) fragment.append(document.createTextNode(' '));
          const item = byId.get(id);
          if (!item) {
            const unknown = document.createElement('span');
            unknown.className = 'source-unverified';
            unknown.textContent = `[${id}] (unverified)`;
            unknown.title = `Citation not provided in this answer's sources: ${id}`;
            fragment.append(unknown);
            return;
          }
          const button = document.createElement('button');
          button.className = 'source-reference';
          button.textContent = `[${item.index}]`;
          button.title = sourceLabel(item.source);
          button.setAttribute('aria-label', `Source ${item.index}: ${sourceLabel(item.source)}`);
          button.onclick = () => preview(owner, item.source);
          fragment.append(button);
        });
        last = match.index + match[0].length;
      }
      if (last) {
        fragment.append(document.createTextNode(value.slice(last)));
        node.replaceWith(fragment);
      }
    }
  }

  function render(data, owner) {
    // Chat's controller alone decides which final events are accepted.
    if (!owner) {
      if (chat) return;
      owner = document.querySelector('.full-content-inner') || document.getElementById('answerText')?.parentElement;
    }
    if (!owner?.isConnected) return;
    prune();
    removeEntry(owner);
    const metadata = data?.metadata || {};
    const marker = data?.materialSession || metadata.materialSession;
    if (!current(marker)) return;
    const sources = (data.sources || metadata.sources || []).filter(source =>
      typeof source.id === 'string' && typeof source.documentId === 'string' && typeof source.name === 'string' &&
      ['page', 'slide'].includes(source.kind) && Number.isInteger(source.page) && source.page > 0);
    const materialStatus = data.materialStatus || metadata.materialStatus;
    const defaults = {
      failed: 'General knowledge — materials are unavailable.',
      'no-match': 'General knowledge — no matching evidence found in the prepared material.',
      partial: 'Using available material; some pages or visual content may be missing.'
    };
    let notice = data.materialNotice || metadata.materialNotice || defaults[materialStatus] || '';
    if (materialStatus === 'available' || notice === 'Using session materials.') {
      const extra = notice.replace(/^Using session materials\.\s*/, '');
      notice = [sources.length ? '' : 'No material sources cited.', extra].filter(Boolean).join(' ');
    }
    const host = document.createElement('section');
    host.className = 'material-source-links';
    host.setAttribute('aria-label', 'Answer sources');
    if (notice) {
      const label = document.createElement('span');
      label.className = 'source-notice';
      label.textContent = notice;
      host.append(label);
    }
    if (sources.length) {
      const list = document.createElement('div');
      list.className = 'source-list';
      sources.forEach((source, index) => {
        const button = document.createElement('button');
        button.textContent = `${index + 1}. ${sourceLabel(source)}`;
        button.onclick = () => preview(owner, source);
        list.append(button);
      });
      host.append(list);
    }
    if (host.childNodes.length) owner.insertBefore(host, owner.querySelector(':scope > .message-time'));
    const timer = setTimeout(() => removeEntry(owner), Math.max(1, Math.min(marker.expiresAt, scope?.expiresAt ?? marker.expiresAt) - Date.now()));
    entries.set(owner, { host, marker, timer });
    cite(owner, sources);
  }

  api.onMaterialsInvalidated?.(() => {
    resolved = true;
    scope = null;
    clear();
    for (const id of ['full-markdown', 'markdown-content', 'code-content', 'answerText']) {
      const element = document.getElementById(id);
      if (element) element.textContent = '';
    }
  });
  window.addEventListener('pagehide', clear, { once: true });
  if (chat) new MutationObserver(prune).observe(chat, { childList: true });
  window.MaterialSourceLinks = { render, clear };
})();
