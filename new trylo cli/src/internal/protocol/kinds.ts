export const EVENT_KINDS = [
  "session_start",
  "session_end",
  "loop_start",
  "loop_end",
  "turn_start",
  "turn_end",
  "api_call",
  "api_retry",
  "model_fallback",
  "text",
  "thinking",
  "usage",
  "tool_use",
  "tool_result",
  "approval_requested",
  "permission_denied",
  "subagent_spawn",
  "subagent_end",
  "subagent_update",
  "compact",
  "user_cancel",
  "user_reject",
  "observation",
  "error",
  "terminal",
  "file_write",
  "user_correction",
  "check_result",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);

export function isEventKind(value: string): value is EventKind {
  return EVENT_KIND_SET.has(value);
}

export const CONTINUE_REASONS = [
  "next_turn",
  "retry",
  "compact",
  "token_budget",
  "permission_block",
  "bounded_recheck",
] as const;

export type ContinueReason = (typeof CONTINUE_REASONS)[number];
