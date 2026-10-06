'use strict';

(() => {
  const api = window.electronAPI;
  if (!api) return;
  const byId = id => document.getElementById(id);
  const menu = document.querySelector('.chat-menu');
  const setup = byId('panelSetup');
  const movement = byId('panelMovementKeys');
  const display = byId('panelDisplay');
  const status = byId('panelStatus');
  let current = null;
  let dirty = false;
  let revisions = 0;

  function fill(select, entries, value) {
    const signature = JSON.stringify(entries);
    if (select.dataset.options !== signature) {
      const previous = select.value;
      select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
      select.dataset.options = signature;
      if (dirty && entries.some(([value]) => String(value) === previous)) select.value = previous;
    }
    if (!dirty) select.value = String(value ?? '');
  }

  function apply(state) {
    current = state;
    window.ChatLayout.supported = Boolean(state.supported);
    if (!state.supported) return;
    setup.hidden = false;
    document.documentElement.classList.toggle('exam-layout', state.enabled);
    document.documentElement.classList.toggle('panel-too-small', state.tooSmall);
    byId('chatModeLabel').textContent = 'Chat';
    byId('chatExamBtn').textContent = state.enabled ? 'Return to normal layout' : 'Use Exam layout';
    byId('chatExamBtn').title = state.enabled ? 'Restore dragging and resizing' : 'Lock dragging and move with keyboard shortcuts';
    byId('chatExamBtn').classList.toggle('active', state.enabled);
    byId('examModeBanner').style.display = 'none';
    const hint = byId('panelMovementHint');
    hint.hidden = true;
    hint.textContent = `Drag locked · ${state.modifier}+arrows`;
    hint.title = `${state.modifier}+← ↑ ↓ → to move · Ctrl+Shift+V to hide or show`;
    hint.classList.toggle('movement-unavailable', state.movement !== 'ready');
    const error = state.enabled ? state.error || (state.movement === 'starting' ? 'Preparing keyboard movement…' : '') : '';
    status.textContent = error || (state.saveError ? 'Position could not be saved. Your chat is still available.' : '');
    status.hidden = !status.textContent;
    fill(movement, (state.modifiers || []).map(key => [key, `${key}+arrows`]), state.modifier);
    fill(display, (state.displays || []).map(item => [item.id, item.label]), state.displayId ?? state.displays?.[0]?.id);
  }

  async function configure(extra = {}) {
    byId('panelSetupStatus').textContent = 'Saving…';
    try {
      const result = await api.configureExamLayout({ modifier: movement.value, displayId: Number(display.value), ...extra });
      if (!result.success) throw new Error(result.error);
      dirty = false;
      apply(result.state);
      byId('panelSetupStatus').textContent = result.state.error || (result.state.movement === 'ready' ? 'Movement is ready.' : 'Saved. Movement is available in Exam layout.');
    } catch (error) { byId('panelSetupStatus').textContent = error.message; }
  }

  window.ChatLayout = {
    supported: false, apply,
    async toggle() {
      byId('chatExamBtn').disabled = true;
      try {
        const result = await api.setExamLayout(!current?.enabled);
        if (!result.success) throw new Error(result.error);
        apply(result.state);
      } catch (error) { status.textContent = error.message; status.hidden = false; }
      finally { byId('chatExamBtn').disabled = false; }
    }
  };
  byId('collapseChatButton')?.addEventListener('click', () => api.closeWindow());
  movement.addEventListener('change', () => { dirty = true; });
  display.addEventListener('change', () => { dirty = true; });
  byId('savePanelSetup').addEventListener('click', () => configure());
  byId('resetPanelPosition').addEventListener('click', () => configure({ resetPosition: true }));
  api.onExamLayoutChanged?.(state => { revisions++; apply(state); });
  const revision = revisions;
  api.getExamLayout?.().then(state => { if (revision === revisions) apply(state); }).catch(() => {
    if (api.initialExamLayout) {
      status.textContent = 'Panel controls unavailable. Reopen the app after your session.';
      status.hidden = false;
    }
  });
  api.onChatPanelHidden?.(() => {
    menu.open = false;
    setup.open = false;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  });

  const language = byId('chatLanguageSelect');
  let languageChanged = false;
  api.getSettings?.().then(settings => { if (!languageChanged && settings.codingLanguage) language.value = settings.codingLanguage; }).catch(() => {});
  api.onCodingLanguageChanged?.((_event, data) => { languageChanged = true; if (data?.language) language.value = data.language; });
  language.addEventListener('change', async () => {
    languageChanged = true;
    try {
      const result = await api.saveSettings({ codingLanguage: language.value });
      if (result?.success === false) throw new Error(result.error || 'Could not save code language.');
    } catch (error) { status.textContent = error.message; status.hidden = false; }
  });
})();
