/* Procedural 3D perspective optical field for Trylo startup: volumetric halo, anamorphic streak, curved tunnel ribbons, and lens bokeh. */
(function () {
  'use strict';

  function createRng(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function modPositive(n, m) {
    return ((n % m) + m) % m;
  }

  function createOptics(canvas) {
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: true }) : null;
    if (!ctx) {
      return { resize() {}, draw() {}, dispose() {} };
    }

    const rng = createRng(0x5472796c);
    const FILAMENT_COUNT = 76;
    const MOTE_COUNT = 14;
    const TUNNEL_DEPTH = 1.9;

    // Pre-allocate deterministic 3D cylindrical tunnel ribbons outside the central safe zone.
    const filaments = [];
    for (let i = 0; i < FILAMENT_COUNT; i += 1) {
      const sectorAngle = (i / FILAMENT_COUNT) * Math.PI * 2;
      const silk = rng() < 0.45;
      filaments.push({
        angle: sectorAngle + (rng() - 0.5) * 0.22,
        radius: 0.25 + Math.pow(rng(), 0.76) * 0.86,
        z0: 0.16 + rng() * TUNNEL_DEPTH,
        depthSpeed: 0.82 + rng() * 0.98,
        trail: silk ? 0.26 + rng() * 0.26 : 0.16 + rng() * 0.20,
        width: silk ? 0.75 + rng() * 0.65 : 1.25 + rng() * 1.15,
        tone: rng() < 0.58 ? 0 : rng() < 0.84 ? 1 : 2, // 0: champagne gold, 1: platinum rim, 2: warm amber
        alpha: silk ? 0.36 + rng() * 0.36 : 0.48 + rng() * 0.44,
      });
    }

    // Pre-allocate shallow-DOF foreground lens bokeh motes near outer periphery.
    const motes = [];
    for (let i = 0; i < MOTE_COUNT; i += 1) {
      motes.push({
        angle: rng() * Math.PI * 2,
        radius: 0.36 + rng() * 0.56,
        z0: 0.26 + rng() * 1.45,
        speed: 0.68 + rng() * 0.78,
        size: 10 + rng() * 26,
        alpha: 0.05 + rng() * 0.09,
        tone: rng() < 0.65 ? 0 : 1,
      });
    }

    let cssWidth = 1280;
    let cssHeight = 720;
    let dpr = 1;
    let disposed = false;

    function toneRgb(dark, tone) {
      if (dark) {
        if (tone === 0) return '238, 209, 138';
        if (tone === 1) return '232, 237, 246';
        return '214, 170, 82';
      }
      if (tone === 0) return '166, 122, 38';
      if (tone === 1) return '122, 129, 142';
      return '192, 146, 56';
    }

    function drawHalo(cx, cy, minDim, state) {
      const { haloAlpha, haloScale, washAlpha, dark } = state;
      if (haloAlpha > 0.004) {
        const radius = minDim * 0.46 * haloScale;
        const grad = ctx.createRadialGradient(cx, cy, radius * 0.04, cx, cy, radius);
        if (dark) {
          grad.addColorStop(0, `rgba(244, 222, 162, ${0.24 * haloAlpha})`);
          grad.addColorStop(0.36, `rgba(220, 184, 104, ${0.10 * haloAlpha})`);
          grad.addColorStop(0.74, `rgba(186, 198, 224, ${0.03 * haloAlpha})`);
          grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        } else {
          grad.addColorStop(0, `rgba(226, 188, 108, ${0.21 * haloAlpha})`);
          grad.addColorStop(0.42, `rgba(208, 168, 88, ${0.085 * haloAlpha})`);
          grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Subtle ring-like iris light wash bridges the dissolving emblem into the open tunnel.
      if (washAlpha > 0.005) {
        const outerR = minDim * (0.42 + state.portalOpen * 0.62);
        const innerR = outerR * 0.22;
        const wash = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
        const rgb = dark ? '242, 224, 174' : '214, 176, 98';
        wash.addColorStop(0, `rgba(${rgb}, 0)`);
        wash.addColorStop(0.45, `rgba(${rgb}, ${(dark ? 0.16 : 0.12) * washAlpha})`);
        wash.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = wash;
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawAnamorphic(cx, cy, w, state) {
      const { flareAlpha, flareSpan, dark } = state;
      if (flareAlpha <= 0.005) return;
      const halfLen = w * (0.20 + flareSpan * 0.28);
      const coreRgb = dark ? '248, 232, 184' : '174, 130, 44';
      const rimRgb = dark ? '224, 232, 248' : '136, 142, 156';

      const lineGrad = ctx.createLinearGradient(cx - halfLen, cy, cx + halfLen, cy);
      lineGrad.addColorStop(0, `rgba(${coreRgb}, 0)`);
      lineGrad.addColorStop(0.28, `rgba(${rimRgb}, ${0.24 * flareAlpha})`);
      lineGrad.addColorStop(0.5, `rgba(${coreRgb}, ${0.74 * flareAlpha})`);
      lineGrad.addColorStop(0.72, `rgba(${rimRgb}, ${0.24 * flareAlpha})`);
      lineGrad.addColorStop(1, `rgba(${coreRgb}, 0)`);

      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx - halfLen, cy);
      ctx.lineTo(cx + halfLen, cy);
      ctx.stroke();

      const glowGrad = ctx.createLinearGradient(cx - halfLen * 0.65, cy, cx + halfLen * 0.65, cy);
      glowGrad.addColorStop(0, `rgba(${coreRgb}, 0)`);
      glowGrad.addColorStop(0.5, `rgba(${coreRgb}, ${0.20 * flareAlpha})`);
      glowGrad.addColorStop(1, `rgba(${coreRgb}, 0)`);
      ctx.strokeStyle = glowGrad;
      ctx.lineWidth = 5.5;
      ctx.beginPath();
      ctx.moveTo(cx - halfLen * 0.65, cy);
      ctx.lineTo(cx + halfLen * 0.65, cy);
      ctx.stroke();
    }

    function drawFilaments(cx, cy, minDim, state) {
      const { streamAlpha, streamTravel, streamVelocity, portalOpen, rotRad, dark } = state;
      if (streamAlpha <= 0.004) return;
      const focal = minDim * 0.56;
      const trailScale = 0.24 + streamVelocity * 1.65;
      const radialPart = portalOpen * 0.44;
      const canCurve = typeof ctx.quadraticCurveTo === 'function';

      ctx.lineCap = 'round';
      for (let i = 0; i < filaments.length; i += 1) {
        const f = filaments[i];
        const zHead = modPositive(f.z0 - streamTravel * f.depthSpeed, TUNNEL_DEPTH) + 0.11;
        const zTail = zHead + f.trail * trailScale;
        const zMid = (zHead + zTail) * 0.5;

        const farFade = Math.max(0, Math.min(1, (1.92 - zHead) / 0.36));
        const nearFade = Math.max(0, Math.min(1, (zHead - 0.11) / 0.17));
        const alpha = streamAlpha * f.alpha * farFade * nearFade;
        if (alpha <= 0.01) continue;

        const effectiveRadius = f.radius + radialPart;
        const baseSwirl = f.angle + rotRad * 0.44;
        const swirlHead = baseSwirl + (1.25 - zHead) * 0.18;
        const swirlMid = baseSwirl + (1.25 - zMid) * 0.18;
        const swirlTail = baseSwirl + (1.25 - zTail) * 0.18;

        const rHead = (effectiveRadius * focal) / zHead;
        const rMid = (effectiveRadius * focal) / zMid;
        const rTail = (effectiveRadius * focal) / zTail;
        const hx = cx + Math.cos(swirlHead) * rHead;
        const hy = cy + Math.sin(swirlHead) * rHead;
        const mx = cx + Math.cos(swirlMid) * rMid;
        const my = cy + Math.sin(swirlMid) * rMid;
        const tx = cx + Math.cos(swirlTail) * rTail;
        const ty = cy + Math.sin(swirlTail) * rTail;

        if ((hx < -90 && tx < -90) || (hx > cssWidth + 90 && tx > cssWidth + 90) ||
            (hy < -90 && ty < -90) || (hy > cssHeight + 90 && ty > cssHeight + 90)) {
          continue;
        }

        const rgb = toneRgb(dark, f.tone);
        const grad = ctx.createLinearGradient(tx, ty, hx, hy);
        grad.addColorStop(0, `rgba(${rgb}, 0)`);
        grad.addColorStop(0.52, `rgba(${rgb}, ${alpha * 0.46})`);
        grad.addColorStop(1, `rgba(${rgb}, ${alpha})`);

        ctx.strokeStyle = grad;
        ctx.lineWidth = Math.max(0.75, f.width * Math.min(1.65, 0.74 / zHead));
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        if (canCurve) ctx.quadraticCurveTo(mx, my, hx, hy);
        else ctx.lineTo(hx, hy);
        ctx.stroke();

        if (f.tone === 0 && alpha > 0.22) {
          ctx.fillStyle = `rgba(${rgb}, ${alpha * 0.85})`;
          ctx.beginPath();
          ctx.arc(hx, hy, Math.max(0.8, f.width * 0.56), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function drawMotes(cx, cy, minDim, state) {
      const { streamAlpha, streamTravel, portalOpen, rotRad, dark } = state;
      if (streamAlpha <= 0.01 || streamTravel <= 0.02) return;
      const focal = minDim * 0.62;
      const radialPart = portalOpen * 0.36;

      for (let i = 0; i < motes.length; i += 1) {
        const m = motes[i];
        const z = modPositive(m.z0 - streamTravel * 0.52 * m.speed, 1.45) + 0.18;
        const depthFade = Math.max(0, Math.min(1, (1.50 - z) / 0.35)) * Math.max(0, Math.min(1, (z - 0.18) / 0.22));
        const alpha = streamAlpha * m.alpha * depthFade;
        if (alpha <= 0.004) continue;

        const theta = m.angle + rotRad * 0.28;
        const dist = ((m.radius + radialPart) * focal) / z;
        const mx = cx + Math.cos(theta) * dist;
        const my = cy + Math.sin(theta) * dist;
        const r = m.size * Math.min(1.9, 0.78 / z);

        if (mx + r < 0 || mx - r > cssWidth || my + r < 0 || my - r > cssHeight) continue;

        const rgb = toneRgb(dark, m.tone);
        const grad = ctx.createRadialGradient(mx, my, r * 0.05, mx, my, r);
        grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
        grad.addColorStop(0.5, `rgba(${rgb}, ${alpha * 0.36})`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    return {
      resize(width, height, devicePixelRatio) {
        if (disposed) return;
        cssWidth = Math.max(1, width || 1280);
        cssHeight = Math.max(1, height || 720);
        dpr = Math.max(1, Math.min(devicePixelRatio || 1, 1.5));
        const targetW = Math.max(1, Math.round(cssWidth * dpr));
        const targetH = Math.max(1, Math.round(cssHeight * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
      },

      draw(state) {
        if (disposed) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const active = state.haloAlpha > 0.004 || state.washAlpha > 0.005 || state.flareAlpha > 0.005 || state.streamAlpha > 0.004;
        if (!active) return;

        const cx = cssWidth * 0.5;
        const cy = cssHeight * 0.425;
        const minDim = Math.min(cssWidth, cssHeight);

        ctx.save();
        ctx.globalCompositeOperation = state.dark ? 'lighter' : 'source-over';
        drawHalo(cx, cy, minDim, state);
        drawFilaments(cx, cy, minDim, state);
        drawAnamorphic(cx, cy, cssWidth, state);
        drawMotes(cx, cy, minDim, state);
        ctx.restore();
      },

      dispose() {
        if (disposed) return;
        disposed = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = canvas.height = 1;
      },
    };
  }

  window.TryloStartupOptics = createOptics;
})();
