'use strict';

/*
 * proposal-tracker.js
 *
 * Narrow, single source of truth for Hermes proposal detection during a
 * Trylo run. Memory proposals come from the foreground Agent/Office
 * via memory_propose. Skill proposals come from the L0 Skill learning
 * run via skill_propose. The production `structuredMessage` hook feeds
 * events; the foreground finalizer and the L0 result writer consume
 * the captured result.
 *
 * 09 §4 P0-1 + 09 §5.4 + 11 §3 A1: the only parser used by the
 * production hook. Tests must NOT replicate this logic; they construct
 * a real tracker instance and feed it real structured fixtures.
 *
 * Hard rules (11 §3 A1):
 *   - Tool name whitelist is per-kind. Only EXACT names are accepted.
 *     memory_propose is fed into the memory slot; skill_propose is
 *     fed into the skill slot.
 *   - The exact full MCP names are also accepted:
 *       mcp__<configured-server-name>__<exact-tool-name>
 *   - All other shapes are REJECTED, including:
 *       - bare <server>__memory_propose (missing mcp__ prefix)
 *       - any endsWith('__memory_propose') or endsWith('__skill_propose')
 *       - anything derived from natural language or tool result text
 *   - Multiple distinct IDs in the same slot set that slot's
 *     conflict flag; `consumeKind(kind)` returns { conflict: true }
 *     and the caller must fail closed.
 *   - The tracker stores ONLY the pendingId, capturedAt, source, and
 *     a conflict marker per slot. Proposal content (before/after/
 *     operations) is NEVER persisted here.
 *   - `consumeKind()` is one-shot per slot.
 *
 * Usage:
 *   const tracker = ProposalTracker.createForServers({
 *     memory: 'trylo-hermes-capabilities',  // normal profile server
 *     skill:   'trylo-hermes-learning',      // learning profile server
 *   });
 *   createRequestHooks().structuredMessage(msg) -> tracker.ingestStructuredEvent(msg)
 *   tracker.consumeKind('memory') -> { ok, pendingId } or { conflict: true } or null
 */

const MEMORY_EXACT = 'memory_propose';
const SKILL_EXACT = 'skill_propose';
const MCP_PREFIX = 'mcp__';
const SUFFIX = '__'; // mcp__<server>__<tool>

const _fullName = (server, exact) => MCP_PREFIX + server + SUFFIX + exact;

function _buildAllowedNamesForKind(configuredServerName, exact) {
  // 11 §3 A1: accept bare exact name (when CLI returns the tool
  // address without the mcp__ prefix because of a different
  // output format) AND accept the exact full MCP name. Reject
  // every other shape including bare <server>__<tool>.
  const out = new Set([exact]);
  if (configuredServerName && typeof configuredServerName === 'string') {
    out.add(_fullName(configuredServerName, exact));
  }
  return out;
}

class ProposalTracker {
  /**
   * @param {object} opts
   * @param {string} [opts.memoryServer]  - configured normal-profile server name
   * @param {string} [opts.skillServer]    - configured learning-profile server name
   */
  constructor(opts = {}) {
    this._memoryNames = _buildAllowedNamesForKind(opts.memoryServer, MEMORY_EXACT);
    this._skillNames = _buildAllowedNamesForKind(opts.skillServer, SKILL_EXACT);
    this._toolUseIndex = new Map(); // tool_use_id -> kind
    this._slots = {
      memory: { captured: null, conflict: false, seen: new Set() },
      skill: { captured: null, conflict: false, seen: new Set() },
    };
  }

  /**
   * 11 §3 A3: the production hook is the only consumer. Exposing
   * this small helper lets tests drive the SAME parser without
   * touching createRequestHooks or its VS Code dependencies.
   */
  static createForServers({ memoryServer, skillServer } = {}) {
    return new ProposalTracker({ memoryServer, skillServer });
  }

  reset() {
    this._toolUseIndex.clear();
    for (const k of Object.keys(this._slots)) {
      this._slots[k].captured = null;
      this._slots[k].conflict = false;
      this._slots[k].seen.clear();
    }
  }

  /**
   * 11 §3 A3: a structured event parser that is shared between the
   * production hook and tests. The production hook calls this once
   * per `structuredMessage`. Tests can call it directly with the
   * SAME raw event the CLI sends.
   */
  ingestStructuredEvent(message) {
    if (!message || typeof message !== 'object') return;
    const type = String(message.type || '').trim();
    if (type === 'content_block_start' && message.content_block &&
        message.content_block.type === 'tool_use') {
      this.ingestToolUse(message.content_block.id, message.content_block.name);
      return;
    }
    if (type === 'user' || type === 'tool_result' ||
        type === 'content_block_stop' || type === 'assistant') {
      this.ingestToolResult(message);
    }
  }

  /**
   * Record a tool_use event. Production hook calls this for each
   * `content_block_start` whose `content_block.type === 'tool_use'`.
   * Unknown tool names are silently ignored.
   */
  ingestToolUse(toolUseId, name) {
    if (!toolUseId || typeof toolUseId !== 'string') return;
    if (!name || typeof name !== 'string') return;
    let kind = null;
    if (this._memoryNames.has(name)) kind = 'memory';
    else if (this._skillNames.has(name)) kind = 'skill';
    if (kind) this._toolUseIndex.set(String(toolUseId), kind);
  }

  /**
   * Record a tool_result event. The production hook calls this when
   * it sees a `user`/`tool_result`/`content_block_stop` message that
   * contains a tool_result content block. `message` is the raw
   * structured message (the SAME shape the CLI sends).
   */
  ingestToolResult(message) {
    if (!message || typeof message !== 'object') return;
    const blocks = Array.isArray(message.content)
      ? message.content.filter(b => b && typeof b === 'object')
      : (Array.isArray(message.message && message.message.content)
          ? message.message.content.filter(b => b && typeof b === 'object')
          : []);
    for (const block of blocks) {
      if (String(block.type || '') !== 'tool_result') continue;
      const toolUseId = String(block.tool_use_id || block.toolUseId || '');
      if (!toolUseId) continue;
      const kind = this._toolUseIndex.get(toolUseId);
      if (!kind) continue;
      const pendingId = _extractPendingId(block.content);
      if (!pendingId) continue;
      const slot = this._slots[kind];
      slot.seen.add(pendingId);
      if (slot.seen.size > 1) {
        slot.conflict = true;
        continue;
      }
      slot.captured = {
        pendingId: String(pendingId),
        capturedAt: Date.now(),
        source: 'structured',
      };
    }
  }

  /**
   * Read-and-clear the captured result for one kind. Returns:
   *   { ok: true, pendingId, capturedAt, source } on success
   *   { ok: false, conflict: true, observed: [...] } when the run had
   *     multiple distinct IDs in that kind (caller must fail closed)
   *   null when nothing was captured
   */
  consumeKind(kind) {
    const slot = this._slots[kind];
    if (!slot) return null;
    if (slot.conflict) {
      return { ok: false, conflict: true, observed: Array.from(slot.seen) };
    }
    if (!slot.captured) return null;
    const c = slot.captured;
    slot.captured = null;
    return { ok: true, pendingId: c.pendingId, capturedAt: c.capturedAt, source: c.source };
  }
}

function _extractPendingId(content) {
  let parsed = null;
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content); } catch { parsed = null; }
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = part.text || part.content;
      if (typeof text === 'string') {
        try { parsed = JSON.parse(text); break; } catch { parsed = null; }
      }
    }
  } else if (content && typeof content === 'object') {
    parsed = content;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.success || !parsed.staged || !parsed.pending_id) return null;
  return String(parsed.pending_id);
}

module.exports = {
  ProposalTracker,
  // Aliases: keep both the new short names and the old `_NAME` suffix
  // so existing smoke and extension code can import either.
  MEMORY_EXACT,
  MEMORY_EXACT_NAME: MEMORY_EXACT,
  SKILL_EXACT,
  SKILL_EXACT_NAME: SKILL_EXACT,
  MCP_PREFIX,
  _fullName,
};
