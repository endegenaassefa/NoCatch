/**
 * sanitize.js — strip dangerous constructs from rendered markdown HTML.
 *
 * LLM answers are rendered as HTML via innerHTML in the chat and answer
 * panels. In root exam mode those renderers run unsandboxed as root, so an
 * LLM response containing markup must never be able to execute code. This is
 * a defense-in-depth scrub, not a sandbox: it removes the obvious execution
 * vehicles (script/iframe/object/embed/svg-math, event-handler attributes,
 * javascript: URLs) while keeping the formatting the UI relies on.
 */
(function () {
  function sanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;

    // 1. Drop outright dangerous elements.
    ['script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base', 'form', 'input', 'button'].forEach(function (tag) {
      doc.body.querySelectorAll(tag).forEach(function (el) { el.remove(); });
    });

    // 2. Strip event-handler attributes and javascript: URLs everywhere.
    doc.body.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
        var name = (attr.name || '').toLowerCase();
        var value = (attr.value || '');
        if (/^on/i.test(name)) {
          el.removeAttribute(attr.name);
          return;
        }
        if (/^(src|href|xlink:href|action|formaction|poster|background)$/i.test(name) &&
            /^\s*javascript:/i.test(value.trim())) {
          el.removeAttribute(attr.name);
        }
      });
    });

    return doc.body.innerHTML;
  }

  if (typeof window !== 'undefined') {
    window.sanitizeHtml = sanitizeHtml;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sanitizeHtml };
  }
})();
