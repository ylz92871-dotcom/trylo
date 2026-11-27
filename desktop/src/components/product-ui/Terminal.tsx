// Trylo Desktop — Terminal. See ARCHITECTURE.md §3 Phase 1
// Week 2 (Terminal).
//
// xterm.js frontend over hostAdapter.pty. On macOS this mounts with native
// Light/Dark xterm palettes, a hairline drag-resizer, compact header controls,
// and macOS terminal shortcuts without restarting the underlying PTY.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Eraser, Minus, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { hostAdapter } from '../../host-adapter';
import { onMacosWake } from '../../host-adapter/system-wake';
import { copyTextToNativeClipboard } from '../../host-adapter/native-shell';
import { useAppearance } from '../../settings/appearance-store';
import { formatShortcut, isMacPlatform } from '../../utils/platform';
import './Terminal.css';

export const DEFAULT_TERMINAL_HEIGHT = 240;
export const MIN_TERMINAL_HEIGHT = 140;
const MIN_FONT_SIZE = 11;
const DEFAULT_FONT_SIZE = 13;
const MAX_FONT_SIZE = 18;
const HEIGHT_STORAGE_KEY = 'trylo.terminal.height.v1';
const FONT_SIZE_STORAGE_KEY = 'trylo.terminal.fontSize.v1';

const LIGHT_XTERM_THEME: ITheme = {
  background: '#faf8f3',
  foreground: '#262725',
  cursor: '#946d22',
  cursorAccent: '#faf8f3',
  selectionBackground: 'rgba(148, 109, 34, 0.22)',
  black: '#262725',
  red: '#b93840',
  green: '#247441',
  yellow: '#8a6518',
  blue: '#286597',
  magenta: '#88479b',
  cyan: '#1b6f78',
  white: '#6d6f6a',
  brightBlack: '#71736e',
  brightRed: '#cc4850',
  brightGreen: '#2f8a50',
  brightYellow: '#9f7520',
  brightBlue: '#3277af',
  brightMagenta: '#9c56b1',
  brightCyan: '#23828c',
  brightWhite: '#9c9e98',
};

const DARK_XTERM_THEME: ITheme = {
  background: '#1c1d20',
  foreground: '#e8e9eb',
  cursor: '#ddc27f',
  cursorAccent: '#1c1d20',
  selectionBackground: 'rgba(221, 194, 127, 0.24)',
  black: '#3a3d42',
  red: '#ee8990',
  green: '#8dcea0',
  yellow: '#ddc27f',
  blue: '#91b8f5',
  magenta: '#c99ef2',
  cyan: '#7dd3c8',
  white: '#d0d3d8',
  brightBlack: '#747981',
  brightRed: '#f5a1a7',
  brightGreen: '#a4dfb5',
  brightYellow: '#ead6a5',
  brightBlue: '#adc8f8',
  brightMagenta: '#dab9f7',
  brightCyan: '#99e2d8',
  brightWhite: '#ffffff',
};

function maxTerminalHeight(): number {
  if (typeof window === 'undefined' || window.innerHeight <= 0) return 520;
  return Math.max(240, Math.round(window.innerHeight * 0.6));
}

function clampTerminalHeight(height: number): number {
  return Math.min(Math.max(Math.round(height), MIN_TERMINAL_HEIGHT), maxTerminalHeight());
}

function clampFontSize(size: number): number {
  return Math.min(Math.max(Math.round(size), MIN_FONT_SIZE), MAX_FONT_SIZE);
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Restricted webviews keep session-only layout sizing.
  }
}

function shortWorkspaceName(cwd: string): string {
  const clean = cwd.replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).at(-1) || cwd;
}

function shortShellName(shell: string): string {
  return shell.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || shell;
}

export interface TerminalProps {
  /** Working directory the spawned shell starts in. */
  readonly cwd: string;
  readonly id: string;
  readonly onReturnFocus: () => void;
  readonly onClose?: () => void;
}

export function Terminal({ cwd, id, onReturnFocus, onClose }: TerminalProps): ReactElement {
  const { theme } = useAppearance();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const onReturnFocusRef = useRef(onReturnFocus);
  onReturnFocusRef.current = onReturnFocus;

  const initialThemeRef = useRef(theme);
  initialThemeRef.current = theme;

  const [height, setHeight] = useState<number>(() =>
    clampTerminalHeight(readStoredNumber(HEIGHT_STORAGE_KEY, DEFAULT_TERMINAL_HEIGHT)),
  );
  const [fontSize, setFontSize] = useState<number>(() =>
    clampFontSize(readStoredNumber(FONT_SIZE_STORAGE_KEY, DEFAULT_FONT_SIZE)),
  );
  const initialFontSizeRef = useRef(fontSize);
  initialFontSizeRef.current = fontSize;

  const [dragging, setDragging] = useState(false);
  const [shellLabel, setShellLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mac = isMacPlatform();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      fontFamily: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, Cascadia Mono, Consolas, monospace",
      fontSize: initialFontSizeRef.current,
      macOptionIsMeta: true,
      theme: initialThemeRef.current === 'dark' ? DARK_XTERM_THEME : LIGHT_XTERM_THEME,
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    xterm.textarea?.setAttribute('aria-label', '终端输入，按 Shift+Escape 返回工具栏');
    xtermRef.current = xterm;
    fitRef.current = fit;

    try {
      fit.fit();
    } catch {
      // Ignore transient hidden-container fit failures during test or transition frames.
    }

    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (event.key === 'Escape' && event.shiftKey) {
        onReturnFocusRef.current();
        return false;
      }

      if (isMacPlatform() && event.metaKey && !event.ctrlKey && !event.altKey) {
        const lower = event.key.toLowerCase();
        if (!event.shiftKey && lower === 'k') {
          event.preventDefault();
          event.stopPropagation();
          xterm.clear();
          return false;
        }
        if (!event.shiftKey && lower === 'c' && xterm.hasSelection()) {
          void copyTextToNativeClipboard(xterm.getSelection());
          xterm.clearSelection();
          return false;
        }
        if (!event.shiftKey && lower === 'v') {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
            void navigator.clipboard.readText().then((text) => {
              if (text && ptyIdRef.current) {
                void hostAdapter.pty.write(ptyIdRef.current, new TextEncoder().encode(text));
              }
            }).catch(() => {
              // Ignore denied clipboard read outside user gesture.
            });
          }
          return false;
        }
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          setFontSize((prev) => clampFontSize(prev + 1));
          return false;
        }
        if (!event.shiftKey && event.key === '-') {
          event.preventDefault();
          setFontSize((prev) => clampFontSize(prev - 1));
          return false;
        }
        if (!event.shiftKey && event.key === '0') {
          event.preventDefault();
          setFontSize(DEFAULT_FONT_SIZE);
          return false;
        }
      }

      return true;
    });

    let alive = true;

    const handleResize = (): void => {
      try {
        fit.fit();
        if (ptyIdRef.current) {
          void hostAdapter.pty.resize(ptyIdRef.current, xterm.cols, xterm.rows);
        }
      } catch {
        // Ignore fit throws when container is temporarily collapsed.
      }
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);

    xterm.onData((data) => {
      if (ptyIdRef.current) {
        void hostAdapter.pty.write(ptyIdRef.current, new TextEncoder().encode(data));
      }
    });

    (async () => {
      try {
        const result = await hostAdapter.pty.spawn({
          cols: xterm.cols,
          rows: xterm.rows,
          cwd,
          onOutput: (data) => {
            if (alive) xterm.write(data);
          },
        });
        if (!alive) {
          await hostAdapter.pty.kill(result.id);
          return;
        }
        ptyIdRef.current = result.id;
        setShellLabel(shortShellName(result.shell));
        xterm.writeln(`[Trylo terminal — ${result.shell}]`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (alive) setError(message);
      }
    })();

    const stopWakeCheck = onMacosWake(() => {
      const id = ptyIdRef.current;
      if (!id || !hostAdapter.pty.isAlive) return;
      void hostAdapter.pty.isAlive(id).then(open => {
        if (!alive || ptyIdRef.current !== id) return;
        if (open) {
          handleResize();
          return;
        }
        ptyIdRef.current = null;
        setError('终端已退出。关闭面板后可重新打开终端。');
        return hostAdapter.pty.kill(id);
      }).catch(error => {
        if (alive) console.warn('唤醒后检查终端失败', error);
      });
    });

    return () => {
      alive = false;
      stopWakeCheck();
      ro.disconnect();
      const activePtyId = ptyIdRef.current;
      ptyIdRef.current = null;
      xtermRef.current = null;
      fitRef.current = null;
      if (activePtyId) void hostAdapter.pty.kill(activePtyId);
      xterm.dispose();
    };
  }, [cwd]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.theme = theme === 'dark' ? DARK_XTERM_THEME : LIGHT_XTERM_THEME;
  }, [theme]);

  useEffect(() => {
    writeStoredNumber(FONT_SIZE_STORAGE_KEY, fontSize);
    const xterm = xtermRef.current;
    const fit = fitRef.current;
    if (!xterm || !fit) return;
    xterm.options.fontSize = fontSize;
    try {
      fit.fit();
      if (ptyIdRef.current) {
        void hostAdapter.pty.resize(ptyIdRef.current, xterm.cols, xterm.rows);
      }
    } catch {
      // Ignore resize error when terminal slot is hidden.
    }
  }, [fontSize]);

  const startResizeDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    let latestHeight = startHeight;
    setDragging(true);

    const onMove = (moveEvent: PointerEvent): void => {
      const next = clampTerminalHeight(startHeight + (startY - moveEvent.clientY));
      latestHeight = next;
      setHeight(next);
    };

    const onUp = (): void => {
      setDragging(false);
      writeStoredNumber(HEIGHT_STORAGE_KEY, latestHeight);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const handleResizerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 16 : -16;
    const next = clampTerminalHeight(height + delta);
    setHeight(next);
    writeStoredNumber(HEIGHT_STORAGE_KEY, next);
  };

  const resetHeight = (): void => {
    const next = clampTerminalHeight(DEFAULT_TERMINAL_HEIGHT);
    setHeight(next);
    writeStoredNumber(HEIGHT_STORAGE_KEY, next);
  };

  return (
    <section
      className="terminal-panel"
      id={id}
      aria-label="集成终端"
      data-dragging={dragging ? 'true' : undefined}
      style={{ height: `${height}px` }}
    >
      <div
        className="terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端高度"
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuemax={maxTerminalHeight()}
        aria-valuenow={height}
        tabIndex={0}
        title="上下拖拽调整终端高度，双击恢复默认高度"
        onPointerDown={startResizeDrag}
        onDoubleClick={resetHeight}
        onKeyDown={handleResizerKeyDown}
      />
      <header className="terminal-header">
        <div className="terminal-header__meta">
          <TerminalIcon size={13} strokeWidth={1.75} aria-hidden="true" />
          <span className="terminal-header__cwd" title={cwd}>
            {shortWorkspaceName(cwd)}
          </span>
          {shellLabel && <span className="terminal-header__shell">{shellLabel}</span>}
        </div>
        <div className="terminal-header__actions">
          <button
            type="button"
            className="terminal-header__btn"
            onClick={() => setFontSize((prev) => clampFontSize(prev - 1))}
            disabled={fontSize <= MIN_FONT_SIZE}
            title={mac ? `缩小字号 ${formatShortcut(['Mod', '-'])}` : '缩小字号'}
            aria-label="缩小终端字号"
          >
            <Minus size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="terminal-header__btn terminal-header__font-badge"
            onClick={() => setFontSize(DEFAULT_FONT_SIZE)}
            title={mac ? `重置字号 ${formatShortcut(['Mod', '0'])}` : '重置字号'}
            aria-label={`当前字号 ${fontSize}px，点击重置`}
          >
            {fontSize}px
          </button>
          <button
            type="button"
            className="terminal-header__btn"
            onClick={() => setFontSize((prev) => clampFontSize(prev + 1))}
            disabled={fontSize >= MAX_FONT_SIZE}
            title={mac ? `放大字号 ${formatShortcut(['Mod', '+'])}` : '放大字号'}
            aria-label="放大终端字号"
          >
            <Plus size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="terminal-header__btn"
            onClick={() => {
              xtermRef.current?.clear();
              xtermRef.current?.focus();
            }}
            title={mac ? `清空输出 ${formatShortcut(['Mod', 'K'])}` : '清空输出'}
            aria-label="清空终端"
          >
            <Eraser size={12} aria-hidden="true" />
          </button>
          {onClose && (
            <button
              type="button"
              className="terminal-header__btn"
              onClick={onClose}
              title="关闭终端"
              aria-label="关闭终端"
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {error && <div className="terminal-error" role="alert">终端启动失败：{error}</div>}
      <div ref={containerRef} className="terminal-container" />
    </section>
  );
}
