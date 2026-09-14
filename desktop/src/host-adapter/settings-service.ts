// Trylo Desktop — SettingsService interface. See ARCHITECTURE.md
// §3 Phase 1 #8 (Settings UI).
//
// Single source of truth: the workspace's
// `.trylo/settings.json`. Reads are forgiving (missing file or
// malformed JSON returns defaults). Writes are atomic-ish
// (write the file in one go). The TS interface is a thin
// wrapper around the two Tauri commands; tests can mock it.

import type { FilePath } from './types';

export type Theme = 'auto' | 'light' | 'dark';

export interface AppSettings {
  readonly theme: Theme;
  readonly fontSize: number;
  readonly tabSize: number;
  readonly wordWrap: boolean;
  readonly showLineNumbers: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  fontSize: 13,
  tabSize: 4,
  wordWrap: false,
  showLineNumbers: true,
};

export interface SettingsService {
  get(workspaceRoot: FilePath): Promise<AppSettings>;
  set(workspaceRoot: FilePath, settings: AppSettings): Promise<void>;
}
