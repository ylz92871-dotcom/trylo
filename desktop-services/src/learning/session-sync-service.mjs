// Trylo Desktop Services — Hermes session mirror adapter. See migration spec
// §7.4 and architecture doc §6.4.
//
// Thin adapter over the vendored `hermes-session-sync.js`: it mirrors a
// Desktop `ConversationRecord` projection into the Hermes SessionDB index so
// `session_search` can recall past conversations.
//
// Ownership: Desktop owns the conversation; Hermes owns the index. The mirror
// is a rebuildable cache — losing it degrades recall, never correctness.
//
// Failure policy (mirrors the legacy module): a failed sync is reported to the
// logger and returned as `{ ok: false }`. It never blocks the user's main task
// (spec §7.4: 同步失败进入 diagnostics，不阻断). Detection anomalies are not
// retried blindly — the legacy module's per-session debounce and content hash
// skip decide that.

import { requireLegacyVendor } from './vendor-path.mjs';

/**
 * @param {{ storageRoot: string, log?: (message: string) => void,
 *            sync?: object|null }} options
 *   `storageRoot` is `<app-data>/Trylo` (see hermes-env.mjs).
 *   `sync` is a test seam only — production uses the vendored module.
 */
export function createSessionSyncService({ storageRoot, log = null, sync: injectedSync = null } = {}) {
  let sync = injectedSync;
  // Only flush an adapter we actually used: the shutdown path must not
  // require the legacy module just to tell it "nothing happened".
  let initialized = false;
  function legacy() {
    if (!sync) {
      sync = requireLegacyVendor('hermes-session-sync.js');
      sync.setLogger((message) => {
        if (log) log(String(message));
      });
    }
    initialized = true;
    return sync;
  }

  return {
    /**
     * Mirror one projected session (shape: spec §1 —
     * `{ id, title, workspace:{path}, model, turns:[{prompt,resultText,startedAt,events?}] }`).
     * Returns false when nothing needed mirroring (no id, or unchanged hash).
     */
    async syncSession(session) {
      if (!storageRoot) return { ok: false, mirrored: false, error: 'hermes storage root is not configured' };
      if (!session || !session.id) return { ok: true, mirrored: false };
      try {
        const mirrored = await legacy().mirrorSession(session, storageRoot);
        return { ok: true, mirrored: Boolean(mirrored) };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (log) log(`session sync failed: ${message}`);
        return { ok: false, mirrored: false, error: message };
      }
    },

    /** Rebuild the whole index from the given projected sessions. */
    async rebuild(sessions) {
      if (!storageRoot) return { ok: false, error: 'hermes storage root is not configured' };
      try {
        const result = await legacy().rebuildIndex(Array.isArray(sessions) ? sessions : [], storageRoot);
        return { ok: true, result: result ?? null };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (log) log(`session index rebuild failed: ${message}`);
        return { ok: false, error: message };
      }
    },

    /** Bounded flush on exit (spec §7.4: 退出有界 flush). */
    async shutdown() {
      if (!initialized) return { ok: true, stopped: false };
      try {
        sync.shutdown();
        return { ok: true, stopped: true };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (log) log(`session sync shutdown failed: ${message}`);
        return { ok: false, error: message };
      }
    },
  };
}
