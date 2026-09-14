// Trylo Desktop — Message types.
//
// v1.9: the 28 loop event types from the Trylo CLI map to
// the following ChatMessage variants. Each variant is a
// row in the message stream. The reducer in events.ts
// converts raw LoopEvents to these.

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageBase {
  /** Stable id for React keys. */
  readonly id: string;
  readonly role: MessageRole;
  /** Unix ms. */
  readonly createdAt: number;
  // v1.16.4 (timer + edit-resend rewrite): every message
  // carries its own `turnId` (the id of the user message
  // that started the turn it belongs to). This replaces
  // the v1.15.9 "find phase boundary by array index" hack
  // — events arriving in unexpected order no longer shift
  // phase boundaries, because phases are keyed on a stable
  // identifier (the user message's id) instead of a
  // fragile array index. The previous pattern was the root
  // cause of the "thinking block ends up below the output"
  // bug after edit-and-resend.
  readonly turnId?: string;
  // v1.16.5+ (Code-Work workflow sync spec §5.2): the
  // stable phase this message belongs to. Both adapters
  // emit it — Code derives it from thinking adjacency,
  // Work from the upstream `groupId` (with a synthesized
  // default when the daemon gives none). MessageList uses
  // it to group a phase's tools into one ToolSummary
  // (§9.3) instead of re-deriving phase boundaries from
  // array order.
  readonly phaseId?: string;
}

export interface TextMessage extends MessageBase {
  readonly kind: 'text';
  readonly text: string;
  /** v1.16.8: display-only snapshot of the files/images the USER sent with
   *  this message, so the sent bubble shows what actually went out (both
   *  Code and Work) instead of a bare text line. `previewUrl` is a
   *  session-scoped blob — it degrades to a plain file chip after reload.
   *  This is NEVER used to build the CLI prompt: the host projects the real
   *  attachment separately at send time (buildAttachmentPromptContext /
   *  formatWorkMessage). */
  readonly attachments?: readonly SentAttachment[];
  /** v1.15.8: true while the assistant reply is still
   *  streaming. Used to show a typing cursor / dots. */
  readonly partial?: boolean;
  /** v1.15.8: a tool_use event came after this text.
   *  applyText will NOT update a frozen text in place
   *  — the next text event creates a new bubble. This
   *  fixes the "response appears above the tool" bug:
   *  if the model emits "let me check X" before
   *  tool_use, that text is frozen; the final reply
   *  becomes a fresh text bubble rendered after the
   *  tool result. */
  readonly frozen?: boolean;
  // v1.16.4: per-turn timer anchor. `turnStartedAt` is
  // stamped on the USER message at the moment they hit
  // send (or save after an edit). The TurnProgress row
  // reads it from the user message — never from a
  // top-level state — so multiple turns coexist
  // independently. When the first model output arrives
  // for this turn, events.ts sets `finalElapsedMs` and
  // the spinner freezes at "已工作 0:12" forever.
  // For edit-and-resend, the existing user message's
  // `turnStartedAt` is REPLACED with the new click-
  // send time, and the previous `finalElapsedMs` is
  // cleared (we're starting a new turn on the same
  // user bubble).
  readonly turnStartedAt?: number;
  readonly finalElapsedMs?: number;
}

export interface NoticeMessage extends MessageBase {
  readonly kind: 'notice';
  readonly text: string;
}

export interface ToolMessage extends MessageBase {
  readonly kind: 'tool';
  readonly tool: string;
  /** `interrupted` = the run reached a terminal state while
   *  this invocation was still running (M3 closure spec
   *  §6.2) — distinct from a tool-level failure. */
  readonly status: 'pending' | 'running' | 'done' | 'error' | 'interrupted';
  readonly summary: string;
  /** Tool input (shown expanded). */
  readonly input?: Record<string, unknown>;
  /** PR-4 (spec §7.2): the tool-result TEXT summary (was `output`).
   *  Rich blocks live in `outputContent`; this stays for the collapsed
   *  text view and for old sessions (migrated on history load). */
  readonly outputText?: string;
  /** PR-4 (spec §7): the structured tool-result blocks — text /
   *  image / audio / resource / resource_link / structured. Binary
   *  payloads are BinaryRef metadata ONLY (base64 never reaches this
   *  field; see tool-result-content.ts guards). */
  readonly outputContent?: readonly import('../../tooling/tool-result-content').ToolResultContent[];
  readonly outputError?: string;
  readonly durationMs?: number;
  /** True if the user has expanded the body. (UI-local state.) */
  readonly expanded?: boolean;
  // v1.16.5+ (spec §5.2): the stable invocation id from the
  // runtime — the Anthropic tool_use block id in Code, the
  // upstream stepId in Work. One invocation's
  // started → done/error transitions share it (Work already
  // keys the card id on stepId); command output can route
  // into the right card via it (§6.4).
  readonly toolCallId?: string;
}

/**
 * v1.9: thinking card uses the SHORT `summary` as the
 * card title. The `preview` (up to 500 chars) is shown
 * only when expanded. The heuristic for the summary is
 * documented in
 * C:/work/demo-ws/trylo cli/docs/THINKING_SUMMARIZATION.md
 * (3 strategies: pattern match → first sentence →
 * first 8 words).
 */
export interface ThinkingMessage extends MessageBase {
  readonly kind: 'thinking';
  /** The 精辟 summary — used as the card title. */
  readonly summary: string;
  /** Longer preview, shown on expand. */
  readonly preview: string;
  readonly fullLength: number;
  /** v1.15.8: true while the model is still streaming
   *  thinking tokens. The ThinkingCard auto-expands
   *  when partial so the user sees the reasoning as it
   *  arrives, and stays expanded even after the model
   *  finishes (so the summary doesn't feel "swallowed"
   *  by the assistant reply that follows). */
  readonly partial: boolean;
  /** Associated turn. */
  readonly turn: number;
  /** v1.16.5+ (M3, Work): the latest agent activity the
   *  run reported (a step/progress marker). Rendered as a
   *  small status line inside the card so run progress
   *  never enters the chat as its own SYSTEM pill. Code
   *  conversations leave this undefined. */
  readonly activity?: string;
}

/**
 * A turn boundary. Shows "Turn 1 / 6" etc. with running/done
 * status. Useful for long sessions so the user can see where
 * they are.
 */
export interface TurnMessage extends MessageBase {
  readonly kind: 'turn';
  readonly turn: number;
  readonly depth: number;
  readonly agentId: string | null;
  readonly status: 'running' | 'done' | 'error';
  /** From turn_end. */
  readonly stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/**
 * Context compaction. The "180k → 40k" pill.
 */
export interface CompactionMessage extends MessageBase {
  readonly kind: 'compaction';
  readonly reason: string;
  /** Optional: unknown when the CLI couldn't provide the counts
   *  (e.g. replaying an old boundary marker that only stored `preTokens`). */
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
}

/**
 * A sub-agent (Task/Agent tool) that was spawned or ended.
 *
 * §8.1: status extended beyond running/done with waiting/failed/cancelled so
 * durable managed-work children can be surfaced in the same message. The
 * optional managed fields (sessionId / summary / artifacts / backingTaskId)
 * back the sub-agent detail drawer for managed-work.
 */
export interface SubagentMessage extends MessageBase {
  readonly kind: 'subagent';
  readonly status: 'running' | 'done' | 'waiting' | 'failed' | 'cancelled';
  readonly agentType: string;
  readonly prompt?: string;
  readonly result?: string;
  readonly durationMs?: number;
  /** Managed-work only: the durable ManagedSession id in workd. */
  readonly managedSessionId?: string;
  readonly backingTaskId?: string;
  readonly summary?: string;
  readonly artifacts?: readonly string[];
}

/**
 * v1.16.5+ (M3, Phase D): a file the agent produced during
 * this run. Rendered inline (near the run that created it)
 * by the shared Work ArtifactCard; the Artifact Dock below
 * the composer aggregates the same entries. `updated` is
 * true when a later event re-emitted the same path in the
 * same turn (re-generation).
 */
export interface ArtifactMessage extends MessageBase {
  readonly kind: 'artifact';
  readonly filePath: string;
  /** Upstream kind hint when the daemon provided one; the
   *  card falls back to extension detection. */
  readonly artifactKind?: string;
  readonly updatedAt: number;
  readonly updated?: boolean;
}

/**
 * v1.16.5+ (M3, Phase C4): an authoritative task failure.
 * Only normalized real errors reach this kind — the Work
 * presenter gates them; the renderer never classifies.
 * `diagnosticId` is a correlation id for the Diagnostics
 * drawer, not user-facing detail.
 */
export interface ErrorMessage extends MessageBase {
  readonly kind: 'error';
  readonly userMessage: string;
  readonly diagnosticId: string;
}

/**
 * 2026-08-28 (Work chat-mode split): a renderer-side
 * suggestion shown right after a conversation send whose
 * text matches `looksLikeTaskIntent` — "this reads like a
 * work order; run it as one?". Pure UI affordance: it never
 * reaches the daemon unless the user clicks through.
 */
export interface TaskSuggestionMessage extends MessageBase {
  readonly kind: 'task_suggestion';
  /** The original conversation text to re-send as a task. */
  readonly text: string;
}

/**
 * M4-E (spec §6.7 Core "approval / input"): an inline
 * daemon permission request. Rendered by ApprovalCard with
 * Approve / Deny actions while `status === 'pending'`.
 * `id` is stable per approvalId so the granted/denied
 * follow-ups update the same card in place.
 *
 * P3 (spec §4.5): the same message shape now hosts Code
 * AND Work approvals. The `authority` tag tells the card
 * which authority owns the decision (and therefore which
 * endpoint the `onRespond` callback routes to); the
 * `preview` carries the unified, safe summary so the card
 * never has to re-parse the raw tool input. `autoApproved`
 * is only ever set on Work (Code has no auto-approve path);
 * Code requests always start as `pending` and resolve
 * through `onRespond` or a process exit.
 */
export interface ApprovalMessage extends MessageBase {
  readonly kind: 'approval';
  /** Stable identity — `${authority}:${requestId}` for Code,
   *  `approval:${runId}:${approvalId}` for Work. The mapper
   *  guarantees the same id on `approval_requested`,
   *  `approval_granted` and `approval_denied` so the card
   *  never duplicates. */
  readonly approvalId: string;
  readonly type: string | undefined;
  readonly description: string;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired';
  readonly autoApproved?: boolean;
  /** P3: which authority owns the decision. `managed` = a managed-work
   *  (CoWork ManagedSession) input/approval request bridged back through
   *  `managedSession.sendEvent(input.received)` (P3-B2/B3). */
  readonly authority: 'code' | 'work' | 'managed';
  /** P3: the safe, parsed preview. Persisted with the
   *  message so a refresh can re-render the same summary
   *  without re-reading the raw tool input (which is NOT
   *  persisted to the conversation record). */
  readonly preview?: import('../../approval/approval-preview').ApprovalPreview;
  /** P3 (Code only): a transient handle to the pending
   *  request in the in-memory CodePermissionRegistry.
   *  NOT persisted — on reload the request is restored
   *  via `approval.list` (Work) or lost (Code, the user
   *  must re-approve). The card uses it to drive the
   *  Diff preview button when the request is still alive. */
  readonly pendingRequest?: {
    readonly requestId: string;
    readonly projectKey: string;
    readonly conversationId: string;
    readonly processId: string;
    readonly toolName: string;
    /** Live tool input. The card never renders this directly;
     *  it routes through `buildApprovalPreview`. */
    readonly input: Readonly<Record<string, unknown>>;
  };
}

/**
 * M4-E (spec §6.7 Core "approval / input"): an inline
 * structured user-input question set. Rendered by
 * InputRequestCard; the user answers and submits (or
 * dismisses) while `status === 'pending'`.
 */
export interface InputRequestMessage extends MessageBase {
  readonly kind: 'input_request';
  readonly requestId: string;
  readonly questions: readonly import('@trylo/work').InputRequestQuestion[];
  readonly status: 'pending' | 'submitted' | 'dismissed';
  readonly answers?: Readonly<Record<string, import('@trylo/work').InputRequestAnswer>>;
}

// 2026-09-10 (applyWorkItem deletion面): WorkflowMessage / WorkflowPhase /
// WorkflowActivity deleted — the 2026-08-29 hierarchy projection. Its only
// producers (work-item-mapper / work-workflow-reducer) had zero production
// callers and were deleted in the same batch. The LINEAR task UI below
// (WorkRailMessage / WorkNarrationLine / DeliverableMessage, spec §4/§5/§6/§8)
// is a different projection and stays.

// ---------------------------------------------------------------------------
// 2026-08-29 (Work end-to-end workflow redesign spec §4 / §5 /
// §6 / §8): the LINEAR task UI message kinds. One task-intent run
// projects into a WorkRailMessage (the phase rail + full
// projection snapshot), zero-or-more WorkNarrationMessages (white
// narration lines, one per phase) and an optional
// DeliverableMessage (the deliverable-axis panel). Components
// render ONLY these projections — never raw frames (§11.3).
// Conversation-intent runs produce NONE of these (spec §3.1).
// 2026-09-10: WorkActivityGroupMessage ('work_activity_group')
// was removed — no producer since the Code-transcript unification
// (2026-09-10 T4 audit); the collapsed-activity aggregate lives on
// in CodeReasoningTranscript, and history-revived rows of the old
// kind render nothing (Message switch falls through).
// ---------------------------------------------------------------------------

/** The phase rail of one task run. Stable id `rail:${runId}`
 *  — exactly one per task-intent run (spec §4.1). Carries the
 *  full WorkTurnProjection snapshot so refresh / replay renders
 *  the identical rail. */
export interface WorkRailMessage extends MessageBase {
  readonly kind: 'work_rail';
  readonly runId: string;
  readonly projection: import('@trylo/work').WorkTurnProjection;
}

/** One white narration line (spec §5.3). Stable id
 *  `narration:${runId}:${phaseId}` — upserted in place as the
 *  phase narration grows; never stacked. */
export interface WorkNarrationLine extends MessageBase {
  readonly kind: 'work_narration';
  readonly runId: string;
  readonly phaseId: string;
  readonly text: string;
}

/** The deliverable-axis panel of one run (spec §8.5). Stable
 *  id `deliverable-projection:deliverable:${runId}` — created
 *  by the DeliverableWorkflowAdapter on the first deliverable
 *  fact. */
export interface DeliverableMessage extends MessageBase {
  readonly kind: 'deliverable';
  readonly deliverableId: string;
  readonly projection: import('@trylo/work').PresentationWorkflowProjection;
}

export type ChatMessage =
  | TextMessage
  | NoticeMessage
  | ToolMessage
  | ThinkingMessage
  | TurnMessage
  | CompactionMessage
  | SubagentMessage
  | ArtifactMessage
  | ErrorMessage
  | TaskSuggestionMessage
  | ApprovalMessage
  | InputRequestMessage
  | WorkRailMessage
  | WorkNarrationLine
  | DeliverableMessage
  | CognitionPromptMessage
  | LearningImpactMessage;

export interface CognitionPromptMessage extends MessageBase {
  readonly kind: 'cognition_prompt';
  readonly role: 'system';
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly dimension: string;
  readonly status: 'pending' | 'answered' | 'dismissed';
}

export interface LearningImpactMessage extends MessageBase {
  readonly kind: 'learning_impact';
  readonly role: 'system';
  readonly reason: string;
  readonly baseline: readonly string[];
  readonly personalized: readonly string[];
  readonly status: 'pending' | 'kept_baseline' | 'accepted';
}

// Foundation spec §0 rule 1 / §8.5: there is NO team_spawn message kind.
// The Person conversation is never interrupted by a "组建团队" card; the
// old TeamSpawnMessage type was removed with its renderer.

export function isUserMessage(m: ChatMessage): m is TextMessage & { role: 'user' } {
  return m.role === 'user' && m.kind === 'text';
}

// v1.16.5+ (Code-Work workflow sync spec §6.1): the single
// way both Code (`App.tsx` onSend) and Work (`handleWorkSend`)
// build the user message that starts a turn. It stamps
// `id = turnId`, `turnId`, `createdAt` and `turnStartedAt`
// so the TurnProgress timer starts the instant the user hits
// send — identically in both modes, with no per-mode user
// message construction left behind.
export interface BeginConversationTurnInput {
  readonly text: string;
  /** Display-only attachments to show on the sent user bubble (see
   *  `TextMessage.attachments`). */
  readonly attachments?: readonly SentAttachment[];
  /** Stable turnId — also used as the message id. Defaults
   *  to a fresh `user-<base36(now)>` id. */
  readonly turnId?: string;
  /** Unix ms. Defaults to Date.now(). */
  readonly now?: number;
}

/** Display-only snapshot of one attached file shown inside a sent user
 *  bubble. Carries just enough for the chip/preview; the CLI prompt is built
 *  from the real attachment store, never from this. */
export interface SentAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly size?: number;
  /** Session-scoped blob URL for an image thumbnail. Ephemeral — absent
   *  after reload, when the bubble falls back to a plain file chip. */
  readonly previewUrl?: string;
}

export function beginConversationTurn(
  input: BeginConversationTurnInput,
): TextMessage & { role: 'user' } {
  const now = input.now ?? Date.now();
  const turnId = input.turnId ?? `user-${now.toString(36)}`;
  return {
    id: turnId,
    turnId,
    role: 'user',
    kind: 'text',
    createdAt: now,
    turnStartedAt: now,
    text: input.text,
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
  };
}

/**
 * 2026-09-04 (context-ring compaction fix): the single derivation of
 * "the context size RIGHT NOW" for BOTH surfaces' ContextRing.
 *
 * The old Code-side derivation read only the latest `turn` message's
 * `usage.input_tokens`, so after a compaction the ring kept showing the
 * PRE-compaction size until the next turn finished. The fix: walk the
 * stream BACKWARD and take whichever evidence is NEWEST —
 *   - a `compaction` message's `tokensAfter` (the CLI's post-compact size), or
 *   - a `turn` message's `usage.input_tokens`.
 * A compaction between turns therefore drops the ring immediately
 * (180k → 40k), and the next turn_end simply refreshes the same number.
 */
export function latestContextTokens(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    // Skip turn evidence without a usable reading: the CLI omits
    // input_tokens when a response carries no usage (e.g. some
    // OpenAI-format providers). Returning undefined here would
    // freeze/reset the ring at a stale value — fall through to
    // the last good reading instead.
    if (m.kind === 'turn' && m.usage && typeof m.usage.input_tokens === 'number' && m.usage.input_tokens > 0) {
      return m.usage.input_tokens;
    }
    if (m.kind === 'compaction') return m.tokensAfter ?? 0;
  }
  return 0;
}
