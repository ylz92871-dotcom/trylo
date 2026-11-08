/* Production adapter for the approved v9 timeline; no workspace screenshots. */
(function () {
  'use strict';
  window.TryloStartupSequence = function (screen, complete, playbackStarted = () => {}) {
    const get = id => document.getElementById(id);
    const position = get('trylo-startup-position'), turn = get('trylo-startup-turn');
    const canvas = get('trylo-startup-material'), fallback = get('trylo-startup-fallback');
    const veil = get('trylo-startup-veil'), signature = get('trylo-startup-signature');
    const flat = get('trylo-startup-flat'), tile = get('trylo-startup-tile');
    if (!position || !turn || !canvas || !veil || !signature || !flat || !tile || !fallback) throw new Error('Startup composition incomplete');
    const clamp = n => Math.max(0, Math.min(1, n));
    const mix = (a, b, t) => a + (b - a) * t;
    const span = (t, a, b) => clamp((t - a) / (b - a));
    const smooth = n => { const x = clamp(n); return x * x * (3 - 2 * x); };
    const ease = n => { const x = clamp(n); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
    const easeOut = n => 1 - Math.pow(1 - clamp(n), 3);
    const words = [
      { id: 'trylo-dream-lead', start: 170, end: 490, exit: 1210 },
      { id: 'trylo-dream-key', start: 370, end: 690, exit: 1235 },
      { id: 'trylo-best-lead', start: 290, end: 610, exit: 1250 },
      { id: 'trylo-best-key', start: 510, end: 830, exit: 1275 },
    ];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false, appReady = false, time = 0, previous = null, frame = null, renderer = null, deadlineArmed = false;
    let width = 1280, height = 720;
    let imageLoaded = false, contourLoaded = false, transferred = false, cachedTarget = null;
    const image = new Image(), contourImage = new Image();
    screen.dataset.motion = 'approved';
    position.style.left = '0'; position.style.top = '0';
    position.style.width = position.style.height = '400px';
    position.style.willChange = 'transform'; turn.style.willChange = 'transform,filter,opacity';
    function targetRect() {
      if (cachedTarget) return cachedTarget;
      const target = document.querySelector('[data-startup-logo] .trilo-mark--chip');
      const rect = target?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      const style = getComputedStyle(target);
      flat.style.color = style.getPropertyValue('--logo-chip-ink').trim() || style.color;
      tile.style.background = style.backgroundColor;
      tile.style.borderRadius = style.borderRadius;
      cachedTarget = rect;
      return rect;
    }
    function draw() {
      const ratio = width / 1280, target = appReady ? targetRect() : null;
      const spin = ease(span(time, 1340, 2230)), shrink = ease(span(time, 1390, 2240));
      const travel = target ? ease(span(time, 1760, 2290)) : 0;
      const small = target ? target.width * 43 / 40 : 43 * ratio;
      const size = mix(400 * ratio, small, shrink);
      const cx = mix(width * .5, target ? target.left + target.width / 2 : width * .5, travel);
      const cy = mix(height * .425, target ? target.top + target.height / 2 : height * .425, travel) - Math.sin(travel * Math.PI) * height * .038;
      const blur = 4.4 * Math.sin(Math.PI * span(time, 1400, 2290)) * ratio;
      const flatten = smooth(span(time, 2070, 2330)), landed = smooth(span(time, 2330, 2430));
      position.style.transform = `translate3d(${cx - 200}px,${cy - 200}px,0) scale(${size / 400})`;
      turn.style.transform = `rotate(${spin * 360}deg)`;
      turn.style.filter = `blur(${blur / (size / 400)}px)`;
      turn.style.opacity = String(easeOut(span(time, 0, 260)) * (1 - flatten));
      veil.style.opacity = String(1 - smooth(span(time, 1760, 2340)));
      signature.style.top = `${height * .425 + 175 * ratio}px`;
      for (const word of words) {
        const el = get(word.id), enter = easeOut(span(time, word.start, word.end));
        const exit = smooth(span(time, word.exit, word.exit + 190));
        if (!el) continue;
        el.style.opacity = String(smooth(span(time, word.start, word.start + 180)) * (1 - exit));
        el.style.transform = `translate3d(0,${(1 - enter) * 1.25 - exit * .9}em,0)`;
        el.style.filter = `blur(${((1 - enter) * 1.5 + exit * .65) * ratio}px)`;
      }
      const svgSize = target ? target.width * 77 / 40 : 77 * ratio;
      flat.style.width = `${svgSize}px`; flat.style.height = `${svgSize}px`;
      flat.style.transform = `translate3d(${cx - svgSize / 2}px,${cy - svgSize / 2}px,0) scale(${size / small}) rotate(${spin * 360}deg)`;
      flat.style.opacity = target ? String(flatten * (1 - landed)) : '0';
      flat.style.filter = `blur(${blur * .5}px)`;
      tile.style.width = target ? `${target.width}px` : '40px';
      tile.style.transform = target ? `translate3d(${target.left}px,${target.top}px,0)` : '';
      tile.style.opacity = target ? String(flatten * (1 - landed)) : '0';
      if (target && time >= 1760 && time < 2430) document.documentElement.dataset.startupHandoff = 'true';
      else delete document.documentElement.dataset.startupHandoff;
      if (renderer && time < 2340) renderer.draw(mix(-.1, 1.55, span(time, 160, 1170)), time >= 160 && time <= 1170 ? 1 : 0);
    }
    function stopFrame() { if (frame !== null) cancelAnimationFrame(frame); frame = null; previous = null; }
    function schedule() { if (!disposed && !document.hidden && !reduced.matches && frame === null) frame = requestAnimationFrame(tick); }
    function tick(now) {
      frame = null;
      if (disposed || document.hidden) { previous = null; return; }
      if (previous !== null) time = Math.min(appReady ? 2480 : 1170, time + Math.max(0, now - previous));
      previous = now;
      try { draw(); } catch (_) { dispose(); if (appReady) complete(); return; }
      if (time >= 2480) { complete(); return; }
      if (!appReady && time >= 1170) { previous = null; return; }
      schedule();
    }
    function resize() {
      width = screen.clientWidth || window.innerWidth || 1280;
      height = screen.clientHeight || window.innerHeight || 720;
      cachedTarget = null;
      screen.style.setProperty('--startup-unit', String(width / 1280) + 'px');
      const resolution = Math.max(320, Math.min(1000, Math.round(400 * width / 1280 * Math.min(window.devicePixelRatio || 1, 2))));
      if (renderer?.resize) renderer.resize(resolution, resolution);
      else if (!transferred && (canvas.width !== resolution || canvas.height !== resolution)) { canvas.width = resolution; canvas.height = resolution; }
      if (!disposed) draw();
    }
    function visibility() {
      stopFrame();
      if (appReady && document.hidden) complete(); else schedule();
    }
    function motionChanged() { if (reduced.matches) { stopFrame(); if (appReady) complete(); } }
    function contextLost(event) {
      event.preventDefault(); renderer?.dispose(); renderer = null;
      canvas.style.opacity = '0'; fallback.hidden = false; schedule();
    }
    function dispose() {
      if (disposed) return;
      disposed = true; stopFrame(); image.onload = image.onerror = contourImage.onload = contourImage.onerror = null;
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', motionChanged);
      canvas.removeEventListener('webglcontextlost', contextLost);
      delete document.documentElement.dataset.startupHandoff;
      renderer?.dispose(); renderer = null;
      if (!transferred) canvas.width = canvas.height = 1;
      canvas.style.opacity = '0'; fallback.hidden = false;
      position.style.willChange = turn.style.willChange = 'auto';
    }
    function prepareMaterial() {
      if (disposed || time >= 1170 || !imageLoaded || !contourLoaded) return;
      try {
        renderer = window.TryloStartupMaterial(canvas, image, contourImage, () => {
          if (disposed || time >= 1170) return;
          canvas.style.opacity = '1'; fallback.hidden = true;
        }, () => { canvas.style.opacity = '0'; fallback.hidden = false; });
        transferred = renderer.transferred === true;
      } catch (_) { fallback.hidden = false; }
      resize(); schedule();
    }
    image.onload = () => { imageLoaded = true; prepareMaterial(); };
    contourImage.onload = () => { contourLoaded = true; prepareMaterial(); };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', motionChanged);
    canvas.addEventListener('webglcontextlost', contextLost);
    resize(); schedule();
    image.src = '/startup/approved-facet.png'; contourImage.src = '/startup/approved-contour.png';
    return {
      ready() {
        if (appReady || disposed) return;
        appReady = true;
        if (document.hidden || reduced.matches) { complete(); return; }
        // Preserve the current original timeline; readiness must not jump past
        // the words, add another revolution or cut the shrink/defocus short.
        if (!deadlineArmed) { deadlineArmed = true; playbackStarted(2480 - time); }
        previous = null; schedule();
      },
      dispose,
    };
  };
})();
