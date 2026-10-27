import { invoke } from '@tauri-apps/api/core';
import type { CliSessionStorage, CliSessionWrite } from '../runtime/cli-session-store';

export const runtimeSessionsStorage: CliSessionStorage = {
  load: workspaceRoot => invoke<string | null>('runtime_sessions_load', { workspaceRoot }),
  save: (workspaceRoot, expected, json) => invoke<CliSessionWrite>('runtime_sessions_save', { workspaceRoot, expected, json }),
};
