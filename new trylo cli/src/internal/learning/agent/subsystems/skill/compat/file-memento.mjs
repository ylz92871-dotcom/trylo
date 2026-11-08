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
// file reads as "empty memento" under the compatibility default. The internal
// worker selects fail_closed to preserve damaged deduplication evidence rather
// than silently spending another learning allowance. Failed writes reject.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_FILE_NAME = 'state-v1.json';
/** Mirrors learning-loop/learning-state.js STATE_KEY. */
export const LEGACY_STATE_KEY = 'tryloCode.learning.state';

export function stateFilePath(storageRoot) {
  return path.join(storageRoot, 'learning', STATE_FILE_NAME);
}

/**
 * @param {{ storageRoot: string, log?: (message: string) => void,
 *   corruptionPolicy?: 'legacy_reset'|'fail_closed' }} options
 *   `storageRoot` is `<app-data>/Trylo` (see hermes-env.mjs).
 */
export function createFileMemento({ storageRoot, log = null, corruptionPolicy = 'legacy_reset' } = {}) {
  if (corruptionPolicy !== 'legacy_reset' && corruptionPolicy !== 'fail_closed') throw new Error('Invalid memento corruption policy');
  const file = stateFilePath(storageRoot || '');
  // Serialized write queue: concurrent update() calls must not interleave
  // read-modify-write and lose the loser's state.
  let queue = Promise.resolve();

  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const corrupt = () => Object.assign(new Error('HERMES_LEARNING_STATE_CORRUPT'), { code: 'HERMES_LEARNING_STATE_CORRUPT' });
  function validate(map) {
    if (!record(map)) throw corrupt();
    if (!Object.prototype.hasOwnProperty.call(map, LEGACY_STATE_KEY)) return;
    const state = map[LEGACY_STATE_KEY];
    if (!record(state) || state.schemaVersion !== 1 || !record(state.workspaces)) throw corrupt();
    // The original v1 normalizer preserves existing workspace objects. Unlike
    // optional counters, this array is dereferenced directly by isHashProcessed.
    for (const workspace of Object.values(state.workspaces)) {
      if (!record(workspace) || !Array.isArray(workspace.processedEvidenceHashes)
        || workspace.processedEvidenceHashes.some(hash => typeof hash !== 'string')) throw corrupt();
    }
  }
  function decode(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (corruptionPolicy === 'fail_closed') throw corrupt();
      return {};
    }
    if (corruptionPolicy === 'fail_closed') validate(parsed);
    return record(parsed) ? parsed : {};
  }

  async function readAll() {
    try {
      return decode(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
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
      return decode(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
  }

  async function writeAll(map) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } finally {
      // A failed replacement must leave the last committed file intact.
      // An orphaned temp is not authoritative; cleanup must not mask the write error.
      try {
        await fs.rm(tmp, { force: true });
      } catch (err) {
        if (log) log(`learning memento: temp cleanup failed: ${err?.message ?? err}`);
      }
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
      const operation = queue.then(async () => {
        const map = await readAll();
        map[key] = value;
        if (corruptionPolicy === 'fail_closed') validate(map);
        await writeAll(map);
      });
      // Keep the serialization tail fulfilled while preserving this caller's
      // failure. Already queued writes must still run after a failed update.
      queue = operation.catch(() => {});
      try {
        await operation;
      } catch (err) {
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
