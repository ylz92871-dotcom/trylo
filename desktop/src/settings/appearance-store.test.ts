import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAppearance } from './appearance-store';

describe('appearance-store radial theme transition', () => {
  const originalMatchMedia = window.matchMedia;
  const originalStartVT = (document as { startViewTransition?: unknown }).startViewTransition;
  const originalAnimate = document.documentElement.animate;

  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    setAppearance('light');
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    if (originalStartVT !== undefined) {
      Object.defineProperty(document, 'startViewTransition', {
        value: originalStartVT,
        configurable: true,
      });
    } else {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
    document.documentElement.animate = originalAnimate;
    delete document.documentElement.dataset.themeTransition;
  });

  it('uses ViewTransition radial clip-path from click origin when supported', async () => {
    const animateMock = vi.fn();
    document.documentElement.animate = animateMock;
    const startVT = vi.fn((update: () => void) => {
      update();
      return { ready: Promise.resolve() };
    });
    Object.defineProperty(document, 'startViewTransition', {
      value: startVT,
      configurable: true,
    });

    setAppearance('dark', { x: 100, y: 80 });
    expect(startVT).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe('dark');

    await Promise.resolve();
    expect(animateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clipPath: [
          expect.stringMatching(/^circle\(0px at 100px 80px\)$/),
          expect.stringMatching(/^circle\(.+px at 100px 80px\)$/),
        ],
      }),
      expect.objectContaining({
        pseudoElement: '::view-transition-new(root)',
      }),
    );
  });

  it('falls back to scoped data-theme-transition when startViewTransition is unavailable or reduced-motion is set', () => {
    delete (document as { startViewTransition?: unknown }).startViewTransition;
    setAppearance('dark', { x: 50, y: 50 });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeTransition).toBe('true');

    delete document.documentElement.dataset.themeTransition;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    setAppearance('light', { x: 50, y: 50 });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
  });
});
