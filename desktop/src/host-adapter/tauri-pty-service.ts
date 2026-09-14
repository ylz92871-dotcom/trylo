// Trylo Desktop — PtyService impl backed by Tauri IPC. See
// host-adapter/pty-service.ts and ARCHITECTURE.md §3 Phase 1
// Week 2 (Terminal).

import { Channel, invoke } from '@tauri-apps/api/core';
import type { PtyService, PtySpawnResult } from './pty-service';

export const tauriPtyService: PtyService = {
  async spawn({ shell, cols, rows, cwd, onOutput }) {
    const channel = new Channel<number[]>();
    channel.onmessage = (data) => {
      onOutput(new Uint8Array(data));
    };
    const result = await invoke<PtySpawnResult>('pty_spawn', {
      shell,
      cols,
      rows,
      cwd,
      onOutput: channel,
    });
    return result;
  },
  write: (id, data) => invoke<void>('pty_write', { id, data: Array.from(data) }),
  resize: (id, cols, rows) => invoke<void>('pty_resize', { id, cols, rows }),
  kill: (id) => invoke<void>('pty_kill', { id }),
};
