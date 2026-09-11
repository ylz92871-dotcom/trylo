// Trylo Desktop — PtyService interface. See the architecture doc §3
// Phase 1 Week 2 (Terminal).
//
// The Tauri channel is the primitive for PTY output (arch doc
// §2.2). The shell's bytes flow Rust → JS through a Channel<Vec<u8>>.
// User keystrokes go JS → Rust via plain invoke() calls
// (pty_write). pty_resize and pty_kill complete the lifecycle.

export interface PtySpawnResult {
  readonly id: string;
  readonly shell: string;
}

export interface PtyService {
  spawn(opts: {
    shell: string;
    cols: number;
    rows: number;
    cwd: string | null;
    onOutput: (data: Uint8Array) => void;
  }): Promise<PtySpawnResult>;
  write(id: string, data: Uint8Array): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
}
