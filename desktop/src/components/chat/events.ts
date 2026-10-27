// Trylo Desktop — event → message reducer.
//
// v1.14: the trylo CLI emits 28 typed events (per
// C:/work/demo-ws/trylo cli/docs/EVENT_VOCABULARY.md). This
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

import type { ChatMessage, NoticeMessage, ToolMessage, TurnMessage, SubagentMessage } from './types';
import { turnCompletion } from './types';
import { recordMemberObservation } from '../../domain/member-observation';
import type {
  LoopEvent,
  ToolUseEvent,
  ToolResultEvent,
  TurnEndEvent,
  SubagentEvent,
  RuntimeWarningEvent,
} from '../../host-adapter/loop-events';
import { toPersistedToolResultContent } from '../../tooling/tool-result-content';
import { isTeamSeatId } from '../../surfaces/shared/seats';
import { eventMessageId, lastUserIndex } from './message-identity';
import { applyText, applyThinking } from './stream-message-reducer';
import { finalizeLatestTurnTimer } from './turn-timer';
import { applyCompact, applyCompactionTrigger } from './compaction-message-reducer';
export { finalizeLatestTurnTimer } from './turn-timer';

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

/** v1.16.5+ (spec §5.2): the phaseId a tool belongs to.
 *  A tool inherits the phase of the nearest message that
 *  already carries a phaseId (its thinking, or a sibling
 *  tool that ran without any preceding thinking); when
 *  none exists yet it opens a fresh phase. Scanning is
 *  scoped to the current turn (`lastUserIdx`). */
function phaseIdOf(
  msgs: readonly ChatMessage[],
  lastUserIdx: number,
  event: ToolUseEvent,
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
  return eventMessageId(msgs, event, 'phase');
}

function isPersonVisibleParent(msgs: readonly ChatMessage[], parentId: string): boolean {
  return msgs.slice(lastUserIndex(msgs) + 1).some((m) => m.kind === 'subagent'
    && (m.subagentId ?? m.id) === parentId);
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
  // Tool calls retain the user turn identity; elapsed time settles only at terminal.
  const lastUserIdx = lastUserIndex(msgs);
  const turnId = lastUserIdx >= 0 ? msgs[lastUserIdx]?.id : undefined;
  if (msgs.slice(lastUserIdx + 1).some(message => message.kind === 'tool'
    && (e.id !== '' ? message.toolCallId === e.id
      : message.id === eventMessageId(msgs, e, 'tool-')))) return msgs;
  const frozen: ChatMessage[] = msgs.map((m, i) => {
    if (i > lastUserIdx && m.kind === 'text' && m.role === 'assistant' && !m.frozen) {
      return { ...m, frozen: true };
    }
    return m;
  });
  const tool: ToolMessage = {
    id: eventMessageId(msgs, e, `tool-${e.id}`),
    // v1.16.5+ (spec §5.2): the Anthropic tool_use block id
    // is the stable toolCallId — the tool_result for the
    // same invocation carries the same id, and command
    // output can be routed to the card via it (§6.4).
    toolCallId: e.id,
    phaseId: phaseIdOf(frozen, lastUserIdx, e),
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
    completedAt: e.ts,
  });
  let matched = false;
  const boundary = lastUserIndex(msgs);
  const result = msgs.map((m, index) => {
    if (index <= boundary) return m;
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
      .map((m, i) => (i > boundary && m.kind === 'tool' && m.status === 'running' ? i : -1))
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
  const boundary = lastUserIndex(msgs);
  const turnId = msgs[boundary]?.id;
  // v1.16.0: create or update a `TurnMessage` so the
  // context-window ring in the top bar can read
  // `usage.input_tokens`. Previously turn_end was
  // dropped (case 'turn_end': return msgs), so the
  // desktop had no idea how much context each turn
  // consumed. We do NOT handle turn_start — the
  // TurnMessage is born as 'done' on turn_end, which
  // is enough for the ring. Turn progress (running
  // → done transition) is a Phase 3 affordance.
  // Round-3 (P1-11). The old rule was `stopReason === 'max_tokens' ? 'error'
  // : 'done'`, which made every other failure a success: the acceptance run
  // recorded `status:"done" stopReason:"tool_use" usage 0/0` for a turn where
  // the provider refused the request and no tool ever ran.
  const completion = turnCompletion(e.stopReason);
  const status: TurnMessage['status'] = completion === 'failed' ? 'error' : 'done';
  // A turn that produced no output tokens AND left no assistant text delivered
  // nothing, whatever the stop reason claims. That is the 「本轮未完成」 case,
  // and it is the one the user cannot see by looking at the status pill.
  //
  // Independent of `completion`: a failed turn can also have delivered nothing
  // (P0-6 — the provider refused, so there was no answer AND no tool), and
  // that is precisely the case where both signals must be on the record.
  const incomplete = turnDeliveredNothing(msgs, boundary, e);
  // Look for an existing TurnMessage with the same
  // turn number (e.g. an earlier draft from a partial
  // event). If found, update in place; otherwise
  // append a new one.
  // Empty-usage guard: the CLI omits input_tokens when a response
  // carries no usage. Never overwrite a good reading with an empty
  // one — otherwise the context ring freezes at a stale value (or
  // drops to 0) and stops tracking later turns.
  const hasUsableUsage = typeof e.usage?.input_tokens === 'number' && e.usage.input_tokens > 0;
  for (let i = msgs.length - 1; i > boundary; i--) {
    const m = msgs[i];
    if (m && m.kind === 'turn' && m.turn === e.turn) {
      // Conditional spread, NOT `incomplete` bare: writing `incomplete: false`
      // would add a key the first application never set, and `applyEvents`
      // must stay idempotent under replay (events-idempotence.test.ts asserts
      // a 100-turn serialize/restore/replay round trip is a fixed point).
      const updated: TurnMessage = {
        ...m,
        status,
        stopReason: e.stopReason,
        ...(incomplete ? { incomplete: true } : {}),
        usage: hasUsableUsage ? e.usage : m.usage,
        ...(e.contextTokens === undefined ? {} : { contextTokens: e.contextTokens }),
        ...(e.contextWindow === undefined ? {} : { contextWindow: e.contextWindow }),
        ...(e.usageScope === undefined ? {} : { usageScope: e.usageScope }),
      };
      return [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)];
    }
  }
  const turn: TurnMessage = {
    id: eventMessageId(msgs, e, `turn-${e.turn}`),
    kind: 'turn',
    role: 'assistant',
    createdAt: e.ts,
    turn: e.turn,
    depth: 0,
    agentId: null,
    status,
    stopReason: e.stopReason,
    ...(incomplete ? { incomplete: true } : {}),
    usage: e.usage,
    ...(e.contextTokens === undefined ? {} : { contextTokens: e.contextTokens }),
    ...(e.contextWindow === undefined ? {} : { contextWindow: e.contextWindow }),
    ...(e.usageScope === undefined ? {} : { usageScope: e.usageScope }),
    turnId,
  };
  return [...msgs, turn];
}

/**
 * Did this turn deliver anything the user can see?
 *
 * The anchor is the visible transcript, not the token counter:
 *   - an assistant text row means an answer exists (a failure on top of it
 *     is still signalled by `status: "error"` + the warning notice, so the
 *     turn is not "nothing delivered");
 *   - a FAILED turn with no answer delivered nothing — even when tools ran
 *     (idx22 overwrote files then said nothing) and even when the stream
 *     never reported usage (resume/model-mismatch failures carry no usage
 *     frame at all). Tools running is not delivery; the answer is.
 *   - a completed tool-only turn (no text) still counts as delivered;
 *   - otherwise 0 output tokens with nothing in the transcript is the
 *     classic silent failure.
 */
function turnDeliveredNothing(
  msgs: readonly ChatMessage[],
  boundary: number,
  e: TurnEndEvent,
): boolean {
  let hasText = false;
  let hasTool = false;
  for (let i = boundary + 1; i < msgs.length; i++) {
    const message = msgs[i];
    if (!message) continue;
    if (message.kind === 'text' && message.role === 'assistant') {
      hasText = true;
      break;
    }
    if (message.kind === 'tool') hasTool = true;
  }
  if (hasText) return false;
  if (turnCompletion(e.stopReason) === 'failed') return true;
  if (hasTool) return false;
  return e.usage?.output_tokens === 0;
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
  if (e.teamRunId || (e.source !== 'trylo-v1' && e.agentType && isTeamSeatId(e.agentType))) return msgs;
  const boundary = lastUserIndex(msgs);
  const existingIndex = msgs.findIndex((message, index) => index > boundary
    && message.kind === 'subagent' && ((message.subagentId ?? message.id) === e.id
      || (e.taskId !== undefined && message.taskId === e.taskId)));
  if (e.kind === 'spawn') {
    if (existingIndex >= 0) {
      const existing = msgs[existingIndex] as SubagentMessage;
      if (e.resumedFrom !== existing.subagentId || e.id === existing.subagentId
        || existing.status === 'running' || existing.status === 'waiting') return msgs;
      const round = e.round ?? (existing.round ?? 1) + 1;
      const previous = existing.conversation ?? [{ round: existing.round ?? 1, prompt: existing.prompt, result: existing.result }];
      const resumed: SubagentMessage = { ...existing, subagentId: e.id, status: 'running', parked: false, error: undefined,
        canReceiveInput: e.canReceiveInput ?? true, round,
        ...(e.budget === undefined ? {} : { budget: e.budget }),
        conversation: [...previous, { round, prompt: e.prompt }] };
      return msgs.map((message, index) => index === existingIndex ? resumed : message);
    }
    const msg: SubagentMessage = {
      id: msgs.some(message => message.id === e.id)
        ? eventMessageId(msgs, e, `subagent-${e.id}`) : e.id,
      subagentId: e.id,
      ...(e.taskId === undefined ? {} : { taskId: e.taskId }),
      ...(e.budget === undefined ? {} : { budget: e.budget }),
      turnId: msgs[boundary]?.id,
      kind: 'subagent',
      role: 'system',
      createdAt: e.ts,
      status: 'running',
      agentType: e.agentType ?? 'general-purpose',
      ...(e.displayName ? { displayName: e.displayName } : e.source === 'trylo-v1'
        && ['default', 'subagent', 'general-purpose'].includes(e.agentType ?? 'general-purpose')
        ? { displayName: `协作 ${msgs.slice(boundary + 1).filter(message => message.kind === 'subagent').length + 1}` } : {}),
      prompt: e.prompt,
      ...(e.source ? { source: e.source } : {}),
      ...(e.canReceiveInput === undefined ? {} : { canReceiveInput: e.canReceiveInput }),
    };
    return [...msgs, msg];
  }
  const idx = existingIndex;
  if (idx < 0) return msgs;
  const existing = msgs[idx] as SubagentMessage;
  if ((existing.subagentId ?? existing.id) !== e.id) return msgs;
  if (existing.status !== 'running' && existing.status !== 'waiting') return msgs;
  const round = e.round ?? existing.round ?? 1;
  const conversation = [...(existing.conversation ?? (existing.prompt ? [{ round: 1, prompt: existing.prompt }] : []))];
  const roundIndex = conversation.findIndex(entry => entry.round === round);
  const entry = { ...(roundIndex < 0 ? {} : conversation[roundIndex]), round,
    ...(e.kind === 'update' && e.prompt !== undefined ? { prompt: e.prompt } : {}),
    ...(e.result !== undefined ? { result: e.result } : {}) };
  if (roundIndex < 0) conversation.push(entry); else conversation[roundIndex] = entry;
  const updated: SubagentMessage = {
    ...existing,
    ...(e.observation === undefined ? {} : { observations: recordMemberObservation(existing.observations, e.observation, e.ts) }),
    status: e.status ?? (e.kind === 'end' ? 'done' : existing.status),
    ...(e.result === undefined ? {} : { result: e.result }),
    ...(e.error === undefined ? {} : { error: e.error }),
    ...(e.displayName === undefined || e.displayName === e.id ? {} : { displayName: e.displayName }),
    ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
    ...(e.budget === undefined ? {} : { budget: e.budget }),
    ...(e.parked === undefined ? {} : { parked: e.parked }),
    ...(e.kind === 'end' ? { canReceiveInput: e.parked === true && e.canReceiveInput === true } : {}),
    round, conversation,
  };
  return msgs.map((m, i) => (i === idx ? updated : m));
}

/**
 * P08 §5: surface a runtime warning as its own notice row.
 *
 * `code` is always shown, because the captured golden warnings carry an
 * EMPTY message (`{"code":"denied","message":""}`) — the code alone is
 * what tells the user a tool call was refused.
 */
function applyRuntimeWarning(msgs: ChatMessage[], e: RuntimeWarningEvent): ChatMessage[] {
  const id = e.id ?? eventMessageId(msgs, e, 'warn');
  if (msgs.some(message => message.id === id)) return msgs;
  // A degradation keeps one row per reason + affected history set, not one per
  // turn or per replay. The event id is per-turn; `noticeId` is the identity
  // the CLI makes stable across processes, so it is what the panel dedupes on.
  const noticeId = e.diagnostic?.noticeId;
  if (noticeId !== undefined
    && msgs.some(message => message.kind === 'notice' && message.noticeId === noticeId)) return msgs;
  const text = e.message.trim() !== '' ? e.message : `运行时提示：${e.code}`;
  return [
    ...msgs,
    {
      id,
      // `system`, never `assistant`: a warning is host evidence about
      // the run, and dressing it up as a model utterance would make an
      // unexplained refusal look like the agent's own words.
      role: 'system',
      createdAt: e.ts,
      kind: 'notice',
      text,
      ...(noticeId === undefined ? {} : { noticeId }),
    } satisfies NoticeMessage,
  ];
}

/** Apply a batch of events to the message list. */
export function applyEvents(
  msgs: readonly ChatMessage[],
  events: readonly LoopEvent[],
): ChatMessage[] {
  let next: ChatMessage[] = [...msgs];
  for (const e of events) {
    if (e.type === 'text' || e.type === 'thinking' || e.type === 'tool_use' || e.type === 'loop_end') {
      next = next.filter(message => message.kind !== 'notice' || message.runtimeState !== 'reconnecting');
    }
    next = applyOne(next, e);
  }
  return next;
}

function applyOne(msgs: ChatMessage[], e: LoopEvent): ChatMessage[] {
  switch (e.type) {
    case 'input_request': {
      const id = `input_request:${e.requestId}`;
      const existing = msgs.findIndex(message => message.id === id);
      const message: import('./types').InputRequestMessage = { id, kind: 'input_request', role: 'assistant',
        createdAt: e.ts, turnId: msgs[lastUserIndex(msgs)]?.id, requestId: e.requestId,
        questions: e.questions, status: e.status, ...(e.answers ? { answers: e.answers } : {}) };
      return existing < 0 ? [...msgs, message] : msgs.map((m, i) => i === existing ? { ...message, createdAt: m.createdAt } : m);
    }
    case 'thinking':  return applyThinking(msgs, e);
    case 'text':      return applyText(msgs, e);
    case 'tool_use':   return applyToolUse(msgs, e);
    case 'tool_result': return applyToolResult(msgs, e);
    // v1.16.0: turn_end now produces a TurnMessage with
    // usage.input_tokens (the context size at this turn).
    // The top-bar context ring reads this to show
    // "47k / 200k". See applyTurnEnd above.
    case 'turn_end':  return applyTurnEnd(msgs, e);
    // P08 §5: a CLI `warning` becomes a visible notice. It is NOT
    // dropped (a denied write reaches the UI as a warning and nothing
    // else) and NOT rendered as assistant text — the model did not say
    // it, the runtime did.
    case 'runtime_warning': return applyRuntimeWarning(msgs, e);
    case 'api_retry': {
      if (e.errorStatus === 401 || e.errorStatus === 403) return msgs;
      const user = msgs[lastUserIndex(msgs)];
      const id = `${user?.id ?? 'run'}:api-retry`;
      const status = e.errorStatus > 0 ? `（HTTP ${e.errorStatus}）` : '';
      const delay = Math.max(1, Math.ceil(e.retryDelayMs / 1000));
      const text = `模型服务暂时未响应${status}，${delay} 秒后重试（${e.attempt}/${e.maxRetries}）。`;
      return [...msgs.filter(message => message.id !== id), {
        id, kind: 'notice', role: 'system', text, createdAt: e.ts,
        turnId: user?.id, runtimeState: 'reconnecting',
      }];
    }
    // v1.16.0: compaction is CLI-owned (LLM-based; see
    // trylo-cli/src/commands/compact/compact.ts). The
    // desktop is observer + renderer: a pending notice
    // during the run, the final "180k → 40k" pill after.
    case 'compaction_trigger': return applyCompactionTrigger(msgs, e);
    case 'context_usage': {
      const index = lastUserIndex(msgs);
      const id = `${msgs[index]?.id ?? 'run'}:context-usage`;
      const current = msgs.find(message => message.id === id);
      if (current && current.createdAt > e.ts) return msgs;
      return [...msgs.filter(message => message.id !== id), { id, kind: 'notice', role: 'system', text: '',
        createdAt: e.ts, turnId: msgs[index]?.id, contextTokens: e.tokens, contextWindow: e.contextWindow }];
    }
    case 'compact':            return applyCompact(msgs, e);
    // v1.15.7: drop all the bookkeeping / lifecycle /
    // metadata events. Phase 3 can re-introduce them
    // in a side panel if needed.
    case 'loop_end':    return finalizeLatestTurnTimer(msgs, e.ts,
      e.reason === 'cancelled' || e.reason === 'abort' ? 'cancelled'
        : e.isError ? 'failed' : 'completed');
    case 'aborted': return finalizeLatestTurnTimer(msgs, e.ts, e.reason === 'user' ? 'cancelled' : 'failed');
    case 'subagent':    return applySubagent(msgs, e);
    case 'session_start':
    case 'loop_start':
    case 'session_end':
    case 'turn_start':
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
    case 'loop_started':
    case 'budget_breached':
    case 'loop_finished':
      return msgs;
  }
}
