'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const api = window.electronAPI;
  const $ = id => document.getElementById(id);
  let settings, busy = null, epoch = 0, refreshId = 0, disposed = false;
  const message = error => typeof error === 'string' ? error : error?.message || 'Please try again.';
  const checked = result => {
    if (!result || result.success === false) throw new Error(message(result?.error));
    return result;
  };
  const status = text => { $('accountMessage').textContent = text; };
  function render() {
    const managed = settings?.managed || {};
    const signing = busy === 'auth' || managed.signingIn;
    $('managedAccountStatus').textContent = settings?.aiMode === 'direct'
      ? 'Using your own provider keys. Change providers in AI connection.'
      : !managed.configured ? 'Online sign-in is not configured in this build. Install a configured release to use your OpenCluely account.'
      : signing ? 'Finish signing in in your browser, then return here.'
      : managed.authenticated ? `Signed in${managed.persistence === 'session_only' ? ' for this session only. Sign in again after restarting.' : '. Sign-in is saved securely on this device.'}`
      : 'Sign in to use managed AI.';
    $('accountSignIn').hidden = Boolean(!managed.configured || managed.authenticated || signing || settings?.aiMode === 'direct');
    $('accountSignIn').disabled = Boolean(busy || !managed.configured);
    $('accountSignOut').hidden = !managed.authenticated && !signing;
    $('accountSignOut').textContent = signing ? 'Cancel sign-in' : 'Sign out';
    $('accountSignOut').disabled = Boolean(busy && busy !== 'auth');
    $('aiMode').disabled = Boolean(busy || !settings);
    $('resumeSetup').disabled = Boolean(busy);
    $('accountRecheck').disabled = Boolean(busy);
  }
  async function refresh() {
    const id = ++refreshId, token = epoch;
    try {
      const next = checked(await api.getSettings());
      if (disposed || id !== refreshId || token !== epoch) return;
      settings = { aiMode: next.aiMode, managed: next.managed };
      $('aiMode').value = next.aiMode || 'managed';
      render();
    } catch (error) { if (!disposed && id === refreshId && token === epoch) status(message(error)); }
  }
  async function action(kind, work, success) {
    if (busy && kind !== 'signout') return;
    const token = ++epoch;
    busy = kind; status(''); render();
    try {
      checked(await work());
      if (disposed || token !== epoch) return;
      if (success) status(success);
    } catch (error) { if (!disposed && token === epoch) status(message(error)); }
    finally {
      if (!disposed && token === epoch) { busy = null; await refresh(); render(); }
    }
  }
  $('accountRecheck').addEventListener('click', () => { if (!busy) { status(''); refresh(); } });
  $('accountSignIn').addEventListener('click', () => action('auth', () => api.signIn(), 'Signed in.'));
  $('accountSignOut').addEventListener('click', () => action('signout', () => api.signOut(), 'Signed out.'));
  $('resumeSetup').addEventListener('click', () => action('setup', () => api.showOnboarding()));
  $('aiMode').addEventListener('change', () => {
    const aiMode = $('aiMode').value;
    action('mode', () => api.saveSettings({ aiMode }), 'AI connection saved.');
  });
  const onFocus = () => { if (!busy) refresh(); };
  window.addEventListener('focus', onFocus);
  const unsubscribe = api?.onManagedStatus?.(() => { if (!busy) refresh(); });
  window.addEventListener('beforeunload', () => { disposed = true; epoch++; refreshId++; unsubscribe?.(); window.removeEventListener('focus', onFocus); });
  if (api) refresh(); else status('The desktop connection is unavailable. Reopen Settings.');
});
