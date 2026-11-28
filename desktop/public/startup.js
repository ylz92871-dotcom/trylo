/* Intentionally dependency-free: runs before the application module graph. */
(function () {
  'use strict';
  var screen = document.getElementById('trylo-startup');
  var status = document.getElementById('trylo-startup-status');
  var reload = document.getElementById('trylo-startup-reload');
  var root = document.getElementById('root');
  if (!screen || !status || !reload || !root) return;

  // Match appearance-store.ts: macOS defaults to 'system', others default to 'light', with restricted-storage fallback.
  var isMac = /mac/i.test(navigator.platform || '') || /macintosh|mac os x/i.test(navigator.userAgent || '');
  var defaultPreference = isMac ? 'system' : 'light';
  var preference = defaultPreference;
  try {
    var saved = localStorage.getItem('trylo.appearance.v1');
    if (saved === 'light' || saved === 'dark' || saved === 'system') preference = saved;
  } catch (_) { /* Session fallback. */ }
  var dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  root.inert = true;

  var leaving = false;
  var failed = false;
  var removed = false;
  var sequence;
  var removalTimer;
  var slowTimer = window.setTimeout(function () {
    if (leaving || failed) return;
    status.textContent = '启动比平时久一些，你可以继续等待或重新加载。';
    screen.dataset.slow = 'true';
    reload.hidden = false;
  }, 30000);

  function retry() { window.location.reload(); }
  function update(event) {
    if (!leaving && !failed && typeof event.detail === 'string') status.textContent = event.detail;
  }
  function fail(event) {
    // Resource errors on images etc. must not turn startup into an application failure.
    if (event.type === 'error' && !(event instanceof ErrorEvent) && event.target?.tagName !== 'SCRIPT') return;
    if (leaving) return;
    failed = true;
    sequence?.dispose();
    window.clearTimeout(slowTimer);
    screen.dataset.phase = 'failed';
    status.textContent = 'Trylo 启动未能完成，请重新加载后重试。';
    reload.hidden = false;
  }
  function remove() {
    if (removed) return;
    removed = true;
    window.clearTimeout(slowTimer);
    window.clearTimeout(removalTimer);
    sequence?.dispose();
    window.removeEventListener('trylo:startup-stage', update);
    window.removeEventListener('trylo:startup-ready', finish);
    window.removeEventListener('trylo:startup-dismiss', dismiss);
    window.removeEventListener('error', fail, true);
    window.removeEventListener('keydown', skip, true);
    window.removeEventListener('pagehide', remove);
    root.inert = false;
    screen.removeEventListener('pointerdown', accelerateOnPointer);
    screen.removeEventListener('animationend', onExit);
    reload.removeEventListener('click', retry);
    screen.remove();
  }
  function accelerateOnPointer() {
    if (leaving && !removed && screen.dataset.interactive !== 'true') sequence?.accelerate?.();
  }
  function skip(event) { if (leaving && event.key === 'Escape') remove(); }
  function playbackStarted(remainingMs) {
    if (!leaving || removed) return;
    window.clearTimeout(removalTimer);
    removalTimer = window.setTimeout(remove, remainingMs + 200);
  }
  function dismiss() { remove(); }
  function onExit(event) {
    if (event.target === screen && event.animationName === 'startup-exit') remove();
  }
  function finish() {
    if (leaving) return;
    leaving = true;
    window.clearTimeout(slowTimer);
    window.removeEventListener('trylo:startup-stage', update);
    window.removeEventListener('trylo:startup-ready', finish);
    window.removeEventListener('error', fail, true);
    root.inert = false;
    screen.setAttribute('aria-hidden', 'true');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { remove(); return; }
    screen.dataset.phase = 'leaving';
    if (sequence) {
      // Real readiness releases interaction immediately. Brand presentation
      // runs over the live app; pointer input gently accelerates the dive,
      // while Escape skips immediately.
      window.addEventListener('keydown', skip, true);
      screen.addEventListener('pointerdown', accelerateOnPointer);
      // Guard against dropped animation frames beyond the 2.48s dive sequence.
      removalTimer = window.setTimeout(remove, 2750);
      sequence.ready();
      return;
    }
    screen.addEventListener('animationend', onExit);
    // Still remove if animationend is lost or styles failed to load.
    removalTimer = window.setTimeout(remove, 240);
  }
  reload.addEventListener('click', retry);
  window.addEventListener('trylo:startup-stage', update);
  window.addEventListener('trylo:startup-ready', finish);
  window.addEventListener('trylo:startup-dismiss', dismiss);
  window.addEventListener('error', fail, true);
  window.addEventListener('pagehide', remove);
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof window.TryloStartupSequence === 'function') {
    try { sequence = window.TryloStartupSequence(screen, remove, playbackStarted); }
    catch (_) { screen.dataset.motion = 'fallback'; }
  }
})();
