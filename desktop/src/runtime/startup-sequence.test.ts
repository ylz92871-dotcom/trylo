import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const html = readFileSync(resolve('index.html'), 'utf8');
const entry = readFileSync(resolve('public/startup.js'), 'utf8');
const opticsSource = readFileSync(resolve('public/startup/optics.js'), 'utf8');
const sequence = readFileSync(resolve('public/startup/sequence.js'), 'utf8');
const globals = window as unknown as {
  TryloStartupSequence?: unknown;
  TryloStartupMaterial?: unknown;
  TryloStartupOptics?: unknown;
};
const frames = new Map<number, FrameRequestCallback>();
const images: { onload: (() => void) | null; onerror: (() => void) | null }[] = [];
const renderer = { draw: vi.fn(), dispose: vi.fn() };
const opticsMock = { resize: vi.fn(), draw: vi.fn(), dispose: vi.fn() };
let now = 0, nextFrame = 0;
let material: ReturnType<typeof vi.fn<[unknown, unknown, unknown, () => void], typeof renderer>>;
let opticsFactory: ReturnType<typeof vi.fn<[unknown], typeof opticsMock>>;

function tick(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    now += 16;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }
}
function boot(): void { new Function(sequence)(); new Function(entry)(); }
function loadMaterial(): void { images[0]!.onload!(); images[1]!.onload!(); }
function ready(): void { window.dispatchEvent(new Event('trylo:startup-ready')); }
function screen(): HTMLElement | null { return document.getElementById('trylo-startup'); }
function parseScale(transform: string): number {
  const match = transform.match(/scale\(([^,)]+)/);
  return match ? Number(match[1]) : Number.NaN;
}
function parseRotate(transform: string): number {
  const match = transform.match(/rotate\(([^d]+)/);
  return match ? Number(match[1]) : Number.NaN;
}
function parseTranslateZ(transform: string): number {
  const match = transform.match(/translate3d\([^,]+,[^,]+,([^p]+)px\)/);
  return match ? Number(match[1]) : Number.NaN;
}
function parseRotateX(transform: string): number {
  const match = transform.match(/rotateX\(([^d]+)deg\)/);
  return match ? Number(match[1]) : Number.NaN;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  frames.clear();
  images.length = 0;
  now = nextFrame = 0;
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.defineProperty(screen(), 'clientWidth', { value: 1280 });
  Object.defineProperty(screen(), 'clientHeight', { value: 720 });
  const brand = document.createElement('div');
  brand.dataset.startupLogo = '';
  const chip = document.createElement('span');
  chip.className = 'trilo-mark--chip';
  brand.appendChild(chip);
  document.getElementById('root')!.appendChild(brand);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
    constructor() { images.push(this); }
  });
  renderer.draw.mockReset();
  renderer.dispose.mockReset();
  opticsMock.resize.mockReset();
  opticsMock.draw.mockReset();
  opticsMock.dispose.mockReset();
  material = vi.fn((_canvas, _image, _contour, onReady) => { onReady(); return renderer; });
  opticsFactory = vi.fn((_canvas: unknown) => opticsMock);
  globals.TryloStartupMaterial = material;
  globals.TryloStartupOptics = opticsFactory;
});

afterEach(() => {
  window.dispatchEvent(new Event('trylo:startup-dismiss'));
  vi.runOnlyPendingTimers();
  frames.clear();
  document.body.innerHTML = '';
  delete globals.TryloStartupSequence;
  delete globals.TryloStartupMaterial;
  delete globals.TryloStartupOptics;
  delete document.documentElement.dataset.startupHandoff;
  delete document.documentElement.dataset.startupReveal;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('ships the exact approved bitmap/font, updated tagline, and script load order', () => {
  for (const [asset, approvedHash] of [
    ['approved-facet.png', 'aa10802c911a917a21cbc96af4b54b89ad85c81d02c9023e2be518b847ce5fca'],
    ['manrope.woff', '17ce0c61056ca8b9f44e45d16c0ac4c544ff97a15d2db379e471251cbaf71942'],
    ['approved-contour.png', '30698550e0a64da4c673c7d60ad673b77814d91c37e79eb8f941632ac1e03f19'],
  ]) {
    const hash = (path: string) => createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
    expect(hash(`public/startup/${asset}`)).toBe(approvedHash);
  }
  for (const file of ['/startup/material.js', '/startup/optics.js', '/startup/sequence.js', 'src="/startup.js"']) expect(html).toContain(file);
  expect(html.indexOf('/startup/material.js')).toBeLessThan(html.indexOf('/startup/optics.js'));
  expect(html.indexOf('/startup/optics.js')).toBeLessThan(html.indexOf('/startup/sequence.js'));
  expect(html.indexOf('/startup/sequence.js')).toBeLessThan(html.indexOf('src="/startup.js"'));
  expect(html).toContain('aria-label="Try your learning, Try your own."');
  expect(html).toContain('learning,');
  expect(html).toContain('own.');
});

it('keeps the user-approved Portal Dive + Light Stream assets aligned with manifest hashes', () => {
  const approved = JSON.parse(readFileSync(resolve('testdata/startup-approved-20261108.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  for (const [path, expected] of Object.entries(approved.files)) {
    const source = readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(source).digest('hex'), `${path}: hash mismatch`).toBe(expected);
  }
});

it('holds a slow boot at 1000ms without an endless loop and settles cleanly on ready', () => {
  boot();
  loadMaterial();
  tick(1600);
  expect(screen()).toBeTruthy();
  expect(document.getElementById('root')!.inert).toBe(true);
  expect(frames.size).toBe(0);
  const draws = renderer.draw.mock.calls.length;

  tick(5000);
  expect(renderer.draw).toHaveBeenCalledTimes(draws);

  ready();
  expect(document.getElementById('root')!.inert).toBe(false);
  expect(document.documentElement.dataset.startupReveal).toBe('preparing');

  tick(128);
  expect(parseRotate(document.getElementById('trylo-startup-turn')!.style.transform)).toBeGreaterThan(0);

  tick(352);
  expect(parseRotate(document.getElementById('trylo-startup-turn')!.style.transform)).toBeGreaterThan(0);
  const lastOpticsState = opticsMock.draw.mock.calls.at(-1)?.[0] as { streamAlpha: number };
  expect(lastOpticsState.streamAlpha).toBeGreaterThan(0);
  expect(document.documentElement.dataset.startupReveal).toBe('settling');

  tick(1000);
  expect(screen()).toBeNull();
  expect(frames.size).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(opticsMock.dispose).toHaveBeenCalledTimes(1);
  expect(document.documentElement.hasAttribute('data-startup-reveal')).toBe(false);
  expect(document.documentElement.hasAttribute('data-startup-handoff')).toBe(false);
});

it('reveals staggered words, 3D levitation, continuous clockwise pull-open feather dissolve, and optical stream entry', () => {
  boot();
  ready();
  tick(16);

  const word = (id: string) => document.getElementById(`trylo-${id}`)!;
  const position = document.getElementById('trylo-startup-position')!;
  const shadow = document.getElementById('trylo-startup-shadow')!;
  const turn = document.getElementById('trylo-startup-turn')!;
  const veil = document.getElementById('trylo-startup-veil')!;

  const initialZ = parseTranslateZ(position.style.transform);
  const initialPitch = parseRotateX(position.style.transform);
  expect(initialZ).toBeLessThan(0);
  expect(initialPitch).toBeGreaterThan(10);

  tick(256);
  expect(Number(word('learning-lead').style.opacity)).toBeGreaterThan(0);
  expect(Number(word('own-key').style.opacity)).toBe(0);
  expect(turn.style.transform).toBe('rotate(0.00deg)');
  expect(turn.style.filter).toBe('');
  expect(Number(shadow.style.opacity)).toBeGreaterThan(0);

  tick(256);
  expect(Number(word('own-key').style.opacity)).toBeGreaterThan(0);
  expect(Number(word('own-key').style.opacity)).toBeLessThan(1);
  expect(parseTranslateZ(position.style.transform)).toBeGreaterThan(initialZ);
  expect(parseRotateX(position.style.transform)).toBeLessThan(initialPitch);

  tick(416);
  for (const id of ['learning-lead', 'learning-key', 'own-lead', 'own-key']) {
    expect(word(id).style.opacity).toBe('1');
  }
  expect(parseTranslateZ(position.style.transform)).toBeGreaterThan(40);
  expect(parseScale(shadow.style.transform)).toBeGreaterThan(1);
  expect(turn.style.transform).toBe('rotate(0.00deg)');

  tick(512);
  const midAngle = parseRotate(turn.style.transform);
  const midOpacity = Number(turn.style.opacity);
  expect(midAngle).toBeGreaterThan(0);
  expect(midAngle).toBeLessThan(120);
  expect(parseScale(position.style.transform)).toBeGreaterThan(2.4);
  expect(parseTranslateZ(position.style.transform)).toBeGreaterThan(180);
  expect(midOpacity).toBeGreaterThan(0.1);
  expect(midOpacity).toBeLessThan(0.85);
  expect(turn.style.filter).toBe('');

  tick(384);
  expect(turn.style.transform).toBe('rotate(120.00deg)');
  expect(Number(turn.style.opacity)).toBe(0);
  const streamOptics = opticsMock.draw.mock.calls.at(-1)?.[0] as { streamAlpha: number; portalOpen: number };
  expect(streamOptics.streamAlpha).toBeGreaterThan(0.7);
  expect(streamOptics.portalOpen).toBeGreaterThan(0.5);
  expect(Number(veil.style.opacity)).toBeLessThan(0.25);
  expect(screen()!.dataset.interactive).toBe('true');

  tick(640);
  expect(screen()).toBeNull();
});

it('renders curved procedural 3D optical halo, iris wash, anamorphic flare, and tunnel ribbons across dark and light themes', () => {
  new Function(opticsSource)();
  const makeGrad = () => ({ addColorStop: vi.fn() });
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    createRadialGradient: vi.fn(makeGrad),
    createLinearGradient: vi.fn(makeGrad),
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
  };
  const canvas = { width: 1, height: 1, getContext: vi.fn(() => ctx) };
  const factory = globals.TryloStartupOptics as (c: unknown) => {
    resize(w: number, h: number, dpr: number): void;
    draw(s: Record<string, unknown>): void;
    dispose(): void;
  };
  const instance = factory(canvas);
  instance.resize(1280, 720, 2);
  expect(canvas.width).toBe(1920);
  expect(canvas.height).toBe(1080);

  instance.draw({
    dark: true,
    pull: 0.55,
    streamTravel: 1.4,
    streamVelocity: 0.9,
    portalOpen: 0.4,
    rotRad: 0.8,
    haloAlpha: 0.8,
    haloScale: 1,
    washAlpha: 0.6,
    flareAlpha: 0.7,
    flareSpan: 0.4,
    streamAlpha: 0.9,
  });
  expect(ctx.globalCompositeOperation).toBe('lighter');
  expect(ctx.quadraticCurveTo).toHaveBeenCalled();
  expect(ctx.stroke).toHaveBeenCalled();
  expect(ctx.fill).toHaveBeenCalled();

  instance.draw({
    dark: false,
    pull: 0.55,
    streamTravel: 1.4,
    streamVelocity: 0.9,
    portalOpen: 0.4,
    rotRad: 0.8,
    haloAlpha: 0.8,
    haloScale: 1,
    washAlpha: 0.6,
    flareAlpha: 0.7,
    flareSpan: 0.4,
    streamAlpha: 0.9,
  });
  expect(ctx.globalCompositeOperation).toBe('source-over');

  instance.dispose();
  expect(canvas.width).toBe(1);
  expect(canvas.height).toBe(1);
});

it.each([200, 600])('keeps the exact current pose without blur when readiness arrives after %i ms', ms => {
  boot();
  tick(ms);
  const position = document.getElementById('trylo-startup-position')!;
  const turn = document.getElementById('trylo-startup-turn')!;
  const before = [position.style.transform, turn.style.transform];
  ready();
  expect([position.style.transform, turn.style.transform]).toEqual(before);
  expect(turn.style.filter).toBe('');
});

it('keeps overlay blocking pointer clicks while opaque, accelerates smoothly on pointerdown, and lets Escape dismiss immediately', () => {
  boot();
  loadMaterial();
  tick(160);
  ready();
  expect(document.getElementById('root')!.inert).toBe(false);
  expect(screen()!.dataset.interactive).toBeUndefined();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(screen()).toBeTruthy();

  screen()!.dispatchEvent(new Event('pointerdown'));
  expect(screen()).toBeTruthy();

  tick(640);
  expect(screen()).toBeNull();
  expect(frames.size).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(opticsMock.dispose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(document.documentElement.hasAttribute('data-startup-reveal')).toBe(false);
});

it('dismisses immediately on Escape during leaving and cleans up reveal state', () => {
  boot();
  loadMaterial();
  tick(160);
  ready();
  expect(document.documentElement.dataset.startupReveal).toBe('preparing');

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(screen()).toBeNull();
  expect(frames.size).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(opticsMock.dispose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(document.documentElement.hasAttribute('data-startup-reveal')).toBe(false);
});

it('cannot resurrect a late material load after immediate recovery dismissal', () => {
  boot();
  const lateLoad = images[0]!.onload!;
  window.dispatchEvent(new Event('trylo:startup-dismiss'));
  lateLoad();
  expect(screen()).toBeNull();
  expect(material).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  expect(document.getElementById('root')!.inert).toBe(false);
});

it('never waits for decorative assets once the application is ready', () => {
  boot();
  tick(200);
  ready();
  tick(2400);
  expect(material).not.toHaveBeenCalled();
  expect(screen()).toBeNull();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the presentation when the app commits before its first frame while releasing interaction', () => {
  boot();
  ready();
  expect(screen()).not.toBeNull();
  expect(document.getElementById('root')!.inert).toBe(false);
  tick(2560);
  expect(screen()).toBeNull();
  expect(frames.size).toBe(0);
  expect(material).not.toHaveBeenCalled();
});

it('still removes the overlay if animation frames stop arriving', () => {
  boot();
  tick(200);
  ready();
  vi.advanceTimersByTime(1500);
  expect(screen()).not.toBeNull();
  vi.advanceTimersByTime(1300);
  expect(screen()).toBeNull();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('never resets a transferred canvas while finishing or disposing the animation', () => {
  const resize = vi.fn();
  material.mockImplementation((_canvas, _image, _contour, onReady) => {
    onReady();
    return { ...renderer, transferred: true, resize };
  });
  boot();
  loadMaterial();
  tick(1400);
  const canvas = document.getElementById('trylo-startup-material') as HTMLCanvasElement;
  vi.spyOn(canvas, 'width', 'set').mockImplementation(() => { throw new Error('Transferred canvas cannot be reset'); });
  ready();
  tick(1600);
  expect(screen()).toBeNull();
  expect(resize).toHaveBeenCalled();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

it('never replaces the fallback with a late GPU surface past the hold point', () => {
  let initialize!: () => void;
  material.mockImplementation((_canvas, _image, _contour, onReady) => { initialize = onReady; return renderer; });
  boot();
  loadMaterial();
  tick(1400);
  ready();
  tick(400);
  initialize();
  expect(document.getElementById('trylo-startup-fallback')!.hidden).toBe(false);
  tick(1200);
  expect(screen()).toBeNull();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

it('keeps GPU failure local to presentation and still exits when the app is ready', () => {
  material.mockImplementation(() => { throw new Error('WebGL unavailable'); });
  boot();
  loadMaterial();
  ready();
  tick(2560);
  expect(screen()).toBeNull();
  expect(document.getElementById('root')!.inert).toBe(false);
  expect(frames.size).toBe(0);
});

it('does not initialize material work when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  boot();
  ready();
  expect(screen()).toBeNull();
  expect(images).toHaveLength(0);
  expect(frames.size).toBe(0);
});

it('cleans up a lost graphics context without covering a later successful app mount', () => {
  boot();
  loadMaterial();
  document.getElementById('trylo-startup-material')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(document.getElementById('trylo-startup-fallback')!.hidden).toBe(false);
  ready();
  tick(2560);
  expect(screen()).toBeNull();
  expect(document.getElementById('root')!.inert).toBe(false);
});
