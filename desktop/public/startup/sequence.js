/* Production choreography for the Cinematic 3D Levitation + Rapid Pull-Open Dissolve + Optical Stream Entry startup sequence. */
(function () {
  'use strict';
  window.TryloStartupSequence = function (screen, complete, playbackStarted = () => {}) {
    const get = id => document.getElementById(id);
    const stage = get('trylo-startup-stage');
    const shadow = get('trylo-startup-shadow');
    const position = get('trylo-startup-position'), turn = get('trylo-startup-turn');
    const canvas = get('trylo-startup-material'), fallback = get('trylo-startup-fallback');
    const veil = get('trylo-startup-veil'), signature = get('trylo-startup-signature');
    const opticsCanvas = get('trylo-startup-optics');
    if (!stage || !shadow || !position || !turn || !canvas || !fallback || !veil || !signature || !opticsCanvas) {
      throw new Error('Startup composition incomplete');
    }

    const HOLD_TIME = 1000;
    const TOTAL_TIME = 2380;

    const clamp = n => Math.max(0, Math.min(1, n));
    const mix = (a, b, t) => a + (b - a) * t;
    const span = (t, a, b) => clamp((t - a) / (b - a));
    const smooth = n => { const x = clamp(n); return x * x * (3 - 2 * x); };
    const easeOut = n => 1 - Math.pow(1 - clamp(n), 3);
    const easeOutBackSoft = n => {
      const u = clamp(n);
      const base = 1 - Math.pow(1 - u, 3);
      return base + Math.sin(u * Math.PI) * 0.042 * (1 - u);
    };
    // Punchy, strictly forward clockwise pull-open curve without any backwards hitch.
    const easePullOpen = n => Math.pow(clamp(n), 1.65);

    const words = [
      { id: 'trylo-learning-lead', start: 200, end: 500, exit: 1000 },
      { id: 'trylo-learning-key', start: 330, end: 640, exit: 1020 },
      { id: 'trylo-own-lead', start: 290, end: 590, exit: 1030 },
      { id: 'trylo-own-key', start: 440, end: 760, exit: 1050 },
    ];

    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false, appReady = false, time = 0, speed = 1, accelerated = false;
    let previous = null, frame = null, renderer = null, optics = null, deadlineArmed = false;
    let width = 1280, height = 720, ratio = 1;
    let imageLoaded = false, contourLoaded = false, transferred = false;
    const image = new Image(), contourImage = new Image();

    try { optics = window.TryloStartupOptics ? window.TryloStartupOptics(opticsCanvas) : null; }
    catch (_) { optics = null; }

    screen.dataset.motion = 'approved';
    position.style.left = '0';
    position.style.top = '0';
    position.style.width = position.style.height = '400px';
    shadow.style.left = '0';
    shadow.style.top = '0';
    shadow.style.width = '300px';
    shadow.style.height = '82px';
    position.style.willChange = 'transform';
    shadow.style.willChange = 'transform,opacity';
    turn.style.willChange = opticsCanvas.style.willChange = 'transform,opacity';

    function draw() {
      const dark = document.documentElement.dataset.theme === 'dark';

      // Act 1 (0-920ms): 3D physical detachment and levitation off the surface.
      const enterOpacity = easeOut(span(time, 0, 260));
      const liftProgress = easeOutBackSoft(span(time, 0, 920));
      const liftClamped = clamp(liftProgress);

      // Act 2 (1020-1760ms): continuous clockwise pull-open flying past camera while dissolving over 580ms.
      const pull = easePullOpen(span(time, 1020, 1760));
      const rotDeg = 120 * pull;

      const enterScale = mix(0.84, 1.03, liftProgress);
      const pullScale = Math.pow(11.5, pull);
      const totalScale = ratio * enterScale * pullScale;

      const zLift = mix(-90, 48, liftProgress) + mix(0, 560, pull);
      const pitchDeg = mix(16, 0, liftClamped);
      const yawDeg = mix(-9, 0, liftClamped);
      const emblemFade = Math.pow(1 - smooth(span(time, 1120, 1700)), 1.35);

      position.style.transform =
        `translate3d(${width * 0.5 - 200}px,${height * 0.425 - 200}px,${zLift.toFixed(2)}px) ` +
        `rotateX(${pitchDeg.toFixed(2)}deg) rotateY(${yawDeg.toFixed(2)}deg) scale(${totalScale.toFixed(4)})`;
      turn.style.transform = `rotate(${rotDeg.toFixed(2)}deg)`;
      turn.style.opacity = String(enterOpacity * emblemFade);

      // Grounded shadow separates downward, widens, and softens with elevation, then clears on launch.
      const shadowEnter = easeOut(span(time, 40, 340));
      const shadowLaunchFade = 1 - smooth(span(time, 1020, 1320));
      const shadowDropY = mix(92, 122, liftClamped) * ratio;
      const shadowSx = ratio * mix(0.68, 1.15, liftClamped);
      const shadowSy = ratio * mix(0.62, 1.02, liftClamped);
      const shadowAlpha = shadowEnter * shadowLaunchFade * mix(0.84, 0.5, liftClamped);

      shadow.style.transform =
        `translate3d(${width * 0.5 - 150}px,${height * 0.425 + shadowDropY - 41}px,0) scale(${shadowSx.toFixed(4)},${shadowSy.toFixed(4)})`;
      shadow.style.opacity = String(Math.max(0, Math.min(1, shadowAlpha)));

      for (const word of words) {
        const el = get(word.id);
        if (!el) continue;
        const enter = easeOut(span(time, word.start, word.end));
        const exit = smooth(span(time, word.exit, word.exit + 200));
        el.style.opacity = String(smooth(span(time, word.start, word.start + 180)) * (1 - exit));
        el.style.transform = `translate3d(0,${(1 - enter) * 1.15 - exit * 0.45}em,0) scale(${1 + exit * 0.08})`;
      }

      // Act 3 (1040-2340ms): curved 3D optical stream catches emblem momentum, parts open, and glides into workspace.
      if (optics) {
        const haloIn = easeOut(span(time, 180, 920));
        const haloLaunch = easeOut(span(time, 980, 1380));
        const haloOut = smooth(span(time, 1420, 2020));
        const haloAlpha = (haloIn * 0.40 + haloLaunch * 0.60) * (1 - haloOut);
        const haloScale = mix(0.68, 1.06, haloIn) * mix(1, 1.65, haloOut);

        const washAlpha = Math.sin(span(time, 1160, 1820) * Math.PI);
        const portalOpen = easeOut(span(time, 1400, 2260));

        const sweepGlint = Math.sin(span(time, 320, 840) * Math.PI);
        const launchGlint = Math.sin(span(time, 1080, 1620) * Math.PI);
        const flareAlpha = Math.max(sweepGlint * 0.56, launchGlint * 0.88) * (1 - smooth(span(time, 1660, 2020)));
        const flareSpan = Math.max(sweepGlint * 0.42, span(time, 1020, 1760));

        const streamPre = smooth(span(time, 960, 1140)) * 0.22;
        const streamSurge = smooth(span(time, 1040, 1380)) * 0.98;
        const streamOut = 1 - smooth(span(time, 1840, 2340));
        const streamAlpha = Math.max(streamPre, streamSurge) * streamOut;

        // C1-continuous forward glide: swift thrust during pull-open, silky coasting deceleration into the workspace.
        const streamTravel =
          Math.pow(span(time, 1020, 1760), 1.65) * 2.15 +
          easeOut(span(time, 1760, 2340)) * 1.15;
        const streamVelocity = smooth(span(time, 1040, 1400)) * (1 - 0.65 * smooth(span(time, 1820, 2340)));

        // Continue gentle optical swirl during coasting even after emblem completes 120deg spin.
        const streamRotDeg = rotDeg + easeOut(span(time, 1760, 2340)) * 28;

        optics.draw({
          dark,
          pull,
          streamTravel,
          streamVelocity,
          portalOpen,
          rotRad: (streamRotDeg * Math.PI) / 180,
          haloAlpha,
          haloScale,
          washAlpha,
          flareAlpha,
          flareSpan,
          streamAlpha,
        });
      }

      const veilOpacity = 1 - smooth(span(time, 1380, 1980));
      veil.style.opacity = String(veilOpacity);
      if (appReady && veilOpacity < 0.3) screen.dataset.interactive = 'true';
      else delete screen.dataset.interactive;

      if (appReady && time < 1380) document.documentElement.dataset.startupReveal = 'preparing';
      else if (appReady && time < TOTAL_TIME) document.documentElement.dataset.startupReveal = 'settling';
      else delete document.documentElement.dataset.startupReveal;

      if (renderer && time < 1800) {
        const scan = mix(-0.1, 1.55, span(time, 240, 920));
        const light = time >= 240 && time <= 940 ? 1 : 0;
        renderer.draw(scan, light);
      }
    }

    function stopFrame() { if (frame !== null) cancelAnimationFrame(frame); frame = null; previous = null; }
    function schedule() { if (!disposed && !document.hidden && !reduced.matches && frame === null) frame = requestAnimationFrame(tick); }
    function tick(now) {
      frame = null;
      if (disposed || document.hidden) { previous = null; return; }
      if (previous !== null) time = Math.min(appReady ? TOTAL_TIME : HOLD_TIME, time + Math.max(0, now - previous) * speed);
      previous = now;
      try { draw(); } catch (_) { dispose(); if (appReady) complete(); return; }
      if (time >= TOTAL_TIME) { complete(); return; }
      if (!appReady && time >= HOLD_TIME) { previous = null; return; }
      schedule();
    }

    function resize() {
      width = screen.clientWidth || window.innerWidth || 1280;
      height = screen.clientHeight || window.innerHeight || 720;
      ratio = width / 1280;
      screen.style.setProperty('--startup-unit', String(ratio) + 'px');
      signature.style.top = `${height * 0.425 + 175 * ratio}px`;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const resolution = Math.max(320, Math.min(1000, Math.round(400 * ratio * dpr)));
      if (renderer?.resize) renderer.resize(resolution, resolution);
      else if (!transferred && (canvas.width !== resolution || canvas.height !== resolution)) { canvas.width = resolution; canvas.height = resolution; }
      optics?.resize(width, height, window.devicePixelRatio || 1);
      if (!disposed) draw();
    }

    function visibility() {
      stopFrame();
      if (appReady && document.hidden) complete(); else schedule();
    }
    function motionChanged() { if (reduced.matches) { stopFrame(); if (appReady) complete(); } }
    function contextLost(event) {
      event.preventDefault();
      renderer?.dispose();
      renderer = null;
      canvas.style.opacity = '0';
      fallback.hidden = false;
      schedule();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      stopFrame();
      image.onload = image.onerror = contourImage.onload = contourImage.onerror = null;
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', motionChanged);
      canvas.removeEventListener('webglcontextlost', contextLost);
      delete document.documentElement.dataset.startupHandoff;
      delete document.documentElement.dataset.startupReveal;
      delete screen.dataset.interactive;
      renderer?.dispose();
      renderer = null;
      optics?.dispose();
      optics = null;
      if (!transferred) canvas.width = canvas.height = 1;
      canvas.style.opacity = '0';
      fallback.hidden = false;
      position.style.willChange = shadow.style.willChange = turn.style.willChange = opticsCanvas.style.willChange = 'auto';
    }

    function prepareMaterial() {
      if (disposed || time >= HOLD_TIME || !imageLoaded || !contourLoaded) return;
      try {
        renderer = window.TryloStartupMaterial(canvas, image, contourImage, () => {
          if (disposed || time >= HOLD_TIME) return;
          canvas.style.opacity = '1';
          fallback.hidden = true;
        }, () => { canvas.style.opacity = '0'; fallback.hidden = false; });
        transferred = renderer.transferred === true;
      } catch (_) { fallback.hidden = false; }
      resize();
      schedule();
    }

    image.onload = () => { imageLoaded = true; prepareMaterial(); };
    contourImage.onload = () => { contourLoaded = true; prepareMaterial(); };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', motionChanged);
    canvas.addEventListener('webglcontextlost', contextLost);
    resize();
    schedule();
    image.src = '/startup/approved-facet.png';
    contourImage.src = '/startup/approved-contour.png';

    return {
      ready() {
        if (appReady || disposed) return;
        appReady = true;
        if (document.hidden || reduced.matches) { complete(); return; }
        document.documentElement.dataset.startupReveal = time < 1380 ? 'preparing' : 'settling';
        if (!deadlineArmed) { deadlineArmed = true; playbackStarted((TOTAL_TIME - time) / speed); }
        previous = null;
        schedule();
      },
      accelerate() {
        if (!appReady || disposed || accelerated) return;
        accelerated = true;
        speed = 2.4;
        time = Math.max(time, 1040);
        playbackStarted((TOTAL_TIME - time) / speed);
        draw();
        previous = null;
        schedule();
      },
      dispose,
    };
  };
})();
