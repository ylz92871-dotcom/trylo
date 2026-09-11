// Trylo Desktop Services — file-backed Memento for the legacy learning state.
// See migration spec §7.2 and architecture doc §6.2.
//
// `learning-loop/learning-state.js` only needs the VS Code Memento shape
// `{ get(key, default?), update(key, value) }` under the single key
// `tryloCode.learning.state`. We implement exactly that shape over one JSON
// file — there is deliberately NO second schema: the blob is the legacy
// state object verbatim (spec §7.2: 不新建第二套 schema; arch §6.2).
//
// Ownership: this file is the sole writer of
// <app-data>/Trylo/learning/state-v1.json. Hermes owns its own files under
// <app-data>/Trylo/hermes-capabilities/v1.
//
// Failure policy: writes are atomic (temp file + rename) and serialized, so a
// crash mid-write can never leave a truncated state file. A missing or corrupt
// file reads as "empty memento" and the legacy normalizer rebuilds defaults;
// a failed write rejects so the caller can record it (never silently drops).

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_FILE_NAME = 'state-v1.json';
/** Mirrors learning-loop/learning-state.js STATE_KEY. */
export const LEGACY_STATE_KEY = 'tryloCode.learning.state';

export function stateFilePath(storageRoot) {
  return path.join(storageRoot, 'learning', STATE_FILE_NAME);
}

/**
 * @param {{ storageRoot: string, log?: (message: string) => void }} options
 *   `storageRoot` is `<app-data>/Trylo` (see hermes-env.mjs).
 */
export function createFileMemento({ storageRoot, log = null } = {}) {
  const file = stateFilePath(storageRoot || '');
  // Serialized write queue: concurrent update() calls must not interleave
  // read-modify-write and lose the loser's state.
  let queue = Promise.resolve();

  async function readAll() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return {};
      throw err;
    }
  }

  // VS Code's Memento.get() is synchronous, and the reused
  // learning-loop/learning-state.js intentionally relies on that contract.
  // Keep a synchronous read path for get(); update() remains async + atomic.
  // Reading during an atomic rename sees either the previous complete file or
  // the next complete file, never the temporary partial write.
  function readAllSync() {
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return {};
      throw err;
    }
  }

  async function writeAll(map) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      // Windows: rename over an existing file can transiently fail; retry once
      // after removing the target so we never leave a half state behind.
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
    }
  }

  return {
    /** Memento.get(key, defaultValue). */
    get(key, defaultValue = undefined) {
      if (!storageRoot) return defaultValue;
      const map = readAllSync();
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : defaultValue;
    },

    /** Memento.update(key, value). Serialized + atomic. */
    async update(key, value) {
      if (!storageRoot) {
        const message = 'learning memento: storageRoot is not configured';
        if (log) log(message);
        throw new Error(message);
      }
      queue = queue.then(async () => {
        const map = await readAll();
        map[key] = value;
        await writeAll(map);
      });
      try {
        await queue;
      } catch (err) {
        queue = Promise.resolve();
        if (log) log(`learning memento: write failed: ${err && err.message ? err.message : err}`);
        throw err;
      }
    },

    /** Diagnostics only: where this memento persists. */
    get filePath() {
      return file;
    },
  };
}
