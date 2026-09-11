// Trylo Desktop Services — pet chat history store.
//
// Ported from the legacy extension's readDesktopChatMessages /
// writeDesktopChatMessages (extension.js ~6712-6760) per migration spec
// §6.4. File shape `{ version: 1, savedAt, messages }` and the sanitize
// semantics are unchanged; the location moves to the Desktop app-data root
// the Tauri shell injects via TRYLO_APP_DATA_DIR. The legacy per-workspace
// sha1 file split is dropped on purpose: the service host serves exactly
// one workspace per process (deviation recorded in the migration PR).

import fs from 'node:fs/promises';
import path from 'node:path';

import { sanitizeDesktopChatMessages } from './chat-limits.mjs';

/** `<appDataDir>/Trylo/companion/desktop-chat.json`; '' when no root. */
export function desktopChatStorageFilePath(appDataDir) {
  const root = String(appDataDir || '').trim();
  if (!root) return '';
  return path.join(root, 'Trylo', 'companion', 'desktop-chat.json');
}

export function createChatStore(appDataDir) {
  const filePath = desktopChatStorageFilePath(appDataDir);

  return {
    get filePath() {
      return filePath;
    },

    /** Sanitized history ([] when the file is missing/corrupt — legacy
     *  semantics: a broken file never fails a chat turn). */
    async read() {
      if (!filePath) return [];
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return sanitizeDesktopChatMessages(parsed && parsed.messages);
      } catch {
        return [];
      }
    },

    /** Sanitizes, then persists atomically-shaped JSON. Returns whether a
     *  write actually happened (false when no app-data root is set). */
    async write(messages) {
      if (!filePath) return false;
      const sanitized = sanitizeDesktopChatMessages(messages);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, savedAt: Date.now(), messages: sanitized }, null, 2),
        'utf8',
      );
      return true;
    },
  };
}
