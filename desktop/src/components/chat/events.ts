// Trylo Desktop — event → message reducer.
//
// v1.14: the trylo CLI emits 28 typed events (per
// the CLI event vocabulary spec). This
// reducer maps each event to a typed ChatMessage. The
// pure function is tested in events.test.ts against the
// 39-event hand-crafted trylo-complex fixture (6 turns,
// sub-agents, compaction).
//
// v1.15.7: borrowed from cline's ChatRow — only the
// events that should appear in the chat are rendered.
// Lifecycle / bookkeeping events (session_start,
// turn_start/end, loop_end, subagent, compaction, …)
// are silently dropped here. The user said "不是所有
// 的事件都要展示". Phase 3 can surface them in a
// dedicated debug panel.

import type { ChatMessage, ToolMessage, ThinkingMessage, TextMessage, TurnMessage, CompactionMessage, SubagentMessage } from './types';
import type {
  LoopEvent,
  ToolUseEvent,
  ToolResultEvent,
  ThinkingEvent,
  TextEvent,
  TurnEndEvent,
  CompactEvent,
  CompactionTriggerEvent,
  SubagentEvent,
} from '../../host-adapter/loop-events';
import { toPersistedToolResultContent } from '../../tooling/tool-result-content';
import { isTeamSeatId } from '../../surfaces/shared/seats';

let _nextId = 0;
function nextId(prefix: string): string {
  _nextId += 1;
  return `${prefix}-${_nextId}`;
}

function toolSummary(e: ToolUseEvent): string {
  const input = e.input;
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  switch (e.tool) {
    case 'Bash':  return String(obj['command'] ?? '').slice(0, 80);
    case 'Read':  return String(obj['file_path'] ?? '');
    case 'Edit':  return String(obj['file_path'] ?? '');
    case 'Write': return String(obj['file_path'] ?? '');
    case 'Grep':  return String(obj['pattern'] ?? '');
    default:      return JSON.stringify(input).slice(0, 80);
  }
}

/** Streaming snapshots can arrive out of order when a throttled event and a
 * final event cross. Never replace a longer in-place value with a shorter
 * partial snapshot; that was the visible "sentence gets cut off" defect. */
function mergePartialSnapshot(previous: string, incoming: string, partial: boolean): string {
  if (!partial || previous.length === 0) return incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  return incoming.length >= previous.length ? incoming : previous;
}

/** Avoid painting the first two or three tokens as a standalone thought and
 * replacing them immediately with a full phrase. We still stream once there
 * is a readable clause; short completed blocks are emitted by their final
 * non-partial event, so no content is lost. */
function isReadablePartial(text: string): boolean {
  const trimmed = text.trim();
  if (/[。！？.!?\n]/.test(trimmed)) return true;
  return trimmed.replace(/\s+/g, '').length >= 18;
}

function applyThinking(msgs: ChatMessage[], e: ThinkingEvent): ChatMessage[] {
  if (e.partial === true && !isReadablePartial(e.preview || e.summary)) return msgs;
  // v1.15.9.e: handle thinking as a STREAM within a
  // single thinking block, but CREATE A NEW thinking
  // message when a new thinking block starts.
  //
  // "Adjacent" = no tool or text event between the last
  // message and the new thinking. Mid-stream thinking
  // deltas are adjacent (they update the last thinking).
  // A new thinking phase (after tools or text) is not
  // adjacent (it creates a new thinking).
  //
  // This gives the user a fluid flow:
  //   thinking1 → tool1, tool2 → thinking2 → tool3, tool4
  // Each "phase" gets its own thinking message. Without
  // this, the reducer would merge all thinkings in a
  // turn into a single message and the user would only
  // see the last thinking's content.
  //
  // v1.16.4: first non-empty thinking event for a turn
  // freezes the user message's `finalElapsedMs` (so the
  // TurnProgress row transitions from spinning +
  // counting to "已工作 0:12" forever). The user
  // message's `turnStartedAt` is the anchor; we compute
  // elapsed at the moment of first output, never again.
  const lastUserIdx = lastUserIndex(msgs);
  // v1.16.4: stamp turnId on every new event from the
  // current user message's id. Phase boundaries in
  // MessageList are keyed on this — events arriving in
  // batch order no longer misplace the thinking block.
  const turnId = lastUserIdx >= 0 ? msgs[lastUserIdx]?.id : undefined;
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    const m = msgs[i];
    if (!m) break;
    if (m.kind === 'thinking') {
      // Adjacent thinking found — update it (stream
      // continuation of the same phase).
      const updated: ThinkingMessage = {
        ...m,
        summary: mergePartialSnapshot(m.summary, e.summary, e.partial === true),
        preview: mergePartialSnapshot(m.preview, e.preview, e.partial === true),
        fullLength: Math.max(m.fullLength, e.fullLength),
        // Always use the latest partial flag from the
        // translator. While the model is streaming, the
        // flag is true and the card auto-expands; when
        // the model is done, the flag becomes false and
        // the card stays open.
        partial: e.partial ?? m.partial,
        createdAt: e.ts,
      };
      return [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)];
    }
    if (m.kind === 'tool' || m.kind === 'text') {
      // Hit a non-thinking message — the new thinking is
      // not adjacent to the previous thinking. It's a
      // new phase; create a new message below.
      break;
    }
  }
  // No adjacent thinking, create new (new thinking phase)
  // v1.16.4: first output for this turn? Freeze the
  // user message's finalElapsedMs now. The TurnProgress
  // row will switch from spinner to static on the next
  // render. The check is "no prior assistant text/
  // thinking in this turn" — if any of those exist,
  // we're past the first-output moment.
  const hasOutputInThisTurn = hasAssistantOutputInTurn(msgs, lastUserIdx);
  let next = msgs;
  if (!hasOutputInThisTurn) {
    next = freezeTurnTimer(next, lastUserIdx, e.ts);
  }
  const t: ThinkingMessage = {
    id: nextId('thinking'),
    // v1.16.5+ (spec §5.2): a new phase gets a fresh
    // stable phaseId. Adjacent thinking deltas update the
    // same card (and keep this id); a new thinking after
    // tools/text creates a new phase + new id.
    phaseId: nextId('phase'),
    kind: 'thinking',
    role: 'assistant',
    createdAt: e.ts,
    summary: e.summary,
    preview: e.preview,
    fullLength: e.fullLength,
    partial: e.partial ?? false,
    turn: e.turn,
    turnId,
  };
  return [...next, t];
}

/** v1.16.5+ (spec §5.2): the phaseId a tool belongs to.
 *  A tool inherits the phase of the nearest message that
 *  already carries a phaseId (its thinking, or a sibling
 *  tool that ran without any preceding thinking); when
 *  none exists yet it opens a fresh phase. Scanning is
 *  scoped to the current turn (`lastUserIdx`). */
function phaseIdOf(
  msgs: readonly ChatMessage[],
  lastUserIdx: number,
): string {
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    const m = msgs[i];
    if (!m) continue;
    // An assistant text block is a visible document boundary. A tool that
    // starts after it belongs to a new process phase so the timeline stays
    // chronological:
    //   reasoning -> announcement -> tool phase -> final answer
    // Previously we skipped across the announcement and inherited the old
    // phase id. MessageList then hoisted the tool into the earlier process
    // card, which made artifact construction appear to have no process block.
    if (m.kind === 'text' && m.role === 'assistant') break;
    if (m.phaseId !== undefined) return m.phaseId;
  }
  return nextId('phase');
}

/** Find the index of the last user message in `msgs`,
 *  or -1 if there is no user message yet. The boundary
 *  is the source of truth for "which turn does an
 *  incoming event belong to?". Used by applyText and
 *  applyThinking to scope in-place updates to the
 *  current turn only — preventing a late event from
 *  a previous spawn from overwriting the new turn. */
function lastUserIndex(msgs: readonly ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i]!.kind === 'text' && msgs[i]!.role === 'user') {
      return i;
    }
  }
  return -1;
}

// v1.16.4: per-turn freeze helpers. Cline's pattern —
// each user turn has its own `turnStartedAt` and (once
// the first model output arrives) its own
// `finalElapsedMs` on the user message itself. There is
// no top-level "current turn" state to lose or reset.
// See Cline's RequestStartRow + ClineApiReqInfo.cost
// (the "done" state). Trylo's analogue is "first
// non-empty thinking or text event for a turn".

/** Has the model already produced any visible output
 *  (thinking or text) in the current turn? Used to
 *  detect "this is the first output event" — the
 *  moment we freeze the TurnProgress timer. */
function hasAssistantOutputInTurn(
  msgs: readonly ChatMessage[],
  lastUserIdx: number,
): boolean {
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.kind === 'thinking' || (m.kind === 'text' && m.role === 'assistant')) {
      return true;
    }
  }
  return false;
}

/** Compute and stamp `finalElapsedMs` on the user
 *  message that started the current turn. Idempotent
 *  if already set (we don't overwrite a frozen
 *  value). Returns the (possibly unchanged) array.
 *  Pure — no React state. */
function freezeTurnTimer(
  msgs: readonly ChatMessage[],
  lastUserIdx: number,
  nowTs: number,
): ChatMessage[] {
  if (lastUserIdx < 0) return [...msgs];
  const u = msgs[lastUserIdx];
  if (!u || u.kind !== 'text' || u.role !== 'user') return [...msgs];
  if (u.finalElapsedMs !== undefined) return [...msgs];
  const started = u.turnStartedAt;
  if (started === undefined) return [...msgs];
  const elapsed = Math.max(0, nowTs - started);
  const updated: TextMessage = { ...u, finalElapsedMs: elapsed };
  const out: ChatMessage[] = [...msgs];
  out[lastUserIdx] = updated;
  return out;
}

export function finalizeLatestTurnTimer(
  msgs: readonly ChatMessage[],
  nowTs: number = Date.now(),
): ChatMessage[] {
  return freezeTurnTimer(msgs, lastUserIndex(msgs), nowTs);
}

function applyText(msgs: ChatMessage[], e: TextEvent): ChatMessage[] {
  // v1.15.8: same turn-scoping as applyThinking. The
  // previous version updated the very last text bubble,
  // which meant a late event from spawn 1 would
  // overwrite spawn 2's reply. We also skip frozen
  // bubbles (text that was emitted before a tool_use
  // event, see applyToolUse). If no eligible text
  // exists in the current turn, we just append.
  //
  // v1.16.4: stamp turnId from the current user message
  // (consistent with applyThinking). The first
  // non-empty text event also freezes the user
  // message's `finalElapsedMs` — see applyThinking for
  // the rationale.
  const lastUserIdx = lastUserIndex(msgs);
  const turnId = lastUserIdx >= 0 ? msgs[lastUserIdx]?.id : undefined;
  const text = e.fullText ?? e.preview;
  if (!text || !text.trim()) return msgs;
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    const m = msgs[i];
    if (m && m.kind === 'text' && m.role === 'assistant' && !m.frozen) {
      const updated: TextMessage = {
        ...m,
        text: mergePartialSnapshot(m.text, text, e.partial === true),
        partial: e.partial ?? m.partial,
      };
      return [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)];
    }
  }
  // No eligible text exists in this turn — append a
  // fresh bubble. If this is the first assistant output
  // for the turn, freeze the user message's timer.
  const hasOutputInThisTurn = hasAssistantOutputInTurn(msgs, lastUserIdx);
  let next = msgs;
  if (!hasOutputInThisTurn) {
    next = freezeTurnTimer(next, lastUserIdx, e.ts);
  }
  return [
    ...next,
    {
      id: nextId('text'),
      kind: 'text',
      role: 'assistant',
      createdAt: e.ts,
      text,
      partial: e.partial ?? false,
      turnId,
    },
  ];
}

function isPersonVisibleParent(msgs: readonly ChatMessage[], parentId: string): boolean {
  return msgs.some((m) => m.kind === 'subagent' && m.id === parentId);
}

function applyToolUse(msgs: ChatMessage[], e: ToolUseEvent): ChatMessage[] {
  // Nested tools whose parent is a Team seat never get a Person
  // subagent card (applySubagent drops those seats). Keep Explore /
  // other Person-visible nested tools.
  if (e.parentId && !isPersonVisibleParent(msgs, e.parentId)) return msgs;
  // v1.15.8: when a tool_use event lands, freeze any
  // preceding text bubble in the same turn. The
  // model's "let me run X" announcement text stays
  // there; the final reply becomes a fresh bubble that
  // renders *after* the tool flow.
  //
  // v1.16.4: also stamp turnId. The freeze trigger
  // (turnStartedAt → finalElapsedMs) lives on the
  // FIRST non-empty thinking/text event, not on
  // tool_use — by the time a tool fires the spinner
  // is already gone in the user's view.
  const lastUserIdx = lastUserIndex(msgs);
  const turnId = lastUserIdx >= 0 ? msgs[lastUserIdx]?.id : undefined;
  const withFrozenTimer = hasAssistantOutputInTurn(msgs, lastUserIdx)
    ? msgs
    : freezeTurnTimer(msgs, lastUserIdx, e.ts);
  const frozen: ChatMessage[] = withFrozenTimer.map((m, i) => {
    if (i > lastUserIdx && m.kind === 'text' && m.role === 'assistant' && !m.frozen) {
      return { ...m, frozen: true };
    }
    return m;
  });
  const tool: ToolMessage = {
    id: nextId(`tool-${e.id}`),
    // v1.16.5+ (spec §5.2): the Anthropic tool_use block id
    // is the stable toolCallId — the tool_result for the
    // same invocation carries the same id, and command
    // output can be routed to the card via it (§6.4).
    toolCallId: e.id,
    phaseId: phaseIdOf(frozen, lastUserIdx),
    kind: 'tool',
    role: 'assistant',
    createdAt: e.ts,
    tool: e.tool,
    status: 'running',
    summary: toolSummary(e),
    input: e.input,
    turnId,
  };
  return [...frozen, tool];
}

function applyToolResult(msgs: ChatMessage[], e: ToolResultEvent): ChatMessage[] {
  if (e.parentId && !isPersonVisibleParent(msgs, e.parentId)) return msgs;
  // PR-4 (spec §12.2 / §14.3): pairing is now strictly keyed on the
  // stable invocation id — the Anthropic tool_use block id stamped as
  // `toolCallId` at applyToolUse time. The id-prefix match on the
  // message id is kept for pre-v1.16.5 messages and for emitters whose
  // result id scheme predates toolCallId.
  //
  // The old unconditional "most recent running tool" fallback is the
  // parallel-tool 结果串配 defect §14.3 names. It survives ONLY for the
  // case that cannot be mis-paired: an id-less result when EXACTLY ONE
  // tool is running (raw Anthropic streams sometimes omit tool_use_id —
  // serial calls are then unambiguous). With a real id that matches
  // nothing, or with several tools running, the result is dropped with a
  // warning instead of being assigned to a guessed card.
  const outputContent = toPersistedToolResultContent(e.content);
  const update = (m: ToolMessage): ToolMessage => ({
    ...m,
    status: e.ok ? 'done' : 'error',
    outputText: e.output,
    ...(outputContent !== undefined ? { outputContent } : {}),
    outputError: e.error,
    durationMs: e.durationMs,
  });
  let matched = false;
  const result = msgs.map((m) => {
    if (m.kind !== 'tool') return m;
    const idMatch = (m.toolCallId !== undefined && m.toolCallId === e.id)
      || (e.id !== '' && m.id.startsWith(`tool-${e.id}-`));
    if (idMatch) {
      matched = true;
      return update(m);
    }
    return m;
  });
  if (matched) return result;
  // Id-less result: safe only when exactly one tool is running.
  if (e.id === '') {
    const runningIdx = result
      .map((m, i) => (m.kind === 'tool' && m.status === 'running' ? i : -1))
      .filter((i) => i >= 0);
    if (runningIdx.length === 1) {
      const idx = runningIdx[0]!;
      const m = result[idx];
      if (m && m.kind === 'tool') {
        const updated = [...result];
        updated[idx] = update(m);
        return updated;
      }
    }
    // eslint-disable-next-line no-console
    console.warn('[trylo] applyToolResult: id-less tool_result with', runningIdx.length, 'running tools — dropped');
    return result;
  }
  // eslint-disable-next-line no-console
  console.warn('[trylo] applyToolResult: no tool card for id', JSON.stringify(e.id), '— result dropped (parallel-safe pairing)');
  return result;
}

function applyTurnEnd(msgs: ChatMessage[], e: TurnEndEvent): ChatMessage[] {
  // v1.16.0: create or update a `TurnMessage` so the
  // context-window ring in the top bar can read
  // `usage.input_tokens`. Previously turn_end was
  // dropped (case 'turn_end': return msgs), so the
  // desktop had no idea how much context each turn
  // consumed. We do NOT handle turn_start — the
  // TurnMessage is born as 'done' on turn_end, which
  // is enough for the ring. Turn progress (running
  // → done transition) is a Phase 3 affordance.
  const status: TurnMessage['status'] =
    e.stopReason === 'max_tokens' ? 'error' : 'done';
  // Look for an existing TurnMessage with the same
  // turn number (e.g. an earlier draft from a partial
  // event). If found, update in place; otherwise
  // append a new one.
  // Empty-usage guard: the CLI omits input_tokens when a response
  // carries no usage. Never overwrite a good reading with an empty
  // one — otherwise the context ring freezes at a stale value (or
  // drops to 0) and stops tracking later turns.
  const hasUsableUsage = typeof e.usage?.input_tokens === 'number' && e.usage.input_tokens > 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.kind === 'turn' && m.turn === e.turn) {
      const updated: TurnMessage = {
        ...m,
        status,
        stopReason: e.stopReason,
        usage: hasUsableUsage ? e.usage : m.usage,
      };
      return [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)];
    }
  }
  const turn: TurnMessage = {
    id: nextId(`turn-${e.turn}`),
    kind: 'turn',
    role: 'assistant',
    createdAt: e.ts,
    turn: e.turn,
    depth: 0,
    agentId: null,
    status,
    stopReason: e.stopReason,
    usage: e.usage,
  };
  return [...msgs, turn];
}

// v1.16.0: compaction signal handlers. The CLI does
// the actual compaction (LLM summarization, see
// trylo-cli/src/commands/compact/compact.ts); the
// desktop observes + renders the result. The desktop
// also writes `/compact` to stdin to trigger manually
// or auto, but the algorithm is never reimplemented
// here — we trust the CLI to keep its context sane.

/** Track that a compaction is in flight. We use a
 *  NoticeMessage in the chat stream so the user sees
 *  "Compacting…" in the message flow (not just on the
 *  ring). The entry is replaced with the real
 *  CompactionMessage once the CLI emits the `compact`
 *  event.
 *
 *  Audit fix: if a pending notice is already the last
 *  message, REPLACE it instead of appending. The CLI
 *  shouldn't fire two `compaction_trigger` events in a
 *  row, but if it does (or if we see a re-trigger after
 *  a transient failure), the chat stream should show
 *  exactly one pending notice. */
function applyCompactionTrigger(
  msgs: ChatMessage[],
  e: CompactionTriggerEvent,
): ChatMessage[] {
  const notice: ChatMessage = {
    id: nextId('compact-pending'),
    kind: 'notice',
    role: 'system',
    createdAt: e.ts,
    text: `Compacting context (${formatK(e.preTokens)} → ${formatK(e.postTokens)})…`,
  };
  // Replace an existing pending notice if it's the
  // tail of the stream. Otherwise append fresh.
  const last = msgs[msgs.length - 1];
  if (last && last.kind === 'notice' && last.text.startsWith('Compacting context')) {
    return [...msgs.slice(0, -1), notice];
  }
  return [...msgs, notice];
}

/** Real compaction result. Replaces the pending notice
 *  from applyCompactionTrigger (if any) with the final
 *  CompactionMessage so the chat shows
 *  "180k → 40k" instead of "Compacting…". The
 *  tokensBefore / tokensAfter come from the CLI's
 *  `compact` event.
 *
 *  Audit note: the CLI uses `kind: 'boundary'` as the
 *  canonical "compact happened" event per
 *  __fixtures__/trylo-complex.ts. The `'before'` /
 *  `'after'` sub-kinds in the schema are for
 *  before/after state captures and may not be
 *  emitted as standalone events in practice. We
 *  produce a CompactionMessage for any kind — the
 *  fixture verifies this is the right call. */
function applyCompact(msgs: ChatMessage[], e: CompactEvent): ChatMessage[] {
  // Dedupe guard: the events-file tailer polls; a re-delivered (or
  // CLI-double-emitted) `compact` with IDENTICAL numbers is the same
  // compaction, not a new one — appending it would stack another
  // identical pill. A genuine second compaction always reports grown
  // numbers (its `before` starts where the last `after` left off),
  // so exact-equality never hides real work.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (
      m.kind === 'compaction' &&
      m.tokensBefore === e.tokensBefore &&
      m.tokensAfter === e.tokensAfter &&
      m.reason === e.reason
    ) {
      return msgs;
    }
  }
  const compaction: CompactionMessage = {
    id: nextId('compact'),
    kind: 'compaction',
    role: 'system',
    createdAt: e.ts,
    reason: e.reason,
    tokensBefore: e.tokensBefore,
    tokensAfter: e.tokensAfter,
  };
  // Replace the pending "Compacting…" notice(s) with the final result.
  // There should be exactly one notice; if the CLI fired multiple triggers
  // (or a trigger's `compact` event was lost and a later trigger re-fired),
  // sweep ALL stale notices so the stream never keeps a phantom
  // "Compacting…" row. The CompactionMessage lands at the position of the
  // LAST notice so ordering matches the compaction point.
  let replaceIdx = -1;
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.kind === 'notice' && m.text.startsWith('Compacting context')) {
      replaceIdx = out.length;
      continue;
    }
    out.push(m);
  }
  if (replaceIdx === -1) {
    // No pending notice (CLI emitted `compact` without a
    // prior trigger — shouldn't happen, but be safe).
    return [...msgs, compaction];
  }
  out.splice(replaceIdx, 0, compaction);
  return out;
}

function formatK(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** §8.1: surface the CLI's `subagent` spawn/end lifecycle as a SubagentMessage.
 *  Spawn appends a `running` card keyed by the CLI's subagent id; end flips the
 *  same id to `done` with the result. The subagent id is the message id so
 *  spawn/end stay paired across the reducer.
 *
 *  P3-B2: `managed-work` events are NOT handled here — the
 *  ManagedWorkCoordinator owns them (it binds the session, subscribes to workd
 *  broadcasts and projects the card itself). Handling them here would create a
 *  duplicate running card the coordinator cannot update.
 *
 *  The five Team seats (person/architect/worker/reviewer/verifier) are
 *  projected by `surfaces/team/team-projection.ts` into the Team surface.
 *  Rendering them here would duplicate the card in Person chat. */
function applySubagent(msgs: ChatMessage[], e: SubagentEvent): ChatMessage[] {
  if (e.agentType === 'managed-work') return msgs;
  if (e.agentType && isTeamSeatId(e.agentType)) return msgs;
  if (e.kind === 'spawn') {
    const msg: SubagentMessage = {
      id: e.id,
      kind: 'subagent',
      role: 'system',
      createdAt: e.ts,
      status: 'running',
      agentType: e.agentType ?? 'general-purpose',
      prompt: e.prompt,
    };
    return [...msgs, msg];
  }
  const idx = msgs.findIndex((m) => m.kind === 'subagent' && m.id === e.id && m.status === 'running');
  if (idx < 0) return msgs;
  const existing = msgs[idx] as SubagentMessage;
  const updated: SubagentMessage = {
    ...existing,
    status: 'done',
    result: e.result,
    durationMs: e.durationMs,
  };
  return msgs.map((m, i) => (i === idx ? updated : m));
}

/** Apply a batch of events to the message list. */
export function applyEvents(
  msgs: readonly ChatMessage[],
  events: readonly LoopEvent[],
): ChatMessage[] {
  let next: ChatMessage[] = [...msgs];
  for (const e of events) {
    next = applyOne(next, e);
  }
  return next;
}

function applyOne(msgs: ChatMessage[], e: LoopEvent): ChatMessage[] {
  switch (e.type) {
    case 'thinking':  return applyThinking(msgs, e);
    case 'text':      return applyText(msgs, e);
    case 'tool_use':   return applyToolUse(msgs, e);
    case 'tool_result': return applyToolResult(msgs, e);
    // v1.16.0: turn_end now produces a TurnMessage with
    // usage.input_tokens (the context size at this turn).
    // The top-bar context ring reads this to show
    // "47k / 200k". See applyTurnEnd above.
    case 'turn_end':  return applyTurnEnd(msgs, e);
    // v1.16.0: compaction is CLI-owned (LLM-based; see
    // trylo-cli/src/commands/compact/compact.ts). The
    // desktop is observer + renderer: a pending notice
    // during the run, the final "180k → 40k" pill after.
    case 'compaction_trigger': return applyCompactionTrigger(msgs, e);
    case 'compact':            return applyCompact(msgs, e);
    // v1.15.7: drop all the bookkeeping / lifecycle /
    // metadata events. Phase 3 can re-introduce them
    // in a side panel if needed.
    case 'loop_end':    return finalizeLatestTurnTimer(msgs, e.ts);
    case 'subagent':    return applySubagent(msgs, e);
    case 'session_start':
    case 'loop_start':
    case 'session_end':
    case 'turn_start':
    case 'api_retry':
    case 'model_fallback':
    case 'permission_denied':
    case 'api_call':
    case 'api_stream':
    case 'tool_use_summary':
    case 'progress':
    case 'slash_command':
    case 'skill_invoked':
    case 'todo_updated':
    case 'memory_updated':
    case 'plan_mode_transition':
    case 'aborted':
    case 'loop_started':
    case 'budget_breached':
    case 'loop_finished':
      return msgs;
  }
}
