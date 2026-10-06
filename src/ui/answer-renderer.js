/* One renderer for streamed, completed and restored answers. Provider text stays
   in document order; only trusted application code adds interactive controls. */
(function () {
  'use strict';
  const allowed = new Set(['P', 'BR', 'HR', 'STRONG', 'EM', 'DEL', 'S', 'B', 'I',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
    'CODE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'A', 'SUP', 'SUB']);
  const discard = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG',
    'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEMPLATE', 'LINK', 'META', 'BASE', 'IMG',
    'VIDEO', 'AUDIO', 'SOURCE']);

  function copySafe(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    const fragment = document.createDocumentFragment();
    if (node.nodeType !== Node.ELEMENT_NODE || discard.has(node.tagName)) return fragment;
    const result = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : fragment;
    if (node.tagName === 'CODE') {
      const language = [...node.classList].find(value => /^language-[\w+-]{1,40}$/.test(value));
      if (language) result.className = language;
    }
    if (node.tagName === 'OL' && /^\d{1,6}$/.test(node.getAttribute('start') || '')) {
      result.setAttribute('start', node.getAttribute('start'));
    }
    if (node.tagName === 'A') {
      try {
        const url = new URL(node.getAttribute('href'));
        if (['https:', 'http:'].includes(url.protocol)) {
          result.href = url.href;
          result.target = '_blank';
          result.rel = 'noopener noreferrer';
        }
      } catch { /* An unsafe or incomplete link remains readable text. */ }
    }
    for (const child of node.childNodes) result.append(copySafe(child));
    return result;
  }

  function fragmentFor(text) {
    const result = document.createDocumentFragment();
    if (!window.marked?.parse) {
      const plain = document.createElement('div');
      plain.className = 'answer-plain-text';
      plain.textContent = text;
      result.append(plain);
      return result;
    }
    try {
      // Template contents are inert. No model-authored elements/attributes are
      // attached to the live document; copySafe builds a small allowlisted tree.
      const template = document.createElement('template');
      template.innerHTML = window.marked.parse(text, { gfm: true, breaks: false, async: false });
      for (const node of template.content.childNodes) result.append(copySafe(node));
    } catch {
      const plain = document.createElement('div');
      plain.className = 'answer-plain-text';
      plain.textContent = text;
      result.append(plain);
    }
    return result;
  }

  function pendingCitations(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent.includes('[') && !node.parentElement.closest('pre,code,a,.math')
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    for (let node; (node = walker.nextNode());) nodes.push(node);
    const citation = /^(?:[^\s:]+:(?:page|slide):\d+|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
    for (const node of nodes) {
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of node.textContent.matchAll(/\[([^\]\n]{1,250})\]/g)) {
        const ids = match[1].split(/[,;\s]+/).filter(Boolean);
        if (!ids.length || !ids.every(id => citation.test(id))) continue;
        fragment.append(document.createTextNode(node.textContent.slice(last, match.index)));
        const pending = document.createElement('span');
        pending.className = 'source-pending';
        pending.textContent = '[source pending]';
        pending.title = 'Source details arrive when the answer finishes.';
        fragment.append(pending);
        last = match.index + match[0].length;
      }
      if (last) {
        fragment.append(document.createTextNode(node.textContent.slice(last)));
        node.replaceWith(fragment);
      }
    }
  }

  function decorate(root, streaming, pendingSources) {
    // Existing lightweight math renderer is retained; it excludes code nodes.
    window.renderMathInElement?.(root);
    if (streaming && pendingSources) pendingCitations(root);
    for (const table of root.querySelectorAll('table')) {
      const scroll = document.createElement('div');
      scroll.className = 'answer-table';
      scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', 'Answer table');
      table.replaceWith(scroll);
      scroll.append(table);
    }
    for (const pre of root.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (!code) continue;
      const lang = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || 'text';
      pre.dataset.language = lang;
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', `${lang} code`);
      // No asynchronous autoloader can mutate a detached or replaced stream.
      // Known grammars highlight live; final rendering can load other grammars.
      if (window.Prism?.languages[lang]) {
        code.innerHTML = window.Prism.highlight(code.textContent, window.Prism.languages[lang], lang);
      }
    }
  }

  function render(target, text, { streaming = false, pendingSources = false } = {}) {
    if (!target) return;
    const draft = document.createElement('div');
    draft.append(fragmentFor(typeof text === 'string' ? text : ''));
    decorate(draft, streaming, pendingSources);
    target.classList.add('answer-content');
    target.setAttribute('aria-busy', String(streaming));
    // Keep unchanged blocks alive so reading/selection above the growing block
    // is stable. Finalization uses the same structure as streaming.
    const next = [...draft.childNodes];
    for (let i = 0; i < next.length; i++) {
      const current = target.childNodes[i];
      if (!current) target.append(next[i]);
      else if (!current.isEqualNode(next[i])) current.replaceWith(next[i]);
    }
    while (target.childNodes.length > next.length) target.lastChild.remove();
    if (!streaming && window.Prism?.highlightElement) {
      for (const code of target.querySelectorAll('pre code[class*="language-"]')) {
        const lang = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
        if (lang && !window.Prism.languages[lang]) window.Prism.highlightElement(code);
      }
    }
  }
  window.AnswerRenderer = { render };
})();
