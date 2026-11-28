import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const xtermMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    clear: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    hasSelection: () => boolean;
    getSelection: () => string;
    clearSelection: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  }>,
  fit: vi.fn(),
  ptySpawn: vi.fn(),
  ptyResize: vi.fn(),
  ptyWrite: vi.fn(),
  ptyKill: vi.fn(),
}));

vi.mock('@xterm/xterm', () => {
  class MockXTerm {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    textarea: HTMLTextAreaElement | null = document.createElement('textarea');
    clear = vi.fn();
    writeln = vi.fn();
    write = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    clearSelection = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    keyHandler: ((event: KeyboardEvent) => boolean) | undefined;

    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      xtermMocks.instances.push(this);
    }

    loadAddon() {}
    open(container: HTMLElement) {
      if (this.textarea) container.appendChild(this.textarea);
    }
    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) {
      this.keyHandler = fn;
    }
    onData() {
      return { dispose: vi.fn() };
    }
  }
  return { Terminal: MockXTerm };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = xtermMocks.fit;
  }
  return { FitAddon: MockFitAddon };
});

vi.mock('../../host-adapter', () => ({
  hostAdapter: {
    pty: {
      spawn: xtermMocks.ptySpawn,
      resize: xtermMocks.ptyResize,
      write: xtermMocks.ptyWrite,
      kill: xtermMocks.ptyKill,
    },
  },
}));

const originalResizeObserver = globalThis.ResizeObserver;
const originalMatchMedia = window.matchMedia;

function mockPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  };
}

let restorePlatform: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  xtermMocks.instances.length = 0;
  localStorage.clear();
  restorePlatform = mockPlatform('MacIntel');
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  xtermMocks.ptySpawn.mockResolvedValue({ id: 'pty-1', shell: '/bin/zsh' });
  xtermMocks.ptyResize.mockResolvedValue(undefined);
  xtermMocks.ptyWrite.mockResolvedValue(undefined);
  xtermMocks.ptyKill.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  restorePlatform?.();
  restorePlatform = undefined;
  globalThis.ResizeObserver = originalResizeObserver;
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Terminal macOS native integration', () => {
  it('syncs Light/Dark xterm palettes live without respawning PTY and supports drag resize + shortcuts', async () => {
    const appearance = await import('../../settings/appearance-store');
    appearance.setAppearance('light');
    const { Terminal } = await import('./Terminal');

    const onReturnFocus = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <Terminal cwd="/Users/mo/Trylo" id="term-1" onReturnFocus={onReturnFocus} onClose={onClose} />,
    );

    await vi.waitFor(() => {
      expect(xtermMocks.ptySpawn).toHaveBeenCalledTimes(1);
      expect(screen.getByText('zsh')).toBeVisible();
    });
    expect(screen.getByText('Trylo')).toBeVisible();

    const instance = xtermMocks.instances[0]!;
    expect(instance.options.macOptionIsMeta).toBe(true);
    expect((instance.options.theme as { background: string }).background).toBe('#efede7');

    act(() => {
      appearance.setAppearance('dark');
    });
    await vi.waitFor(() => {
      expect((instance.options.theme as { background: string }).background).toBe('#191917');
    });
    // Live appearance switches must not tear down or respawn the running shell.
    expect(xtermMocks.ptySpawn).toHaveBeenCalledTimes(1);
    expect(xtermMocks.ptyKill).not.toHaveBeenCalled();

    // Dragging the horizontal resizer updates persisted height and double-click resets it.
    const panel = container.querySelector('.terminal-panel') as HTMLElement;
    const resizer = screen.getByRole('separator', { name: '调整终端高度' });
    fireEvent.pointerDown(resizer, { button: 0, clientY: 500 });
    expect(panel).toHaveAttribute('data-dragging', 'true');
    fireEvent.pointerMove(window, { clientY: 420 });
    expect(panel).toHaveStyle({ height: '320px' });
    fireEvent.pointerUp(window);
    expect(panel).not.toHaveAttribute('data-dragging');

    fireEvent.doubleClick(resizer);
    expect(panel).toHaveStyle({ height: '240px' });

    // Cmd+K clears xterm buffer without bubbling; Cmd+= zooms font size.
    const clearResult = instance.keyHandler?.({
      type: 'keydown',
      key: 'k',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(clearResult).toBe(false);
    expect(instance.clear).toHaveBeenCalledTimes(1);

    act(() => {
      instance.keyHandler?.({
        type: 'keydown',
        key: '=',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as KeyboardEvent);
    });
    await vi.waitFor(() => {
      expect(instance.options.fontSize).toBe(14);
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭终端' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
