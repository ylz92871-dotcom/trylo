import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const html = readFileSync(resolve('index.html'), 'utf8');
const entry = readFileSync(resolve('public/startup.js'), 'utf8');
const sequence = readFileSync(resolve('public/startup/sequence.js'), 'utf8');
const globals = window as unknown as { TryloStartupSequence?: unknown; TryloStartupMaterial?: unknown };
const frames = new Map<number, FrameRequestCallback>();
const images: { onload: (() => void) | null; onerror: (() => void) | null }[] = [];
const renderer = { draw: vi.fn(), dispose: vi.fn() };
let now = 0, nextFrame = 0;
let material: ReturnType<typeof vi.fn<[unknown, unknown, unknown, () => void], typeof renderer>>;
function tick(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    now += 16; const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(now);
  }
}
function boot(): void { new Function(sequence)(); new Function(entry)(); }
function loadMaterial(): void { images[0]!.onload!(); images[1]!.onload!(); }
function ready(): void { window.dispatchEvent(new Event('trylo:startup-ready')); }
function screen(): HTMLElement | null { return document.getElementById('trylo-startup'); }
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); frames.clear(); images.length = 0; now = nextFrame = 0;
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.defineProperty(screen(), 'clientWidth', { value: 1280 });
  Object.defineProperty(screen(), 'clientHeight', { value: 720 });
  const brand = document.createElement('div'); brand.dataset.startupLogo = '';
  const chip = document.createElement('span'); chip.className = 'trilo-mark--chip'; brand.appendChild(chip);
  document.getElementById('root')!.appendChild(brand);
  vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue({ left: 120, top: 48, width: 40, height: 40, right: 160, bottom: 88, x: 120, y: 48, toJSON() {} });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null; src = '';
    constructor() { images.push(this); }
  });
  renderer.draw.mockReset(); renderer.dispose.mockReset();
  material = vi.fn((_canvas, _image, _contour, onReady) => { onReady(); return renderer; }); globals.TryloStartupMaterial = material;
});
afterEach(() => {
  window.dispatchEvent(new Event('trylo:startup-dismiss'));
  vi.runOnlyPendingTimers(); frames.clear(); document.body.innerHTML = '';
  delete globals.TryloStartupSequence; delete globals.TryloStartupMaterial;
  delete document.documentElement.dataset.startupHandoff;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('ships the exact approved bitmap/font and loads the production adapters before the boot bridge', () => {
  for (const [asset, approvedHash] of [
    ['approved-facet.png', 'aa10802c911a917a21cbc96af4b54b89ad85c81d02c9023e2be518b847ce5fca'],
    ['manrope.woff', '17ce0c61056ca8b9f44e45d16c0ac4c544ff97a15d2db379e471251cbaf71942'],
    ['approved-contour.png', '30698550e0a64da4c673c7d60ad673b77814d91c37e79eb8f941632ac1e03f19'],
  ]) {
    const hash = (path: string) => createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
    expect(hash(`public/startup/${asset}`)).toBe(approvedHash);
  }
  for (const file of ['/startup/material.js', '/startup/sequence.js', 'src="/startup.js"']) expect(html).toContain(file);
  expect(html.indexOf('/startup/material.js')).toBeLessThan(html.indexOf('/startup/sequence.js'));
  expect(html.indexOf('/startup/sequence.js')).toBeLessThan(html.indexOf('src="/startup.js"'));
  expect(html).toContain('Try your best.');
});
it('keeps the user-approved preview animation and timing unchanged', () => {
  const approved = JSON.parse(readFileSync(resolve('testdata/startup-approved-20261108.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  for (const [path, expected] of Object.entries(approved.files)) {
    const source = readFileSync(resolve(path), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(source).digest('hex'), `${path}: animation changes require user approval`).toBe(expected);
  }
});
it('holds a slow boot without an endless render loop and finishes against the real sidebar', () => {
  boot(); loadMaterial(); tick(1800);
  expect(screen()).toBeTruthy(); expect(document.getElementById('root')!.inert).toBe(true);
  expect(frames.size).toBe(0); const draws = renderer.draw.mock.calls.length;
  tick(5000); expect(renderer.draw).toHaveBeenCalledTimes(draws);
  ready(); expect(document.getElementById('root')!.inert).toBe(false);
  tick(400);
  expect(document.getElementById('trylo-startup-tile')!.style.transform).toBe('translate3d(120px,48px,0)');
  tick(1000); expect(screen()).toBeNull(); expect(frames.size).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(document.documentElement.hasAttribute('data-startup-handoff')).toBe(false);
});
it('preserves the original word reveal, then rotates at the centre while shrinking and defocusing', () => {
  boot(); ready(); tick(16); tick(320);
  const word = (id: string) => document.getElementById(`trylo-${id}`)!;
  const turn = document.getElementById('trylo-startup-turn')!;
  expect(Number(word('dream-lead').style.opacity)).toBeGreaterThan(0);
  expect(Number(word('dream-key').style.opacity)).toBe(0);
  expect(Number(word('best-key').style.opacity)).toBe(0);
  expect(turn.style.transform).toBe('rotate(0deg)');
  tick(320);
  expect(Number(word('best-key').style.opacity)).toBeGreaterThan(0);
  expect(Number(word('best-key').style.opacity)).toBeLessThan(1);
  tick(320);
  for (const id of ['dream-lead', 'dream-key', 'best-lead', 'best-key']) expect(word(id).style.opacity).toBe('1');
  expect(turn.style.transform).toBe('rotate(0deg)');
  tick(640);
  const angle = Number(turn.style.transform.match(/rotate\(([^d]+)/)?.[1]);
  expect(angle).toBeGreaterThan(0); expect(angle).toBeLessThan(360);
  expect(parseFloat(turn.style.filter.slice(5))).toBeGreaterThan(0);
  expect(document.getElementById('trylo-startup-position')!.style.transform).toMatch(/^translate3d\(440px,106px,0\) scale\(0\./);
  tick(1000); expect(screen()).toBeNull();
});
it.each([200, 1000])('keeps the exact current pose when readiness arrives after %i ms', ms => {
  boot(); tick(ms);
  const position = document.getElementById('trylo-startup-position')!;
  const turn = document.getElementById('trylo-startup-turn')!;
  const before = [position.style.transform, turn.style.transform];
  ready();
  expect([position.style.transform, turn.style.transform]).toEqual(before);
  expect(turn.style.filter).toBe('blur(0px)');
});
it('performs only the original single turn rather than adding a separate entrance revolution', () => {
  boot(); ready(); tick(16);
  const turn = document.getElementById('trylo-startup-turn')!;
  tick(1200); expect(turn.style.transform).toBe('rotate(0deg)');
  tick(600);
  const halfway = Number(turn.style.transform.match(/rotate\(([^d]+)/)?.[1]);
  expect(halfway).toBeGreaterThan(0); expect(halfway).toBeLessThan(360);
  tick(448); expect(turn.style.transform).toBe('rotate(360deg)');
  tick(400); expect(screen()).toBeNull();
});
it('releases interaction immediately but only Escape skips the remaining shot', () => {
  boot(); loadMaterial(); tick(160); ready();
  expect(document.getElementById('root')!.inert).toBe(false); expect(screen()).toBeTruthy();
  window.dispatchEvent(new Event('pointerdown'));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(screen()).toBeTruthy();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(screen()).toBeNull(); expect(frames.size).toBe(0); expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('cannot resurrect a late material load after immediate recovery dismissal', () => {
  boot(); const lateLoad = images[0]!.onload!;
  window.dispatchEvent(new Event('trylo:startup-dismiss')); lateLoad();
  expect(screen()).toBeNull(); expect(material).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
  expect(document.getElementById('root')!.inert).toBe(false);
});
it('never waits for decorative assets once the application is ready', () => {
  boot(); tick(200); ready(); tick(2600);
  expect(material).not.toHaveBeenCalled();
  expect(screen()).toBeNull(); expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('keeps the original presentation when the app commits before its first frame while releasing interaction', () => {
  boot(); ready();
  expect(screen()).not.toBeNull();
  expect(document.getElementById('root')!.inert).toBe(false);
  tick(2600);
  expect(screen()).toBeNull(); expect(frames.size).toBe(0); expect(material).not.toHaveBeenCalled();
});
it('samples the sidebar layout once per handoff instead of on every frame', () => {
  boot(); loadMaterial(); tick(1800); ready(); tick(400);
  const chip = document.querySelector('[data-startup-logo] .trilo-mark--chip')!;
  expect(chip.getBoundingClientRect).toHaveBeenCalledTimes(1);
  tick(1000); expect(screen()).toBeNull();
});
it('still removes the overlay if handoff frames stop arriving', () => {
  boot(); tick(200); ready(); vi.advanceTimersByTime(1000);
  expect(screen()).not.toBeNull();
  vi.advanceTimersByTime(1800);
  expect(screen()).toBeNull(); expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('never resets a transferred canvas while finishing or disposing the animation', () => {
  const resize = vi.fn();
  material.mockImplementation((_canvas, _image, _contour, onReady) => {
    onReady(); return { ...renderer, transferred: true, resize };
  });
  boot(); loadMaterial(); tick(1800);
  const canvas = document.getElementById('trylo-startup-material') as HTMLCanvasElement;
  vi.spyOn(canvas, 'width', 'set').mockImplementation(() => { throw new Error('Transferred canvas cannot be reset'); });
  ready(); tick(1400);
  expect(screen()).toBeNull(); expect(resize).toHaveBeenCalled();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});
it('never replaces the fallback with a late GPU surface during the original turn', () => {
  let initialize!: () => void;
  material.mockImplementation((_canvas, _image, _contour, onReady) => { initialize = onReady; return renderer; });
  boot(); loadMaterial(); tick(1800); ready(); tick(400);
  initialize();
  expect(document.getElementById('trylo-startup-fallback')!.hidden).toBe(false);
  tick(1400); expect(screen()).toBeNull(); expect(renderer.dispose).toHaveBeenCalledTimes(1);
});
it('keeps GPU failure local to presentation and still exits when the app is ready', () => {
  material.mockImplementation(() => { throw new Error('WebGL unavailable'); });
  boot(); loadMaterial(); ready(); tick(2600);
  expect(screen()).toBeNull(); expect(document.getElementById('root')!.inert).toBe(false);
  expect(frames.size).toBe(0);
});
it('does not initialize material work when reduced motion is requested', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  boot(); ready(); expect(screen()).toBeNull(); expect(images).toHaveLength(0); expect(frames.size).toBe(0);
});
it('cleans up a lost graphics context without covering a later successful app mount', () => {
  boot(); loadMaterial();
  document.getElementById('trylo-startup-material')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
  expect(document.getElementById('trylo-startup-fallback')!.hidden).toBe(false);
  ready(); tick(2600); expect(screen()).toBeNull(); expect(document.getElementById('root')!.inert).toBe(false);
});
