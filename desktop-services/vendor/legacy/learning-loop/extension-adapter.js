'use strict';

/*
 * extension-adapter.js
 *
 * Narrow, testable helpers extracted from extension.js production logic.
 * No VS Code dependencies — pure functions operating on plain objects.
 *
 * Exports:
 *   isSuccessfulRawToolEvent(rawEvent)            — raw event filter (phase=completed/done, level=success)
 *   isSuccessfulPersistedTurnEvent(turnEvent)     — persisted event filter (status=done)
 *   recoverLearningSourceEvidence(sessions, ref)  — precise source turn recovery
 *   isSuccessToolEvent(event)                     — DEPRECATED alias for isSuccessfulRawToolEvent
 *
 * 04_LEARNING_L0_FINAL_AUDIT_FIX §2.1:
 *   raw events have phase/level; persisted turn events only have status=done/running/error/waiting.
 *   recoverLearningSourceEvidence must use the persisted filter.
 */

const EVENT_CATEGORY_ALLOWLIST = new Set([
  'search', 'read', 'edit', 'write', 'command', 'tool', 'verify', 'test',
]);

const VERIFY_CATEGORIES = new Set(['verify', 'test']);

/**
 * Check if a RAW tool event (from the event stream) should be counted
 * as a successful terminal event.
 *
 * Raw events have: category, phase, level, id fields.
 * A successful terminal event has level='success' and phase='completed' or 'done'.
 *
 * @param {object} event - raw event with category, phase, level, id fields
 * @returns {boolean}
 */
function isSuccessfulRawToolEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const category = String(event.category || '').toLowerCase().trim();
  if (!EVENT_CATEGORY_ALLOWLIST.has(category)) return false;
  const level = String(event.level || '').toLowerCase();
  const phase = String(event.phase || '').toLowerCase();
  if (level !== 'success') return false;
  if (phase !== 'completed' && phase !== 'done') return false;
  // 04 §2.1: reject events without a stable ID — no pseudo-ID from title/time.
  if (!event.id || typeof event.id !== 'string' || !event.id.trim()) return false;
  return true;
}

/**
 * Check if a PERSISTED turn event (from session.turns[].events[]) should be
 * counted as a successful terminal event.
 *
 * Persisted events have: id, kind, category, title, status, at, updatedAt.
 * Status is normalized to 'done' | 'running' | 'error' | 'waiting'.
 * A successful persisted event has status='done' and a stable id.
 *
 * @param {object} event - persisted turn event with status field
 * @returns {boolean}
 */
function isSuccessfulPersistedTurnEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const category = String(event.category || '').toLowerCase().trim();
  if (!EVENT_CATEGORY_ALLOWLIST.has(category)) return false;
  const status = String(event.status || '').toLowerCase();
  if (status !== 'done') return false;
  // Must have a stable ID
  if (!event.id || typeof event.id !== 'string' || !event.id.trim()) return false;
  return true;
}

/**
 * DEPRECATED alias — use isSuccessfulRawToolEvent instead.
 * Kept for backward compatibility with existing imports.
 */
const isSuccessToolEvent = isSuccessfulRawToolEvent;

/**
 * Recover learning source evidence from a precise session/turn pair.
 *
 * Uses isSuccessfulPersistedTurnEvent (NOT the raw event filter) because
 * turn.events are sanitized and no longer have phase/level fields.
 *
 * @param {Array} sessions - session array (e.g. globalSessionsCache)
 * @param {{ sessionId: string, turnId: string }} ref
 * @returns {{ ok: true, taskGoal: string, resultSummary: string, events: Array,
 *            fileHints: string[], verification: string[] }
 *        | { ok: false, error: string }}
 */
function recoverLearningSourceEvidence(sessions, ref) {
  if (!Array.isArray(sessions)) {
    return { ok: false, error: 'sessions is not an array' };
  }
  if (!ref || !ref.sessionId || !ref.turnId) {
    return { ok: false, error: 'ref missing sessionId or turnId' };
  }

  const session = sessions.find(s => s && s.id === ref.sessionId);
  if (!session) {
    return { ok: false, error: `session not found: ${ref.sessionId}` };
  }

  if (!Array.isArray(session.turns)) {
    return { ok: false, error: `session ${ref.sessionId} has no turns` };
  }

  const turn = session.turns.find(t => t && t.id === ref.turnId);
  if (!turn) {
    return { ok: false, error: `turn not found: ${ref.turnId} in session ${ref.sessionId}` };
  }

  if (turn.status !== 'success') {
    return { ok: false, error: `turn ${ref.turnId} status is ${turn.status}, expected success` };
  }

  const prompt = String(turn.prompt || '').trim();
  if (!prompt) {
    return { ok: false, error: `turn ${ref.turnId} has empty prompt` };
  }

  const resultText = String(turn.resultText || '').trim();
  if (!resultText) {
    return { ok: false, error: `turn ${ref.turnId} has empty resultText` };
  }

  // Filter successful PERSISTED tool events from turn.events.
  // 04 §2.1: Use isSuccessfulPersistedTurnEvent, not the raw event filter.
  const events = [];
  if (Array.isArray(turn.events)) {
    const seenIds = new Set();
    for (const e of turn.events) {
      if (!isSuccessfulPersistedTurnEvent(e)) continue;
      const stableId = String(e.id);
      if (seenIds.has(stableId)) continue;
      seenIds.add(stableId);
      events.push({
        id: stableId,
        category: String(e.category || '').toLowerCase().trim(),
        title: String(e.title || e.category || '').slice(0, 200),
        status: 'done',
      });
    }
  }

  // Extract file hints from persisted turn events meta
  const fileHints = [];
  if (Array.isArray(turn.events)) {
    for (const e of turn.events) {
      if (!isSuccessfulPersistedTurnEvent(e)) continue;
      if (e.meta && typeof e.meta === 'object') {
        const hint = String(e.meta.filePath || e.meta.file_path || e.meta.path || '');
        if (hint && fileHints.length < 40) {
          fileHints.push(hint);
        }
      }
    }
  }

  // Generate verification summary from persisted verify/test done events.
  // 04 §2.1: From persisted verify/test done event, generate limited verification summary.
  const verification = [];
  if (Array.isArray(turn.events)) {
    for (const e of turn.events) {
      if (!isSuccessfulPersistedTurnEvent(e)) continue;
      const cat = String(e.category || '').toLowerCase().trim();
      if (!VERIFY_CATEGORIES.has(cat)) continue;
      const title = String(e.title || '').slice(0, 200);
      if (title) verification.push(title);
    }
  }

  return {
    ok: true,
    taskGoal: prompt,
    resultSummary: resultText,
    events,
    fileHints,
    verification,
  };
}

module.exports = {
  EVENT_CATEGORY_ALLOWLIST,
  isSuccessfulRawToolEvent,
  isSuccessfulPersistedTurnEvent,
  isSuccessToolEvent, // deprecated alias
  recoverLearningSourceEvidence,
};
