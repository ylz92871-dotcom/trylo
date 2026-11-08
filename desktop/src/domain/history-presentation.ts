// Read-only snapshots already persisted in conversation history.
// No execution state machine, frame interpreter or legacy transport lives here.

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

