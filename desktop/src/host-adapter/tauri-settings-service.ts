// Trylo Desktop — TauriSettingsService. Bridges the settings
// Tauri commands to the SettingsService interface. Returns the
// parsed AppSettings (the Rust side returns a JSON string to
// sidestep the Tauri 2 IPC codec hang on custom struct returns
// we hit on Day 1).

import { invoke } from '@tauri-apps/api/core';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsService,
} from './settings-service';
import type { FilePath } from './types';

export const tauriSettingsService: SettingsService = {
  async get(workspaceRoot: FilePath) {
    const json = await invoke<string>('get_settings', { workspaceRoot });
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(json) } as AppSettings;
    } catch {
      // The Rust side already returns defaults on parse failure,
      // so a real parse error here means the IPC returned
      // something unexpected. Fall back to defaults.
      return DEFAULT_SETTINGS;
    }
  },
  async set(workspaceRoot: FilePath, settings: AppSettings) {
    await invoke('set_settings', { workspaceRoot, json: JSON.stringify(settings) });
  },
};
