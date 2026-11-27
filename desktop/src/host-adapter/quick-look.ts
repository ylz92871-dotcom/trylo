import { invoke } from '@tauri-apps/api/core';
import { isMacPlatform } from '../utils/platform';
import { isTauri } from './tauri-detect';

export function supportsQuickLook(): boolean {
  return isMacPlatform() && isTauri();
}

export function quickLookFile(filePath: string, allowedRoot: string): Promise<void> {
  return invoke('quick_look_open', { filePath, allowedRoot });
}
