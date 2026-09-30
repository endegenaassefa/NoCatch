'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const api = window.electronAPI;
  const $ = id => document.getElementById(id);
  $('materials-button')?.addEventListener('click',()=>api.showMaterials());
  api.onMaterialsInvalidated?.(()=>{epoch++;busy=null;clearPreview();answer=null;$('question').value='';$('answerText').textContent='';refresh();});
  let state, preview = null, answer = null, layout = null, busy = null;
  let epoch = 0, refreshId = 0, initialized = false, context = null;
  let preferredProvider = null;
  let saves = Promise.resolve(), saveError = null;
  const message = error => typeof error === 'string' ? error : error?.message || 'Something went wrong. Please try again.';
  const checked = result => {
    if (!result || result.success === false) throw new Error(message(result?.error));
    return result;
  };
  function status(text, error = false) { $('status').textContent = text; $('status').dataset.error = String(error); }
  function clearPreview() { preview = null; $('previewImage').removeAttribute('src'); $('consent').checked = false; }
  function save(patch = {}) {
    const saveEpoch = epoch;
    const progress = { draft: $('question').value, inputMode: $('inputMode').value, ...patch };
    saves = saves.then(() => api.saveSetupProgress(progress)).then(result => {
      checked(result); if (saveEpoch === epoch) saveError = null;
    }).catch(error => {
      if (saveEpoch !== epoch) return;
      saveError = error; status(`Could not save your progress: ${message(error)}`, true);
    });
    return saves;
  }
  const usable = () => state && (state.aiMode === 'direct' || state.managed?.authenticated);
  function controls() {
    const locked = Boolean(busy);
    for (const id of ['inputMode', 'question', 'provider', 'consent', 'sample', 'display', 'capture', 'refreshDisplays', 'screenSettings', 'discard', 'recapture']) $(id).disabled = locked;
    const screenshot = $('inputMode').value === 'screenshot';
    $('capture').disabled = locked || !$('display').value;
    $('submit').disabled = locked || !usable() || !$('question').value.trim() || !$('consent').checked || !$('provider').value || (screenshot && (!preview || ($('provider').value !== 'gemini')));
    $('submit').textContent = busy === 'submit' ? 'Getting your answer…' : 'Ask question';
    $('cancelWork').hidden = !['submit', 'capture', 'displays'].includes(busy);
    $('cancelWork').textContent = busy === 'submit' ? 'Cancel request' : 'Cancel capture';
    $('settings').disabled = locked;
    $('finish').disabled = locked;
    $('wizard').setAttribute('aria-busy', String(locked || !initialized));
  }
  function render(focus = false) {
    if (!state) return;
    const managed = state.managed || {};
    const signing = busy === 'auth' || managed.signingIn;
    const ready = usable() && !signing;
    $('accountPanel').hidden = ready;
    $('questionPanel').hidden = !ready || Boolean(answer);
    $('successPanel').hidden = !ready || !answer;
    $('stepLabel').textContent = answer && ready ? 'Step 3 of 3' : ready ? 'Step 2 of 3' : 'Step 1 of 3';
    $('heading').textContent = answer && ready ? 'You’re ready' : ready ? 'Ask your first question' : 'Connect your account';
    $('intro').hidden = ready;
    $('accountText').textContent = !managed.configured ? 'Managed service is not configured in this build. A configured release is needed to sign in. No account details or provider keys can fix this here.' : signing ? 'Finish signing in in your browser, then return here. You can cancel at any time.' : 'Sign in with your OpenCluely account in your browser to continue.';
    $('sessionNote').textContent = '';
    $('signIn').hidden = !managed.configured || signing;
    $('signIn').disabled = Boolean(busy);
    $('cancelAuth').hidden = !signing;
    $('cancelAuth').disabled = busy === 'cancel';
    $('recheck').disabled = Boolean(busy);
    $('identity').textContent = state.aiMode === 'direct' ? 'Using your provider settings' : managed.persistence === 'session_only' ? 'Signed in for this session' : 'Signed in';
    $('capturePanel').hidden = $('inputMode').value !== 'screenshot';
    $('previewPanel').hidden = !preview;
    $('consentText').textContent = `Send this question${preview ? ' and the screenshot preview' : ''} to ${state.aiMode === 'direct' ? 'the selected AI provider' : 'the managed service and selected AI provider'}.`;
    $('providerNote').hidden = $('inputMode').value !== 'screenshot';
    $('providerNote').textContent = 'Screenshot questions require Gemini.';
    const capability = state.capabilities?.screen;
    $('screenStatus').textContent = capability ? `Screen access: ${capability.permission}. ${capability.reason || ''}` : 'Screen access will be checked when you capture.';
    controls();
    if (focus) $('heading').focus();
  }
  function providers() {
    const previous = $('provider').value;
    const allowed = state.aiMode === 'direct' ? ['gemini', 'deepseek'] : state.managed?.account?.providers || [];
    $('provider').replaceChildren();
    for (const id of ['gemini', 'deepseek'].filter(id => allowed.includes(id))) $('provider').add(new Option(id === 'gemini' ? 'Gemini' : 'DeepSeek', id));
    if (!allowed.length) $('provider').add(new Option('No provider available for this account', ''));
    if (allowed.includes(previous)) $('provider').value = previous;
    else if (allowed.includes(preferredProvider)) $('provider').value = preferredProvider;
  }
  async function refresh(initial = false) {
    const id = ++refreshId, currentEpoch = epoch;
    try {
      let next = checked(await api.getSetupState());
      if (id !== refreshId || currentEpoch !== epoch) return;
      const nextContext = JSON.stringify([next.aiMode, next.managed?.configured, next.managed?.authenticated, next.managed?.account?.subject]);
      if (context && nextContext !== context && busy !== 'auth') {
        epoch++; busy = null; clearPreview(); answer = null;
        status('Your account or AI mode changed. Review your question before continuing.');
      }
      context = nextContext;
      if (initial) {
        if (next.busy || next.hasPreview) { checked(await api.cancelSetup()); next = checked(await api.getSetupState()); }
        if (next.aiMode === 'direct') {
          try {
            const setup = checked(await api.getFirstRunStatus());
            preferredProvider = ['gemini', 'deepseek'].includes(setup.llmProvider) ? setup.llmProvider : null;
            if (preferredProvider === 'gemini' && !setup.geminiConfigured && setup.deepseekConfigured) preferredProvider = 'deepseek';
            if (preferredProvider === 'deepseek' && !setup.deepseekConfigured && setup.geminiConfigured) preferredProvider = 'gemini';
          } catch (_) { /* The provider selector remains usable. */ }
        }
        if (id !== refreshId || currentEpoch !== epoch) return;
        state = next;
        $('question').value = next.draft || '';
        $('inputMode').value = next.inputMode || 'text';
        status(next.inputMode === 'screenshot' ? 'Draft restored. Capture a new preview.' : ['question', 'answer', 'success'].includes(next.step) ? 'Draft restored. Send when you’re ready.' : '');
        initialized = true;
      } else {
        state = next;
        if (preview && !next.hasPreview) { clearPreview(); status('The preview expired or was invalidated. Capture a new preview.'); }
      }
      providers(); render(initial);
      if (initial && usable() && $('inputMode').value === 'screenshot') await displays();
    } catch (error) { status(message(error), true); $('recheck').disabled = false; $('accountPanel').hidden = false; $('signIn').hidden = true; }
  }
  async function run(kind, action) {
    if (busy) return;
    busy = kind; const token = ++epoch; refreshId++; render();
    try { await action(() => token === epoch); }
    catch (error) { if (token === epoch) status(message(error), true); }
    finally { if (token === epoch) { busy = null; render(); } }
  }
  async function displays() {
    return run('displays', async current => {
      const result = checked(await api.listDisplays());
      if (!current()) return;
      layout = result;
      const previous = $('display').value;
      $('display').replaceChildren(new Option('Choose a display', ''));
      for (const display of result.displays) $('display').add(new Option(`${display.label || 'Display ' + display.id} · ${display.bounds.width} × ${display.bounds.height}`, String(display.id)));
      if (result.displays.some(display => String(display.id) === previous)) $('display').value = previous;
    });
  }
  async function capture() {
    const display = layout?.displays.find(item => String(item.id) === $('display').value);
    if (!display) { status('Choose a display first.', true); return; }
    return run('capture', async current => {
      clearPreview(); render(); status('Capturing the selected display…');
      await save({ step: 'capture' }); if (!current() || saveError) return;
      const result = checked(await api.captureSetupPreview({ displayId: display.id, layoutRevision: layout.layoutRevision,
        area: { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }, areaCoordinateSpace: 'display-dip' }));
      if (!current()) return;
      preview = result; $('previewImage').src = result.dataUrl;
      await save({ step: 'preview' }); if (!current() || saveError) return;
      status('Review your preview. Nothing has been sent yet.');
    });
  }
  $('signIn').addEventListener('click', () => run('auth', async current => {
    status('Waiting for sign-in in your browser…');
    await save({ step: 'account' }); if (!current() || saveError) return;
    checked(await api.signIn()); if (!current()) return;
    busy = null; await refresh(); status('Signed in. Ask your first question.'); $('heading').focus();
  }));
  async function cancel(auth = false) {
    const wasSubmitting = busy === 'submit';
    epoch++; refreshId++; busy = 'cancel'; clearPreview(); answer = null; render();
    try {
      checked(await (auth ? api.signOut() : api.cancelSetup()));
      busy = null; await refresh();
      status(auth ? 'Sign-in cancelled. You can try again.' : wasSubmitting ? 'Cancelled. Accepted requests may still count toward your allowance.' : 'Cancelled. No question was sent by this action.');
    } catch (error) { status(`Cancellation could not be confirmed: ${message(error)}`, true); }
    finally { busy = null; render(); $('heading').focus(); }
  }
  $('cancelAuth').addEventListener('click', () => cancel(true));
  $('cancelWork').addEventListener('click', () => cancel());
  $('recheck').addEventListener('click', () => refresh(!initialized));
  $('inputMode').addEventListener('change', async () => {
    const token = epoch;
    clearPreview(); status(''); await save({ step: 'question' });
    if (token !== epoch || saveError) return;
    render();
    if ($('inputMode').value === 'screenshot') await displays();
  });
  $('question').addEventListener('input', () => { $('consent').checked = false; save({ step: 'question' }); controls(); });
  $('sample').addEventListener('click', async () => {
    const token = epoch;
    clearPreview(); $('inputMode').value = 'text'; $('question').value = 'Explain the difference between a list and a set with a simple example.';
    await save({ step: 'question' }); if (token !== epoch || saveError) return;
    render(); $('question').focus();
  });
  $('provider').addEventListener('change', () => { $('consent').checked = false; controls(); });
  $('consent').addEventListener('change', controls);
  $('display').addEventListener('change', () => { clearPreview(); render(); });
  $('refreshDisplays').addEventListener('click', () => { clearPreview(); render(); displays(); });
  $('capture').addEventListener('click', capture);
  $('recapture').addEventListener('click', capture);
  $('discard').addEventListener('click', async () => {
    await cancel(); const token = epoch;
    await save({ step: 'question' }); if (token !== epoch || saveError) return;
    status('Preview discarded.'); $('capture').focus();
  });
  $('screenSettings').addEventListener('click', () => run('settings', async () => { checked(await api.openPermissionSettings('screen')); status('Return here after changing screen access, then capture again.'); }));
  $('submit').addEventListener('click', () => {
    if ($('submit').disabled) return;
    run('submit', async current => {
      status('Waiting for an answer… You can cancel this request.');
      await save({ step: 'question' }); if (!current() || saveError) return;
      const input = { text: $('question').value, provider: $('provider').value, consent: $('consent').checked };
      if ($('inputMode').value === 'screenshot' && preview) input.previewId = preview.id;
      const result = checked(await api.submitSetupQuestion(input)); if (!current()) return;
      if (!result.text?.trim()) throw new Error('No answer was returned. You can explicitly try again.');
      window.MaterialSourceLinks?.render(result);
      answer = result.text;
      $('answerText').textContent = answer;
      $('readiness').textContent = input.previewId ? 'This screenshot question succeeded. Microphone access has not been tested.' : 'Your text question succeeded. Screen capture and microphone access have not been tested.';
      clearPreview(); await save({ step: 'success' }); if (!current() || saveError) return;
      status('Answer received. You can finish setup.'); render(); $('answerHeading').focus();
    });
  });
  $('finish').addEventListener('click', () => run('finish', async () => { checked(await api.completeFirstRun()); checked(await api.closeOnboarding()); }));
  $('later').addEventListener('click', async () => {
    if (busy === 'close') return;
    epoch++; refreshId++; busy = 'close'; render();
    try { await saves; checked(await api.closeOnboarding()); }
    catch (error) { status(message(error), true); busy = null; render(); }
  });
  $('minimize').addEventListener('click', async () => {
    try { checked(await api.minimizeOnboarding()); }
    catch (error) { status(message(error), true); }
  });
  $('quit').addEventListener('click', async () => {
    if (busy === 'close') return;
    epoch++; refreshId++; busy = 'close'; render();
    try {
      await saves;
      checked(await api.cancelSetup());
      api.quit();
    } catch (error) { status(message(error), true); busy = null; render(); }
  });
  $('settings').addEventListener('click', () => run('settings', async () => { await saves; checked(await api.showSettings()); }));
  const onFocus = () => { if (initialized && !['cancel', 'close'].includes(busy)) refresh(); };
  window.addEventListener('focus', onFocus);
  const unsubscribe = api?.onManagedStatus?.(() => { if (initialized && !['auth', 'cancel', 'close'].includes(busy)) refresh(); });
  window.addEventListener('beforeunload', () => { epoch++; unsubscribe?.(); window.removeEventListener('focus', onFocus); });
  document.addEventListener('focusin', event => { if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) window.api?.send('input-target-focused'); });
  if (api) refresh(true); else { status('The desktop connection is unavailable. Reopen setup from the app.', true); $('wizard').setAttribute('aria-busy', 'false'); }
});
