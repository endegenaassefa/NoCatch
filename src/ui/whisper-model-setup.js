document.addEventListener('DOMContentLoaded', () => {
  const api = window.electronAPI;
  const panel = document.getElementById('whisperModelSetup');
  if (!panel || !api?.getWhisperModelStatus) return;
  const modelInput = document.getElementById('whisperModel');
  const provider = document.getElementById('speechProvider');
  const command = document.getElementById('whisperCommand');
  const device = document.getElementById('whisperDevice');
  const status = document.getElementById('whisperModelStatus');
  const size = document.getElementById('whisperModelSize');
  const progress = document.getElementById('whisperModelProgress');
  const prepare = document.getElementById('prepareWhisperModelButton');
  const cancel = document.getElementById('cancelWhisperModelButton');
  const busyStates = new Set(['checking', 'downloading', 'verifying', 'validating', 'cancelling']);
  let state = null;
  let epoch = 0;
  let closed = false;
  const selected = () => modelInput.value.trim() || 'small';
  const mib = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

  function render(snapshot) {
    if (closed || !snapshot || snapshot.model !== selected()) return;
    state = snapshot;
    const busy = busyStates.has(snapshot.state);
    panel.dataset.busy = String(busy);
    for (const input of [modelInput, command, device]) input.disabled = busy || provider.value !== 'whisper';
    provider.disabled = busy;
    size.textContent = snapshot.totalBytes ? `Model download: ${mib(snapshot.totalBytes)}` : '';
    const messages = {
      missing: 'Prepare this model before recording.',
      checking: 'Checking the saved model…',
      downloading: `Downloading ${mib(snapshot.receivedBytes || 0)} of ${mib(snapshot.totalBytes || 0)}…`,
      verifying: 'Verifying the download…',
      validating: 'Checking that the speech engine can load this model…',
      ready: 'Ready for local voice.',
      cancelling: 'Cancelling… Waiting for cleanup.',
      cancelled: 'Preparation cancelled. You can retry.',
      error: snapshot.error || snapshot.message || 'Preparation failed. Please retry.',
      unsupported: snapshot.message
    };
    status.textContent = messages[snapshot.state] || snapshot.message || 'Checking voice setup…';
    progress.hidden = !busy;
    if (snapshot.state === 'downloading') {
      progress.max = snapshot.totalBytes || 1;
      progress.value = snapshot.receivedBytes || 0;
    } else progress.removeAttribute('value');
    prepare.hidden = snapshot.supported === false;
    prepare.disabled = busy || snapshot.state === 'ready' || provider.value !== 'whisper';
    prepare.textContent = ['error', 'cancelled'].includes(snapshot.state) ? 'Retry' : snapshot.state === 'ready' ? 'Model ready' : 'Prepare model';
    cancel.hidden = !busy;
    cancel.disabled = !snapshot.operationId || snapshot.state === 'cancelling';
  }

  async function refresh() {
    const generation = ++epoch;
    const model = selected();
    state = null;
    render({ model, state: 'checking', supported: true });
    try {
      const snapshot = await api.getWhisperModelStatus(model);
      if (generation === epoch) render(snapshot);
    } catch (error) {
      if (generation === epoch) render({ model, state: 'error', error: error.message, supported: true });
    }
  }

  prepare.addEventListener('click', async () => {
    const generation = ++epoch;
    const model = selected();
    render({ model, state: 'checking', supported: true });
    try {
      // Persist the selected model before preparing it, including typed values
      // whose earlier blur save has not yet acknowledged completion.
      const saved = await api.saveSettings({ whisperModel: model });
      if (saved?.success === false) throw new Error(saved.error || 'Could not save the selected model.');
      const snapshot = await api.prepareWhisperModel(model);
      if (generation === epoch) render(snapshot);
    } catch (error) {
      if (generation === epoch) render({ model, state: 'error', error: error.message, supported: true });
    }
  });

  cancel.addEventListener('click', async () => {
    if (!state?.operationId) return;
    const operationId = state.operationId;
    const generation = ++epoch;
    render({ ...state, state: 'cancelling' });
    try {
      const snapshot = await api.cancelWhisperModel(operationId);
      if (generation === epoch && snapshot) render(snapshot);
    } catch (error) {
      if (generation === epoch) status.textContent = `Could not finish cancellation: ${error.message}`;
    }
  });

  const unsubscribe = api.onWhisperModelStatus(snapshot => {
    if (snapshot.model !== selected()) return;
    // A completed older operation cannot overwrite a newer operation's state.
    if (state?.operationId && snapshot.operationId && state.operationId !== snapshot.operationId &&
        !['checking', 'downloading'].includes(snapshot.state)) return;
    render(snapshot);
  });
  for (const input of [modelInput, command, device, provider]) input.addEventListener('change', refresh);
  // Settings can finish hydrating after the first model-status response.
  // Requery using the now-populated provider/model instead of stale defaults.
  document.addEventListener('settings-loaded', refresh);
  api.getSettings().then(settings => {
    if (closed) return;
    if (!modelInput.value && settings.whisperModel) modelInput.value = settings.whisperModel;
    refresh();
  }).catch(() => refresh());
  window.addEventListener('beforeunload', () => { closed = true; epoch++; unsubscribe(); }, { once: true });
});
