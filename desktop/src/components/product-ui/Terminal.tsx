// Trylo Desktop — Terminal. See ARCHITECTURE.md §3 Phase 1
// Week 2 (Terminal).
//
// xterm.js frontend. We render the terminal in a div, spawn
// a PTY via hostAdapter.pty, and forward user keystrokes to
// the PTY's writer. The PTY's stdout is rendered via xterm's
// `write` method, fed by the onOutput callback in PtyService.
//
// The terminal mounts the xterm Terminal on first render, resizes
// it to fit the container via the FitAddon, and spawns the
// process lazily (only when the user opens the panel).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { hostAdapter } from '../../host-adapter';
import './Terminal.css';

export interface TerminalProps {
  /** Working directory the spawned shell starts in. */
  readonly cwd: string;
  readonly id: string;
  readonly onReturnFocus: () => void;
}

export function Terminal({ cwd, id, onReturnFocus }: TerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      fontFamily: 'SFMono-Regular, Menlo, Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0d1117' },
      cursorBlink: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    xterm.textarea?.setAttribute('aria-label', '终端输入，按 Shift+Escape 返回工具栏');
    fit.fit();
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.key !== 'Escape' || !event.shiftKey) return true;
      onReturnFocus();
      return false;
    });

    let ptyId: string | null = null;
    let alive = true;

    const handleResize = (): void => {
      try {
        fit.fit();
        if (ptyId) {
          void hostAdapter.pty.resize(ptyId, xterm.cols, xterm.rows);
        }
      } catch {
        // ignore — fit throws when container is hidden
      }
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);

    xterm.onData((data) => {
      if (ptyId) {
        void hostAdapter.pty.write(ptyId, new TextEncoder().encode(data));
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
        ptyId = result.id;
        xterm.writeln(`[Trylo terminal — ${result.shell}]`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (alive) setError(message);
      }
    })();

    return () => {
      alive = false;
      ro.disconnect();
      if (ptyId) void hostAdapter.pty.kill(ptyId);
      xterm.dispose();
    };
  }, [cwd, onReturnFocus]);

  return (
    <section className="terminal-panel" id={id} aria-label="集成终端">
      {error && <div className="terminal-error" role="alert">终端启动失败：{error}</div>}
      <div ref={containerRef} className="terminal-container" />
    </section>
  );
}
