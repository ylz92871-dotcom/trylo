// Trylo Work — Work-domain type contract.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §2.3,
// §3, §6.1, §7.1, §10.1, §11.3): the vendor-agnostic typing
// for a Work "turn" — the user-visible unit we project into
// the linear MessageList. These types are the ONLY thing the
// reducer, the result resolver and the Desktop UI import;
// nothing here parses raw `task.event` frames.
//
// Two hard boundaries this file enforces (spec §2):
//   - `intent` is snapshotted at send time and flows through
//     registry → projection → history. The UI must never
//     rediscover intent by "did a tool event appear".
//   - a `conversation` turn never takes the task state
//     machine and never renders the PhaseRail.
//
// Pure: no React, no I/O. Importable from browser builds.

/** Conversation vs task. `conversation` answers directly and
 *  must not execute; `task` is an explicit work order. */
export type WorkTurnIntent = "conversation" | "task";

/** The five fixed semantic phases (spec §7.1). UI copy is
 *  localized separately; this is the stable identity.
 *  Not every task realizes all five. */
export type WorkSemanticPhase =
  | "understand"
  | "explore"
  | "execute"
  | "verify"
  | "deliver";

/** Stable phase order used by the PhaseRail. */
export const WORK_SEMANTIC_PHASES: readonly WorkSemanticPhase[] = [
  "understand",
  "explore",
  "execute",
  "verify",
  "deliver",
];

/** Default (Chinese) labels. The Desktop can localize by
 *  mapping on the stable phase without reading raw text. */
export const WORK_PHASE_LABELS: Readonly<Record<WorkSemanticPhase, string>> = {
  understand: "理解",
  explore: "查找",
  execute: "执行",
  verify: "验证",
  deliver: "交付",
};

/** One real activity fact (spec §6.1). */
export type WorkActivityKind =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "file_delete"
  | "code_search"
  | "web_search"
  | "command"
  | "browser"
  | "browser_debug"
  | "office"
  | "computer_control"
  | "cad_eda"
  | "agent"
  | "verification"
  | "artifact"
  | "memory"
  | "other";

export type WorkActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked";

/** A fact the activity can prove without guessing (a path,
 *  a count, a verdict). Only ever filled from real events. */
export interface WorkEvidence {
  readonly label: string;
  readonly detail?: string;
}

/** One activity on the linear timeline (spec §6.1). */
export interface WorkActivity {
  readonly id: string;
  readonly runId: string;
  readonly phase: WorkSemanticPhase;
  readonly kind: WorkActivityKind;
  readonly summary: string;
  readonly status: WorkActivityStatus;
  readonly evidence: readonly WorkEvidence[];
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** Stable upstream invocation id (when the daemon named
   *  one) so started → finished of one tool share id. */
  readonly toolCallId?: string;
  /** Optional link back to the ToolCard that owns the real
   *  input/output (defense: the card never duplicates it). */
  readonly toolMessageId?: string;
  /** How many like activities were merged into this one
   *  (spec §4.4 "读取 6 个文件"). 0/1 = not batched. */
  readonly batch?: number;
}

export type WorkPhaseStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed";

/** A PhaseRail row (spec §7.3). It answers only "where am
 *  I" / "what is done" — never carries the payload. */
export interface WorkPhaseState {
  readonly phase: WorkSemanticPhase;
  readonly status: WorkPhaseStatus;
  readonly label: string;
  readonly openedAt?: number;
  readonly closedAt?: number;
  readonly activityCount: number;
  readonly failedReason?: string;
}

/** A node that waits on the user: permission approval or a
 *  structured input request (spec §9). */
export type WorkBlocker =
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly label: string;
      readonly itemId: string;
    }
  | {
      readonly kind: "input";
      readonly id: string;
      readonly label: string;
      readonly itemId: string;
    };

/** Work turn state machine (spec §3). Two families: a
 *  conversation only answers; a task progresses through
 *  understanding → … → final. */
export type WorkTurnState =
  | "idle"
  | "answering"
  | "understanding"
  | "planning"
  | "executing"
  | "awaiting_approval"
  | "awaiting_input"
  | "recovering"
  | "verifying"
  | "finalizing"
  | "final_answer"
  | "error"
  | "cancelled";

/** The single terminal presentation every run must reach
 *  (spec §10.1). `completed` never just ends the PhaseRail;
 *  it always carries a result. */
export type WorkTerminalPresentation =
  | { readonly kind: "final_answer"; readonly text: string }
  | { readonly kind: "error"; readonly message: string; readonly diagnosticId: string }
  | { readonly kind: "cancelled"; readonly message: string };

/** Stable identity of one run (spec §2.3). Broader than the
 *  presenter's run identity: it carries the conversation
 *  binding and the snapshotted intent. */
export interface WorkRunIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly turnId: string | undefined;
  readonly conversationId: string;
  readonly intent: WorkTurnIntent;
}

/** Policy snapshotted at send time (spec §2.3). A
 *  `conversation` must force `plan` and never read the
 *  high-permission picker. */
export interface WorkRunPolicySnapshot {
  readonly intent: WorkTurnIntent;
  readonly requestedPermissionLevel: string;
  readonly effectivePermissionMode:
    | "plan"
    | "default"
    | "accept_edits"
    | "dont_ask";
}

/** White narration (spec §5.3). Not a chain-of-thought —
 *  a user-readable "what I understand / what I'm doing / why
 *  I moved to the next stage". Identity:
 *  `narration:${runId}:${phaseId}`. */
export interface WorkNarrationMessage {
  readonly id: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly text: string;
  readonly source: "assistant" | "timeline" | "derived";
  readonly partial: boolean;
}

/** The full semantic projection of one turn (spec §11.3).
 *  React renders this; it never parses raw frames. */
export interface WorkTurnProjection {
  readonly identity: WorkRunIdentity;
  readonly state: WorkTurnState;
  readonly phases: readonly WorkPhaseState[];
  readonly narrations: readonly WorkNarrationMessage[];
  readonly activities: readonly WorkActivity[];
  readonly blockers: readonly WorkBlocker[];
  readonly terminal?: WorkTerminalPresentation;
}

/** Spec §3.1: the conversation state machine. A chat turn
 *  may only answer; it must not enter task phases or show a
 *  task spinner. */
const CONVERSATION_TRANSITIONS: ReadonlyMap<WorkTurnState, readonly WorkTurnState[]> =
  new Map([
    ["idle", ["answering"]],
    ["answering", ["answering", "final_answer", "error", "cancelled"]],
    ["final_answer", []],
    ["error", []],
    ["cancelled", []],
  ]);

/** Spec §3.2: the task state machine.
 *  `executing` may park in `awaiting_approval` /
 *  `awaiting_input` / `recovering` and resume to `executing`.
 *  Terminal states are absorbing. */
const TASK_TRANSITIONS: ReadonlyMap<WorkTurnState, readonly WorkTurnState[]> =
  new Map([
    ["idle", ["understanding"]],
    // Understanding can open any of the actual work phases;
    // the next-state is driven by the first observed activity,
    // so we allow the whole non-terminal family from here.
    ["understanding", ["planning", "executing", "verifying"]],
    ["planning", ["executing", "verifying"]],
    ["executing", ["executing", "verifying", "awaiting_approval", "awaiting_input", "recovering", "finalizing"]],
    ["awaiting_approval", ["executing", "awaiting_input", "recovering"]],
    ["awaiting_input", ["executing", "awaiting_approval", "recovering"]],
    ["recovering", ["executing", "finalizing"]],
    ["verifying", ["finalizing", "executing"]],
    ["finalizing", ["final_answer"]],
    ["final_answer", []],
    ["error", []],
    ["cancelled", []],
  ]);

/** True when `to` is reachable from `from` in the given
 *  intent's state machine. Conservative: unknown source
 *  states widen to the family's terminal set. */
export function canTransitionTurnState(
  intent: WorkTurnIntent,
  from: WorkTurnState,
  to: WorkTurnState,
): boolean {
  if (from === to) return true;
  // Terminal states are absorbing (spec §3.3): never reopen.
  if (isTerminalTurnState(from)) return false;
  // ANY active state may jump to a terminal state.
  if (isTerminalTurnState(to)) return true;
  const table = intent === "conversation"
    ? CONVERSATION_TRANSITIONS
    : TASK_TRANSITIONS;
  const allowed = table.get(from) ?? [];
  if (allowed.includes(to)) return true;
  // Widening: a forward move within the task's non-terminal
  // family is always permitted, to avoid UI deadlock from an
  // under-specified table.
  if (intent === "task" && isTaskNonTerminal(to) && isTaskNonTerminal(from)) {
    const rankOrder = TASK_FORWARD.indexOf(from);
    const rankNext = TASK_FORWARD.indexOf(to);
    return rankOrder !== -1 && rankNext > rankOrder;
  }
  return false;
}

/** Approximate forward order of the task machine, used only
 *  as a safe widening for states not enumerated above. */
const TASK_FORWARD: readonly WorkTurnState[] = [
  "idle",
  "understanding",
  "planning",
  "executing",
  "verifying",
  "finalizing",
];
const TASK_NON_TERMINAL: ReadonlySet<WorkTurnState> = new Set([
  "idle",
  "understanding",
  "planning",
  "executing",
  "awaiting_approval",
  "awaiting_input",
  "recovering",
  "verifying",
  "finalizing",
]);

function isTaskNonTerminal(s: WorkTurnState): boolean {
  return TASK_NON_TERMINAL.has(s);
}

export function isTerminalTurnState(s: WorkTurnState): boolean {
  return s === "final_answer" || s === "error" || s === "cancelled";
}

/** Map an old `isChat` flag onto the new intent (spec §2.3):
 *  `true → conversation`, otherwise `task`. */
export function intentFromIsChat(isChat: boolean | undefined): WorkTurnIntent {
  return isChat === true ? "conversation" : "task";
}