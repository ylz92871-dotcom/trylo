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

const DEFAULT_SHELL = 'bash.exe';

export interface TerminalProps {
  /** Working directory the spawned shell starts in. */
  readonly cwd: string;
}

export function Terminal({ cwd }: TerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0d1117' },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(container);
    fit.fit();
    xtermRef.current = xterm;
    fitRef.current = fit;

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
          shell: DEFAULT_SHELL,
          cols: xterm.cols,
          rows: xterm.rows,
          cwd,
          onOutput: (data) => {
            // Tauri serializes Vec<u8> as a JSON array of numbers.
            // xterm.write accepts string or Uint8Array; build the
            // Uint8Array from the array.
            if (alive) xterm.write(new Uint8Array(data));
          },
        });
        ptyId = result.id;
        ptyIdRef.current = result.id;
        xterm.writeln(`\x1b[90m[Trylo terminal — ${result.shell}]\x1b[0m`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (alive) {
          xterm.writeln(`\x1b[31m[pty spawn failed: ${message}]\x1b[0m`);
          setError(message);
        }
      }
    })();

    return () => {
      alive = false;
      ro.disconnect();
      if (ptyIdRef.current) {
        void hostAdapter.pty.kill(ptyIdRef.current);
        ptyIdRef.current = null;
      }
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [cwd]);

  return (
    <div className="terminal-panel">
      {error && <div className="terminal-error">error: {error}</div>}
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}
