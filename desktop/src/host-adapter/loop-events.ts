// Trylo Desktop — Loop event types.
//
// The Trylo CLI (cli.js) emits a
// high-fidelity JSONL stream of agent-loop transitions
// to the file pointed to by CLAUDE_CODE_LOOP_EVENTS_FILE.
// This module defines the types and the 28 event shapes
// per the CLI event vocabulary spec.
//
// Every event has `seq` (monotonic) and `ts` (Unix ms).
// The host tails the file and pushes events into the
// React message list.

import type { FilePath } from './types';
import type { AnyToolResultContent } from '../tooling/tool-result-content';

// ── 28 event types ──────────────────────────────────────────

export type LoopEventType =
  // Session lifecycle (3)
  | 'session_start'
  | 'loop_start'
  | 'session_end'
  | 'loop_end'
  // Turn structure (4)
  | 'turn_start'
  | 'turn_end'
  | 'api_call'
  | 'api_stream'
  // Model behavior (3)
  | 'api_retry'
  | 'model_fallback'
  | 'thinking'
  | 'text'
  // Tool calls (5)
  | 'tool_use'
  | 'tool_result'
  | 'tool_use_summary'
  | 'permission_denied'
  | 'progress'
  // Sub-agents (2)
  | 'subagent'
  // Context compaction (3)
  | 'compaction_trigger'
  | 'compact'
  // User/host actions (5)
  | 'slash_command'
  | 'skill_invoked'
  | 'todo_updated'
  | 'memory_updated'
  | 'plan_mode_transition'
  // User-initiated termination (1)
  | 'aborted'
  // User-side loopRunner events (3)
  | 'loop_started'
  | 'budget_breached'
  | 'loop_finished';

export interface BaseEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: LoopEventType;
}

export interface SessionStartEvent extends BaseEvent {
  readonly type: 'session_start';
  readonly sessionId: string;
  readonly model: string;
  readonly cwd: FilePath;
  readonly permissionMode: string;
}

export interface LoopStartEvent extends BaseEvent {
  readonly type: 'loop_start';
  readonly sessionId: string;
  readonly model: string;
  readonly promptSummary: string;
  readonly tools: readonly string[];
}

export interface SessionEndEvent extends BaseEvent {
  readonly type: 'session_end';
  readonly sessionId: string;
  readonly durationMs: number;
  readonly reason: 'success' | 'error' | 'abort' | 'max_turns' | 'max_budget';
}

export interface LoopEndEvent extends BaseEvent {
  readonly type: 'loop_end';
  readonly durationMs: number;
  readonly totalCost: number;
  readonly numTurns: number;
  readonly reason: string;
  readonly finalResult: string;
  /** v1.15.7: optional error flag (Anthropic result.subtype='error'). */
  readonly isError?: boolean;
}

export interface TurnStartEvent extends BaseEvent {
  readonly type: 'turn_start';
  readonly turn: number;
  readonly depth: number;
  readonly agentId: string | null;
}

export interface TurnEndEvent extends BaseEvent {
  readonly type: 'turn_end';
  readonly turn: number;
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  // Mirrors the CLI wire shape (utils/loopEvents.ts): usage fields are
  // optional — the CLI omits input_tokens when a response carries no
  // usage. Consumers must treat a missing/non-positive input_tokens
  // as "no new reading", never as 0.
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

export interface ApiCallEvent extends BaseEvent {
  readonly type: 'api_call';
  readonly turn: number;
  readonly model: string;
  readonly messages: number;
  readonly toolCount: number;
}

export type ApiStreamKind =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop';

export type ApiStreamBlock = 'text' | 'tool_use' | 'thinking' | 'unknown';

export interface ApiStreamEvent extends BaseEvent {
  readonly type: 'api_stream';
  readonly turn: number;
  readonly kind: ApiStreamKind;
  readonly block: ApiStreamBlock;
  readonly id?: string;
  readonly toolName?: string;
  /** For content_block_delta text events, the running text. */
  readonly text?: string;
}

export interface ApiRetryEvent extends BaseEvent {
  readonly type: 'api_retry';
  readonly attempt: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly errorStatus: number;
  readonly error: string;
}

export interface ModelFallbackEvent extends BaseEvent {
  readonly type: 'model_fallback';
  readonly fromModel: string;
  readonly toModel: string;
  readonly reason: 'overloaded' | 'stream_error' | 'context_too_long';
}

export interface ThinkingEvent extends BaseEvent {
  readonly type: 'thinking';
  readonly turn: number;
  readonly preview: string;
  readonly summary: string;
  readonly fullLength: number;
  /** v1.15.8: true while the model is still streaming
   *  thinking tokens (the translator emits intermediate
   *  events as deltas arrive). */
  readonly partial?: boolean;
}

export interface TextEvent extends BaseEvent {
  readonly type: 'text';
  readonly turn: number;
  readonly preview: string;
  /** Full text (concatenated across content_block_delta
   *  events for the same block). Optional — if absent the
   *  reducer falls back to `preview`. */
  readonly fullText?: string;
  /** v1.15.8: true while the assistant reply is still
   *  streaming. */
  readonly partial?: boolean;
}

export interface ToolUseEvent extends BaseEvent {
  readonly type: 'tool_use';
  readonly turn: number;
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly parentId?: string;
}

export interface ToolResultEvent extends BaseEvent {
  readonly type: 'tool_result';
  readonly turn: number;
  readonly id: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly output: string;
  /** PR-4 (spec §7): the structured content blocks of this result. Blocks
   *  carrying binary payloads are RAW (base64 in memory) until
   *  `materializeToolResultEvents` swaps them for BinaryRefs in the
   *  trylo-runner pump — the reducer and history only ever see resolved
   *  blocks. Undefined for legacy emitters that only produce text. */
  readonly content?: readonly AnyToolResultContent[];
  readonly error?: string;
  readonly durationMs: number;
  /** Nested (sub-agent) result: the parent Agent/Task tool_use id. */
  readonly parentId?: string;
}

export interface SubagentEvent extends BaseEvent {
  readonly type: 'subagent';
  readonly kind: 'spawn' | 'end';
  readonly parentId?: string;
  readonly id: string;
  readonly agentType?: string;
  readonly prompt?: string;
  readonly result?: string;
  readonly durationMs?: number;
  /** P3-B1 (§4.4 B1): machine-readable managed-work receipt carried on the
   *  `end` event. The ManagedWorkCoordinator builds its binding from this —
   *  not from text parsing. */
  readonly managed?: {
    readonly childId?: string;
    readonly managedSessionId?: string;
    readonly backingTaskId?: string;
    readonly status?: string;
    readonly delivery?: string;
    readonly artifacts?: ReadonlyArray<{ readonly relativePath: string; readonly kind?: string }>;
    readonly pendingAction?: { readonly type: string; readonly requestId: string; readonly description: string };
    readonly error?: string;
  };
}

export interface CompactionTriggerEvent extends BaseEvent {
  readonly type: 'compaction_trigger';
  readonly trigger: 'auto' | 'manual' | 'reactive';
  readonly preTokens: number;
  readonly postTokens: number;
}

export interface CompactEvent extends BaseEvent {
  readonly type: 'compact';
  readonly kind: 'boundary' | 'before' | 'after';
  /** Optional: the CLI omits these when the token counts are unknown
   *  (e.g. replaying an old boundary marker that only stored `preTokens`). */
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly reason: string;
}

export interface AbortedEvent extends BaseEvent {
  readonly type: 'aborted';
  readonly reason: 'user' | 'timeout' | 'error';
}

export interface TodoUpdatedEvent extends BaseEvent {
  readonly type: 'todo_updated';
  readonly todos: readonly { content: string; status: string; activeForm: string }[];
}

export interface PlanModeTransitionEvent extends BaseEvent {
  readonly type: 'plan_mode_transition';
  readonly to: 'plan' | 'code';
  readonly from: 'plan' | 'code';
}

// Strict variants (the 28 known shapes). Forward-compat
// events land in `OtherLoopEvent` below.
type StrictLoopEvent =
  | SessionStartEvent
  | LoopStartEvent
  | SessionEndEvent
  | LoopEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ApiCallEvent
  | ApiStreamEvent
  | ApiRetryEvent
  | ModelFallbackEvent
  | ThinkingEvent
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | SubagentEvent
  | CompactionTriggerEvent
  | CompactEvent
  | AbortedEvent
  | TodoUpdatedEvent
  | PlanModeTransitionEvent;

export type LoopEvent = StrictLoopEvent | OtherLoopEvent;

/**
 * Forward-compat: any event with an unknown `type` lands here.
 * The host can still inspect `seq`, `ts`, and the raw
 * payload.
 */
export interface OtherLoopEvent extends BaseEvent {
  readonly type: Exclude<LoopEventType, StrictLoopEvent['type']>;
  readonly [k: string]: unknown;
}

/** Parse a single JSONL line. Returns null on malformed input.
 *
 * v1.15.7: events from the CLI may not have `seq` / `ts`
 * (the loop-events translator on the CLI side might
 * already fill them in, or not). Default to a running
 * counter + current time so the reducer's strict types
 * don't trip on undefined. */
export function parseLoopEvent(line: string): LoopEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed['type'] !== 'string') return null;
  // Default seq/ts if missing.
  if (typeof parsed['seq'] !== 'number') {
    parsed['seq'] = _autoSeq++;
  }
  if (typeof parsed['ts'] !== 'number') {
    parsed['ts'] = Date.now();
  }
  return parsed as unknown as LoopEvent;
}

let _autoSeq = 0;
