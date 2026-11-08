import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logo } from '../components/brand/Logo';

const startupSource = readFileSync(resolve(process.cwd(), 'public/startup.js'), 'utf8');
const startupDocument = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const originalGetItem = Storage.prototype.getItem;
let systemDark = false;
let reducedMotion = false;
let storageRestricted = false;

function installDocument(): void {
  const parsed = new DOMParser().parseFromString(startupDocument, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

function start(): void {
  // Execute the actual dependency-free entry before any application code.
  // Scripts inserted through innerHTML remain inert until this explicit call.
  new Function(startupSource)();
}

function ready(): void {
  window.dispatchEvent(new Event('trylo:startup-ready'));
}

function finishAndRemove(): void {
  ready();
  vi.runOnlyPendingTimers();
}

function startup(): HTMLElement | null {
  return document.getElementById('trylo-startup');
}

function root(): HTMLElement {
  return document.getElementById('root')!;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  systemDark = false;
  reducedMotion = false;
  storageRestricted = false;
  delete document.documentElement.dataset.theme;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (storageRestricted) throw new Error('Storage unavailable');
    return originalGetItem.call(this, key);
  });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? reducedMotion : systemDark,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  installDocument();
});

afterEach(() => {
  // Exercise the real cleanup path, including listeners installed by the IIFE.
  finishAndRemove();
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('early startup screen', () => {
  it('keeps the application blocked until real readiness and does not wait for the entrance animation', () => {
    start();
    expect(root().inert).toBe(true);
    window.dispatchEvent(new CustomEvent('trylo:startup-stage', { detail: '正在准备本地工作区…' }));
    expect(document.getElementById('trylo-startup-status')?.textContent).toBe('正在准备本地工作区…');
    vi.advanceTimersByTime(1000);
    expect(startup()?.dataset.phase).toBe('loading');
    expect(root().inert).toBe(true);

    ready();
    expect(root().inert).toBe(false);
    expect(startup()?.getAttribute('aria-hidden')).toBe('true');
    expect(startup()?.dataset.phase).toBe('leaving');
    // Losing animationend (or the stylesheet) must never leave an invisible blocker.
    vi.runOnlyPendingTimers();
    expect(startup()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles duplicate ready signals idempotently and ignores late stage or error events', () => {
    start();
    const status = document.getElementById('trylo-startup-status')!;
    ready();
    const pendingTimers = vi.getTimerCount();
    ready();
    expect(vi.getTimerCount()).toBe(pendingTimers);
    window.dispatchEvent(new CustomEvent('trylo:startup-stage', { detail: 'late update' }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'late failure' }));
    expect(status.textContent).toBe('正在启动 Trylo…');
    expect(startup()?.dataset.phase).toBe('leaving');
    finishAndRemove();
    expect(startup()).toBeNull();
    expect(root().inert).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes immediately when reduced motion disables animation events', () => {
    reducedMotion = true;
    start();
    ready();
    expect(startup()).toBeNull();
    expect(root().inert).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers recovery after a slow startup while allowing a late successful mount to finish', () => {
    start();
    const reload = document.getElementById('trylo-startup-reload') as HTMLButtonElement;
    vi.advanceTimersByTime(29_999);
    expect(reload.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reload.hidden).toBe(false);
    expect(reload.textContent).toBe('重新加载');
    expect(document.getElementById('trylo-startup-status')?.textContent).toContain('继续等待或重新加载');
    expect(root().inert).toBe(true);
    finishAndRemove();
    expect(startup()).toBeNull();
    expect(root().inert).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reveals recovery for script resource failure without treating a missing image as an application failure', () => {
    start();
    const image = document.createElement('img');
    document.body.appendChild(image);
    image.dispatchEvent(new Event('error'));
    expect(startup()?.dataset.phase).toBe('loading');
    expect((document.getElementById('trylo-startup-reload') as HTMLButtonElement).hidden).toBe(true);

    document.querySelector('script[type="module"]')!.dispatchEvent(new Event('error'));
    expect(startup()?.dataset.phase).toBe('failed');
    expect((document.getElementById('trylo-startup-reload') as HTMLButtonElement).hidden).toBe(false);
    expect(document.getElementById('trylo-startup-status')?.textContent).toContain('启动未能完成');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps runtime failure visible until recovery UI or the application actually commits', () => {
    start();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Application failed to evaluate' }));
    const status = document.getElementById('trylo-startup-status')!;
    expect(startup()?.dataset.phase).toBe('failed');
    window.dispatchEvent(new CustomEvent('trylo:startup-stage', { detail: 'misleading progress' }));
    expect(status.textContent).toContain('启动未能完成');
    expect(root().inert).toBe(true);
    finishAndRemove();
    expect(startup()).toBeNull();
    expect(root().inert).toBe(false);
  });

  it('uses the real sidebar mark geometry for landing, while the first frame uses the approved artwork', () => {
    const component = new DOMParser().parseFromString(renderToStaticMarkup(createElement(Logo, {
      decorative: true, size: 40, tone: 'cream', variant: 'solid', withBg: true,
    })), 'text/html');
    const earlySvg = document.querySelector('#trylo-startup-flat')!;
    const componentSvg = component.querySelector('svg')!;
    for (const attribute of ['width', 'height', 'viewBox']) {
      expect(earlySvg.getAttribute(attribute)).toBe(componentSvg.getAttribute(attribute));
    }
    const earlyGroup = earlySvg.querySelector('g')!;
    const componentGroup = componentSvg.querySelector('g')!;
    for (const attribute of ['transform', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']) {
      expect(earlyGroup.getAttribute(attribute)).toBe(componentGroup.getAttribute(attribute));
    }
    expect(Array.from(earlyGroup.querySelectorAll('path'), path => path.getAttribute('d')))
      .toEqual(Array.from(componentGroup.querySelectorAll('path'), path => path.getAttribute('d')));
    expect(earlyGroup.getAttribute('stroke')).toBe('currentColor');
    const firstFrame = document.getElementById('trylo-startup-fallback')!;
    expect(firstFrame.tagName).toBe('IMG');
    expect(firstFrame.getAttribute('src')).toBe('/startup/approved-facet.png');
    expect(document.querySelector('.startup-screen__mark')).toBeNull();
  });

  it('matches the appearance store default, saved themes, system preference and restricted storage fallback', () => {
    const cases = [
      { saved: null, systemDark: true, restricted: false, expected: 'light' },
      { saved: 'unknown', systemDark: true, restricted: false, expected: 'light' },
      { saved: 'light', systemDark: true, restricted: false, expected: 'light' },
      { saved: 'dark', systemDark: false, restricted: false, expected: 'dark' },
      { saved: 'system', systemDark: true, restricted: false, expected: 'dark' },
      { saved: 'system', systemDark: false, restricted: false, expected: 'light' },
      { saved: 'dark', systemDark: true, restricted: true, expected: 'light' },
    ];
    for (const testCase of cases) {
      localStorage.clear();
      if (testCase.saved !== null) localStorage.setItem('trylo.appearance.v1', testCase.saved);
      systemDark = testCase.systemDark;
      storageRestricted = testCase.restricted;
      installDocument();
      start();
      expect(document.documentElement.dataset.theme, JSON.stringify(testCase)).toBe(testCase.expected);
      finishAndRemove();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
