// Trylo Desktop — native OS alert/confirm dialog wrapper.
//
// Uses @tauri-apps/plugin-dialog (`ask` / `message`, rendered as macOS NSAlert
// sheets when inside Tauri) and degrades cleanly to browser `confirm` / `alert`
// in dev/Vitest environments.

import { isTauri } from './tauri-detect';

export type NativeDialogKind = 'info' | 'warning' | 'error';

export interface NativeConfirmOptions {
  readonly title?: string;
  readonly message: string;
  readonly kind?: NativeDialogKind;
  readonly okLabel?: string;
  readonly cancelLabel?: string;
}

export interface NativeAlertOptions {
  readonly title?: string;
  readonly message: string;
  readonly kind?: NativeDialogKind;
  readonly okLabel?: string;
}

export async function confirmNativeDialog(options: NativeConfirmOptions): Promise<boolean> {
  if (isTauri()) {
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      return await ask(options.message, {
        ...(options.title ? { title: options.title } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.okLabel ? { okLabel: options.okLabel } : {}),
        ...(options.cancelLabel ? { cancelLabel: options.cancelLabel } : {}),
      });
    } catch {
      // Fallback below if dialog plugin is unavailable in a mocked host.
    }
  }

  return typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? window.confirm(options.message)
    : false;
}

export async function alertNativeDialog(options: NativeAlertOptions): Promise<void> {
  if (isTauri()) {
    try {
      const { message } = await import('@tauri-apps/plugin-dialog');
      await message(options.message, {
        ...(options.title ? { title: options.title } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.okLabel ? { okLabel: options.okLabel } : {}),
      });
      return;
    } catch {
      // Fallback below if dialog plugin is unavailable in a mocked host.
    }
  }

  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(options.message);
  }
}
