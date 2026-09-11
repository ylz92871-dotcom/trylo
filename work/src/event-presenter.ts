// Trylo Work — EventPresenter.
//
// v1.16.5+ (W-UI-002, Phase 3 of the M1 lifecycle
// milestone): the second layer after the EventRouter.
// The router produces a `RouterDecision` keyed on
// taskId and the high-level intent (notice / error /
// hint). The presenter looks INSIDE the frame payload
// to classify the event into a stable
// `ConversationItem` union that the renderer can
// render without ever reading upstream shapes.
//
// Why two layers:
//   - the router must run BEFORE the registry knows
//     whether the task is owned / terminal; it cannot
//     depend on per-event content.
//   - the presenter can assume the task is owned and
//     read the inner type / message / group / step
//     fields. It is the only place that names
//     "thinking", "plan", "tool", "artifact", etc.
//
// Pure: no React, no I/O, no daemon call. The renderer
// maps `ConversationItem` to its own `ChatMessage`
// shape and to the visible UI surface.

import { normalizeError, isErrorEvent } from "./event-normalizer.js";
import { canonicalAbsolutePath } from "./artifact-paths.js";
import type { EventFrame } from "./control-plane/types.js";
import type { DeliverableFactBody } from "./deliverables/deliverable-domain.js";
import { detectDeliverableKindFromTool } from "./deliverables/deliverable-registry.js";
import { isTrivialFinalText } from "./work-result-resolver.js";

/** One structured question in an input request (mirrors the
 *  upstream `RequestUserInputQuestion` shape, re-declared so
 *  the presenter stays vendor-payload-free for consumers). */
export interface InputRequestQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
}

/** A user response to one input-request question (upstream
 *  `InputRequestAnswer`). */
export interface InputRequestAnswer {
  readonly optionLabel?: string;
  readonly otherText?: string;
}

/** Stable identity of one execution (M3 closure spec
 *  §2.1). Attached to every ConversationItem by the
 *  runtime's consumeFrame — the presenter itself stays
 *  identity-free. */
export interface WorkRunIdentity {
  readonly taskId: string;
  readonly runId: string;
  /** The user message that started this run. Persisted
   *  with the binding; never guessed from the latest
   *  user message (spec §2.2). */
  readonly turnId: string | undefined;
  /** 2026-08-29 (redesign spec §2.3): the snapshotted
   *  conversation/task intent, attached by the runtime
   *  from the registry binding. The renderer NEVER
   *  rediscovers intent from "did a tool event appear";
   *  absent on legacy/recovered frames. */
  readonly intent?: "conversation" | "task";
}

/** What the presenter decides to do with one frame.
 *  Returning null means "don't show this in the main
 *  Conversation at all" — it either goes to Diagnostics
 *  (a low-noise drawer) or is dropped entirely.
 *
 *  The `conversationId` and the WorkRunIdentity fields
 *  are filled in by the runtime from the TaskRegistry
 *  binding, not by the presenter itself. The presenter
 *  is pure and does not know about conversations; the
 *  runtime is the layer that joins an upstream `taskId`
 *  to a Trylo conversation. */
export type ConversationItemBody =
  // `phaseId` (spec §5.2 / §6.3): when the frame carries an
  // upstream groupId we pass it through — that is the
  // authoritative phase boundary. When it is absent the
  // mapper synthesizes a stable default phase (§6.3).
  | { kind: "thinking"; id: string; at: number; conversationId: string; text: string; phaseId?: string }
  | { kind: "plan"; id: string; at: number; conversationId: string; stage: "started" | "finished"; name: string; text: string; phaseId?: string }
  | { kind: "progress"; id: string; at: number; conversationId: string; text: string; phaseId?: string; toolCallId?: string }
  // `id` is derived from the upstream stepId so the
  // running → done/error transitions of the SAME tool
  // invocation share one id and the renderer updates the
  // card in place instead of appending a second one.
  // `toolCallId` is that same upstream stepId — the stable
  // invocation id command output routes back into (§6.4).
  | { kind: "tool"; id: string; at: number; conversationId: string; tool: string; summary: string; status: "running" | "done" | "error" | "interrupted"; phaseId?: string; toolCallId?: string }
  | { kind: "artifact"; id: string; at: number; conversationId: string; filePath: string; artifactKind: string | undefined }
  // M4-E (spec §6.7 Core "approval / input"): a daemon
  // permission request or structured user-input question
  // set, presented inline so the run does not fail waiting
  // for a decision Trylo never surfaced. `id` is stable per
  // approvalId / requestId so the granted/denied and
  // resolved/dismissed follow-ups UPDATE the same card.
  | {
      kind: "approval";
      id: string;
      at: number;
      conversationId: string;
      approvalId: string;
      type: string | undefined;
      description: string;
      status: "pending" | "approved" | "denied";
      autoApproved?: boolean;
      /** P3 (spec §4.6): upstream approval record verbatim
       *  (path, toolInput, command, …). The Desktop mapper
       *  forwards it to the safe preview parser; the full
       *  record is never written to the conversation
       *  history. */
      details?: Record<string, unknown>;
    }
  | {
      kind: "input_request";
      id: string;
      at: number;
      conversationId: string;
      requestId: string;
      questions: readonly InputRequestQuestion[];
      status: "pending" | "submitted" | "dismissed";
      /** Present on `input_request_resolved` so the card can
       *  show what the user submitted. */
      answers?: Readonly<Record<string, InputRequestAnswer>>;
    }
  | { kind: "final"; id: string; at: number; conversationId: string; text: string }
  | { kind: "cancelled"; id: string; at: number; conversationId: string; text: string }
  | { kind: "error"; id: string; at: number; conversationId: string; userMessage: string; diagnosticId: string }
  // 2026-08-29 (redesign spec §8.7 step 1): a deliverable-
  // relevant tool fact (generator tool_call / tool_result).
  // Gated on the registry's generator allowlist so normal
  // tool traffic never enters this channel. The chat mapper
  // ignores it; the deliverable adapter owns it.
  | { kind: "deliverable_fact"; id: string; at: number; conversationId: string; fact: DeliverableFactBody }
  | { kind: "diagnostics"; id: string; at: number; conversationId: string; text: string };

/** The item the renderer consumes: the semantic body
 *  PLUS the run identity it belongs to (spec §2.4). The
 *  mapper must derive turn/run membership from this
 *  identity, never from surrounding messages. */
export type ConversationItem = WorkRunIdentity & ConversationItemBody;

/** Inner type of a `task.event` payload, narrowed to
 *  what the presenter reads. */
interface TaskEventInner {
  type?: string;
  status?: string;
  // 2026-08-29 (redesign spec §8.3): the executor emits
  // `tool_call` / `tool_result` records with the fields at
  // the RECORD top level ({ type, tool, input / result }),
  // not nested under `payload` like the timeline events.
  tool?: string;
  input?: Record<string, unknown>;
  payload?: {
    message?: string;
    filePath?: string;
    path?: string;
    kind?: string;
    stepId?: string;
    groupId?: string;
    tool?: string;
    // 2026-08-29 (redesign spec §8.3): some builds nest the
    // generator input under `payload` instead of the record
    // top level. Read both.
    input?: Record<string, unknown>;
    summary?: string;
    /** The vendor stores the original semantic event name when it
     *  wraps it in a timeline_* record. Completion recordings use
     *  `timeline_step_finished + legacyType=task_completed`. */
    legacyType?: string;
    /** Authoritative user-facing completion text emitted by the
     *  executor. This is richer than the wrapper message
     *  "Task completed successfully". */
    resultSummary?: string;
    bestKnownOutcome?: { resultSummary?: string };
    routeReason?: string;
    /** The vendor nests the tool description under `payload.step`
     *  (`{ id, description }`) for the tool lanes. */
    step?: { id?: unknown; description?: unknown };
    /** The vendor repeats `llm_slow` on an interval with a growing
     *  elapsedMs; the "已等待 Ns" counter reads it. */
    elapsedMs?: unknown;
    output?: string;
    actor?: string;
    status?: string;
    // M4-E: approval / input-request payloads. `approval`
    // and `request` are the full upstream records emitted on
    // `*_requested` / `*_created`; the `*_id` fields carry
    // the transition events (`approval_granted`, `approval_
    // denied`, `input_request_resolved`, `input_request_
    // dismissed`).
    approval?: Record<string, unknown>;
    approvalId?: string;
    autoApproved?: boolean;
    request?: Record<string, unknown>;
    requestId?: string;
    answers?: Record<string, InputRequestAnswer>;
    questions?: unknown;
  };
  seq?: number;
}

function asInner(value: unknown): TaskEventInner | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as TaskEventInner;
}

/** A frame that does not carry useful content for the
 *  user — usually a low-level daemon bookkeeping event
 *  the renderer should not surface. The presenter
 *  hides these from the main Conversation; the
 *  Diagnostics log (built from the raw frame summary)
 *  still has them. */
function isBookkeeping(inner: TaskEventInner): boolean {
  // The vendor emits a stream of `timeline_step_updated`
  // for every step in the agent loop. The message is
  // often empty (heartbeat) or low-signal (transient
  // retries). Hiding them keeps the Conversation
  // readable; the full timeline is in Diagnostics.
  if (inner.type === "timeline_step_updated") {
    const message = inner.payload?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return true;
    }
  }
  // `skill-routing` and other protocol-internal events
  // were the source of the "SYSTEM · [skill-routing]"
  // noise in the previous UI. They are useful for
  // debugging but not for the user.
  if (
    inner.type === "skill_invoked" ||
    inner.type === "api_call" ||
    inner.type === "api_stream" ||
    inner.type === "api_retry" ||
    inner.type === "model_fallback" ||
    inner.type === "permission_denied" ||
    inner.type === "todo_updated" ||
    inner.type === "memory_updated" ||
    inner.type === "plan_mode_transition"
  ) {
    return true;
  }
  return false;
}

/** Build a stable id scoped to a run (spec §2.4). When
 *  the frame carries a server sequence we use it so the
 *  same event always produces the same id — replays
 *  upsert instead of duplicating. Without a seq we fall
 *  back to a fresh suffix (still run-scoped, so it can
 *  never collide with another run's cards). */
function runScopedId(
  prefix: string,
  runId: string,
  seq: number | undefined,
): string {
  if (seq !== undefined) return `${prefix}:${runId}:${seq}`;
  return `${prefix}:${runId}:${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** Spec §5.2 / §6.3: the authoritative phaseId when the
 *  daemon names the group a step/group belongs to. Absent
 *  groupId → undefined — the mapper then synthesizes a
 *  stable default phase so consecutive agent updates share
 *  one card even when the daemon gives no group boundary. */
function phaseIdOf(inner: TaskEventInner): string | undefined {
  const groupId = inner.payload?.groupId;
  return typeof groupId === "string" && groupId.length > 0
    ? groupId
    : undefined;
}

/** Spec §6.4: the stable tool invocation id (upstream
 *  stepId) when present. Command output that carries the
 *  same stepId routes back into that ToolCard. */
function toolCallIdOf(inner: TaskEventInner): string | undefined {
  const stepId = inner.payload?.stepId;
  return typeof stepId === "string" && stepId.length > 0
    ? stepId
    : undefined;
}

/**
 * The daemon's tool lanes do NOT carry a `tool` field. Their payload is
 * `{ stepId, step: { id, description }, groupId, status, actor, message,
 * legacyType }` and the tool name only appears inside `step.description` /
 * `message`, wrapped in progress phrasing:
 *
 *   step_started   → message "Running list_directory", step.description
 *                    "Running list_directory"
 *   step_completed → message "list_directory completed", step.description
 *                    "list_directory"
 *
 * Reading `payload.tool` here therefore always fell through to the literal
 * string "tool", which made EVERY tool activity unclassifiable — measured on
 * the recorded runs, 96 of 103 activities (93.2%) collapsed into the `other`
 * bucket and the UI could only offer a meaningless "操作 N" summary.
 */
function toolNameOf(inner: TaskEventInner): string {
  const direct = inner.payload?.tool;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const step = inner.payload?.step as { description?: unknown } | undefined;
  const candidates = [
    typeof step?.description === "string" ? step.description : "",
    typeof inner.payload?.message === "string" ? inner.payload.message : "",
  ];
  for (const raw of candidates) {
    const cleaned = raw
      .replace(/^\s*(running|executing|calling|using|invoking)\s+/i, "")
      .replace(/\s+(completed|finished|done|failed|succeeded)\.?\s*$/i, "")
      .trim();
    // Reject anything that is clearly a sentence rather than a tool name:
    // a tool identifier is short and has no spaces.
    if (cleaned.length > 0 && cleaned.length <= 60 && !/\s/.test(cleaned)) {
      return cleaned;
    }
  }
  return "tool";
}

/**
 * Protocol-internal chatter the daemon emits with `actor: "agent"`.
 *
 * None of it is reasoning a user should read: it is prompt assembly,
 * provider-routing decisions, and wrappers around errors that already have
 * their own error card. While narrations were capped at one line per phase
 * this noise was masked by accident (only the last line survived); once
 * narrations accumulate, letting it through turns the panel into a debug log.
 *
 * Observed in the recorded runs: "Execution prompt built", "Follow-up prompt
 * built", "Processing follow-up message", "LLM route selected: provider=…",
 * "Glob search: *.xlsx in …", "Executing step 9/9: …".
 */
const BOOKKEEPING_PATTERNS: readonly RegExp[] = [
  /prompt built\s*$/i,
  /^\s*processing follow-up message\s*$/i,
  /^llm route selected:/i,
  /^llm provider updated/i,
  /^(glob|grep|read|search|find)\s+search:/i,
  /^executing step \d+\/\d+:/i,
  /^completed step \d+:/i,
  /^i hit an internal error while processing your follow-up:/i,
  /^follow-up failed:/i,
  /^task (created|resumed|started)\s*$/i,
  /^session (initialized|restored)\s*$/i,
  // The daemon's own "we finished the plan" marker. The Work phase rail
  // already renders completion, and when a run has no real final answer this
  // string was being surfaced AS the final reply — which is exactly the
  // "All steps completed" the user saw instead of an actual answer.
  /^all steps completed\s*$/i,
  // Protocol-tagged internal markers such as
  // "[skill-routing] plan.create.start" / "[skill-routing]
  // plan.high-confidence-hints". These are routing bookkeeping, not reasoning.
  /^\[[a-z][a-z0-9_-]*\]\s/i,
];

function isBookkeepingNoise(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  return BOOKKEEPING_PATTERNS.some((re) => re.test(t));
}

/** Present a single frame as a ConversationItem, or
 *  return null to skip it. `runId` scopes every item id
 *  (spec §2.4): cards, projections and diagnostics key
 *  off it, never off taskId alone. */
export function presentTaskEvent(
  frame: EventFrame,
  // taskId is kept for log correlation; id scoping moved
  // to runId (M3 closure spec §2).
  _taskId: string,
  runId: string,
): ConversationItemBody | null {
  if (frame.event !== "task.event") return null;
  const inner = asInner(frame.payload);
  if (!inner) return null;
  const at = Date.now();
  const innerType = typeof inner.type === "string" ? inner.type : "";
  const message = inner.payload?.message;
  const seq =
    typeof inner.seq === "number" && Number.isFinite(inner.seq)
      ? inner.seq
      : undefined;

  // Real errors first — the rest of the classification
  // assumes the event is not an error. NOTE: in the
  // single-entry pipeline (consumeFrame) errors are
  // built directly from the router decision so the
  // ErrorCard shares ONE diagnosticId (M3-P1-06); this
  // branch stays as the defensive fallback for direct
  // callers.
  if (isErrorEvent(frame)) {
    const norm = normalizeError(frame);
    if (norm) {
      return {
        kind: "error",
        id: `error:${runId}:${norm.diagnosticId}`,
        at,
        conversationId: "",
        userMessage: norm.userMessage,
        diagnosticId: norm.diagnosticId,
      };
    }
  }

  // The real cowork recordings do not emit a standalone
  // `assistant_final` event. Instead the executor wraps completion as:
  //   timeline_step_finished {
  //     legacyType: "task_completed",
  //     message: "Task completed successfully",
  //     resultSummary: "<actual answer>"
  //   }
  // The previous presenter fell through to the generic progress branch,
  // discarded resultSummary, and left terminal resolution to reuse an
  // earlier planning narration. Project the authoritative result now so
  // both conversation and task turns end with the real white answer.
  const legacyType = inner.payload?.legacyType;
  if (innerType === "task_completed" || legacyType === "task_completed") {
    const direct = inner.payload?.resultSummary;
    const bestKnown = inner.payload?.bestKnownOutcome?.resultSummary;
    const text =
      typeof direct === "string" && direct.trim().length > 0
        ? direct.trim()
        : typeof bestKnown === "string" && bestKnown.trim().length > 0
          ? bestKnown.trim()
          : "";
    // A provider timeout can leave a serialized tool call in
    // bestKnownOutcome/resultSummary.  It is protocol residue, not an
    // assistant answer.  Reject it here as well as in the terminal
    // resolver: otherwise this event is projected first and permanently
    // occupies the run's single final-answer slot.
    if (text.length > 0 && !isTrivialFinalText(text)) {
      return {
        kind: "final",
        id: `final:${runId}`,
        at,
        conversationId: "",
        text,
      };
    }
    // Do not fall through and render the generic wrapper message
    // ("Task completed successfully") as ordinary progress.  Terminal
    // reconciliation will build the honest fallback or failure result.
    return null;
  }

  if (innerType === "timeline_step_updated" && legacyType === "llm_retry") {
    return {
      kind: "progress",
      id: `retry:${runId}`,
      at,
      conversationId: "",
      text: "模型响应较慢，正在重试…",
      phaseId: phaseIdOf(inner),
    };
  }
  if (innerType === "timeline_step_updated" && legacyType === "llm_slow") {
    // `llm_slow` repeats on an interval while the request is still live; each
    // emission updates the elapsed time in the same progress message rather
    // than appending a new bubble. The id is run-stable so the mapper upserts.
    const elapsedMs = inner.payload?.elapsedMs;
    const waited =
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
        ? Math.max(1, Math.round(elapsedMs / 1000))
        : null;
    return {
      kind: "progress",
      id: `slow:${runId}`,
      at,
      conversationId: "",
      text:
        waited !== null
          ? `模型仍在响应，任务没有中断（已等待 ${waited}s）…`
          : "模型仍在响应，任务没有中断…",
      phaseId: phaseIdOf(inner),
    };
  }
  if (innerType === "timeline_step_updated" && legacyType === "llm_plan_fallback") {
    return {
      kind: "progress",
      id: `plan-recovery:${runId}`,
      at,
      conversationId: "",
      text: "规划响应较慢，已切换安全方案继续执行…",
      phaseId: phaseIdOf(inner),
    };
  }
  if (
    innerType === "timeline_step_updated" &&
    legacyType === "llm_routing_changed" &&
    inner.payload?.routeReason === "provider_outage"
  ) {
    return {
      kind: "progress",
      id: runScopedId("recovery", runId, seq),
      at,
      conversationId: "",
      text: "模型连接异常，正在恢复…",
      phaseId: phaseIdOf(inner),
    };
  }

  switch (innerType) {
    case "timeline_group_started":
      return {
        kind: "plan",
        id: runScopedId("plan", runId, seq),
        at,
        conversationId: "",  // runtime fills this in
        stage: "started",
        name: message ?? "(unnamed stage)",
        text: message ?? "",
        phaseId: phaseIdOf(inner),
      };
    case "timeline_group_finished":
      // v1.16.5+ (W-UI-002): the previous UI rendered
      // this as `Task failed: Completed DISCOVER`
      // because the message was the only field the
      // renderer read and the error branch had a
      // too-permissive gate. The fix is in two places:
      //   1. isErrorEvent / normalizeError no longer
      //      treat timeline_group_finished as an
      //      error shape (see KNOWN_NON_ERROR_TYPES);
      //   2. here, the presenter classifies it as
      //      "plan stage finished", which is what it
      //      actually is.
      return {
        kind: "plan",
        id: runScopedId("plan", runId, seq),
        at,
        conversationId: "",
        stage: "finished",
        name: message ?? "(unnamed stage)",
        text: message ?? "",
        phaseId: phaseIdOf(inner),
      };
    case "timeline_artifact_emitted": {
      // The vendor emitter names the field `path`; older
      // daemon builds used `filePath`. Accept both so
      // the artifact card does not silently vanish on a
      // vendor bump.
      const filePath = inner.payload?.filePath ?? inner.payload?.path;
      if (typeof filePath !== "string" || filePath.length === 0) return null;
      // §9.2: canonicalize BEFORE identity so a re-emit
      // with different separators or drive casing upserts
      // the same card instead of duplicating it.
      const canonical = canonicalAbsolutePath(filePath) ?? filePath;
      return {
        kind: "artifact",
        // Path canonicalization and cross-source dedupe
        // happen in WorkArtifactStore (spec §9.2); the id
        // is run-scoped so one run's re-emits upsert.
        id: `artifact:${runId}:${canonical}`,
        at,
        conversationId: "",
        filePath: canonical,
        artifactKind: inner.payload?.kind,
      };
    }
    // M4-E (spec §6.7 Core "approval / input"): inline
    // decision cards. The ids are stable per approvalId /
    // requestId (run-scoped per spec §2.4) so the granted /
    // denied and resolved / dismissed follow-ups UPDATE the
    // same card instead of appending a second one.
    case "approval_requested": {
      const approval = inner.payload?.approval;
      if (
        !approval ||
        typeof approval.id !== "string" ||
        approval.id.length === 0
      ) {
        return null;
      }
      const approvalId = approval.id;
      const recStatus = typeof approval.status === "string" ? approval.status : "";
      const status: "pending" | "approved" | "denied" =
        recStatus === "approved"
          ? "approved"
          : recStatus === "denied"
            ? "denied"
            : "pending";
      return {
        kind: "approval",
        id: `approval:${runId}:${approvalId}`,
        at,
        conversationId: "",
        approvalId,
        type: typeof approval.type === "string" ? approval.type : undefined,
        description:
          typeof approval.description === "string" && approval.description.length > 0
            ? approval.description
            : "Permission request",
        status,
        autoApproved: inner.payload?.autoApproved === true,
        // P3 (spec §4.6): forward the upstream record so the
        // Desktop mapper can project it through the safe
        // preview builder. The record may carry `toolInput`,
        // `path`, `command`, etc. — the consumer is
        // responsible for redaction.
        details: approval,
      };
    }
    case "approval_granted":
    case "approval_denied": {
      const approvalId =
        typeof inner.payload?.approvalId === "string"
          ? inner.payload.approvalId
          : "";
      if (approvalId.length === 0) return null;
      return {
        kind: "approval",
        id: `approval:${runId}:${approvalId}`,
        at,
        conversationId: "",
        approvalId,
        type: undefined,
        description: "",
        status: innerType === "approval_granted" ? "approved" : "denied",
        autoApproved: inner.payload?.autoApproved === true,
      };
    }
    case "input_request_created": {
      const request = inner.payload?.request;
      if (
        !request ||
        typeof request.id !== "string" ||
        request.id.length === 0
      ) {
        return null;
      }
      const requestId = request.id;
      const recStatus = typeof request.status === "string" ? request.status : "";
      return {
        kind: "input_request",
        id: `input_request:${runId}:${requestId}`,
        at,
        conversationId: "",
        requestId,
        questions: normalizeInputRequestQuestions(request.questions),
        status:
          recStatus === "submitted"
            ? "submitted"
            : recStatus === "dismissed"
              ? "dismissed"
              : "pending",
      };
    }
    case "input_request_resolved":
    case "input_request_dismissed": {
      const requestId =
        typeof inner.payload?.requestId === "string"
          ? inner.payload.requestId
          : "";
      if (requestId.length === 0) return null;
      return {
        kind: "input_request",
        id: `input_request:${runId}:${requestId}`,
        at,
        conversationId: "",
        requestId,
        questions: [],
        status: innerType === "input_request_resolved" ? "submitted" : "dismissed",
        answers: inner.payload?.answers,
      };
    }
    case "timeline_command_output": {
      // stdout / stderr from a tool the agent ran. The
      // vendor broadcasts the text in `payload.output`
      // (handlers.ts truncates `payload.output` for this
      // event type); older builds used `message`. Read
      // both so the card does not go empty on either
      // (M3-P1-04).
      const output = inner.payload?.output;
      const text =
        typeof output === "string" && output.length > 0
          ? output
          : message;
      if (typeof text !== "string" || text.length === 0) return null;
      return {
        kind: "progress",
        id: runScopedId("cmd", runId, seq),
        at,
        conversationId: "",
        text,
        // Spec §6.4: carry the group + step so the mapper
        // can route output into the right ToolCard when the
        // step matches a running tool.
        phaseId: phaseIdOf(inner),
        toolCallId: toolCallIdOf(inner),
      };
    }
    case "timeline_step_started":
    case "timeline_step_updated":
    case "timeline_step_finished": {
      const actor = inner.payload?.actor;
      const stepId = typeof inner.payload?.stepId === "string"
        ? inner.payload.stepId
        : undefined;
      // Tool invocations map to the shared ToolCard. The
      // vendor marks them with actor="tool" and a stable
      // stepId, so the id is `tool-<stepId>` and the
      // started → finished pair updates one card.
      if (actor === "tool" && stepId) {
        const failed = inner.payload?.status === "failed";
        const status = innerType === "timeline_step_finished"
          ? (failed ? "error" as const : "done" as const)
          : "running" as const;
        return {
          kind: "tool",
          // §2.4: `tool:${runId}:${stepId}` — the
          // started → finished pair of one invocation
          // shares the id AND can never collide with the
          // same stepId from a different run (M3-P1-03).
          id: `tool:${runId}:${stepId}`,
          at,
          conversationId: "",
          tool: toolNameOf(inner),
          summary: typeof message === "string" ? message : "",
          status,
          // §5.2/§6.4: the stable invocation id IS the
          // stepId; the phase is the upstream groupId
          // (when the daemon names one).
          phaseId: phaseIdOf(inner),
          toolCallId: stepId,
        };
      }
      // Meaningful agent reasoning feeds the aggregated
      // Thinking card. Heartbeats (empty message) stay
      // hidden, and protocol-internal bookkeeping is filtered
      // out below instead of being shown as "thinking".
      if (
        innerType === "timeline_step_updated" &&
        (actor === "agent" || actor === undefined)
      ) {
        if (typeof message !== "string" || message.trim().length === 0) {
          return null;
        }
        if (isBookkeepingNoise(message)) return null;
        return {
          kind: "thinking",
          // §2.4: ONE thinking card per run — every
          // thinking item of the run shares this id so
          // the mapper aggregates instead of spawning a
          // new card per frame.
          id: `thinking:${runId}`,
          at,
          conversationId: "",
          text: message,
          phaseId: phaseIdOf(inner),
        };
      }
      if (innerType === "timeline_step_updated") return null;
      // Step transitions are progress markers, not
      // content the user needs to read individually.
      // Surface only when there is a meaningful message.
      if (typeof message !== "string" || message.trim().length === 0) {
        return null;
      }
      if (isBookkeepingNoise(message)) return null;
      return {
        kind: "progress",
        id: runScopedId("step", runId, seq),
        at,
        conversationId: "",
        text: message,
        phaseId: phaseIdOf(inner),
      };
    }
    case "timeline_evidence_attached":
      // Evidence is debug-level detail; route to
      // Diagnostics only.
      return {
        kind: "diagnostics",
        id: runScopedId("diag", runId, seq),
        at,
        conversationId: "",
        text:
          typeof message === "string" ? message : "[evidence attached]",
      };
    // 2026-08-29 (redesign spec §8.3 / §8.7): the executor
    // emits `tool_call` / `tool_result` records with `tool`
    // and the FULL `input` at the record top level. For the
    // deliverable generator allowlist we forward a typed
    // fact so the DeliverableWorkflowAdapter can project the
    // real slides array — zero vendor changes, and the chat
    // timeline never sees raw tool inputs.
    case "tool_call": {
      const tool = typeof inner.tool === "string"
        ? inner.tool
        : typeof inner.payload?.tool === "string"
          ? inner.payload.tool
          : "";
      if (!detectDeliverableKindFromTool(tool)) return null;
      const input = inner.input ?? inner.payload?.input;
      return {
        kind: "deliverable_fact",
        id: runScopedId("dfact", runId, seq),
        at,
        conversationId: "",
        fact: {
          type: "tool_call",
          tool,
          ...(input && typeof input === "object" ? { input } : {}),
        },
      };
    }
    case "tool_result":
    case "tool_error": {
      const tool = typeof inner.tool === "string"
        ? inner.tool
        : typeof inner.payload?.tool === "string"
          ? inner.payload.tool
          : "";
      if (!detectDeliverableKindFromTool(tool)) return null;
      return {
        kind: "deliverable_fact",
        id: runScopedId("dfact", runId, seq),
        at,
        conversationId: "",
        fact: {
          type: "tool_result",
          tool,
          ok: innerType === "tool_result" && inner.payload?.status !== "failed",
        },
      };
    }
  }

  // Bookkeeping filter — see isBookkeeping.
  if (isBookkeeping(inner)) {
    if (typeof message === "string" && message.length > 0) {
      return {
        kind: "diagnostics",
        id: runScopedId("diag", runId, seq),
        at,
        conversationId: "",
        text: message,
      };
    }
    return null;
  }

  // Generic notice: surface as progress.
  if (typeof message !== "string" || message.length === 0) return null;
  return {
    kind: "progress",
    id: runScopedId("note", runId, seq),
    at,
    conversationId: "",
    text: message,
  };
}

/** Normalize an upstream `RequestUserInputQuestion[]` payload
 *  into the presenter's stable shape. Malformed entries are
 *  dropped; empty results yield `[]` (the card renders as
 *  pending with no questions). */
export function normalizeInputRequestQuestions(
  raw: unknown,
): readonly InputRequestQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: InputRequestQuestion[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const q = entry as Record<string, unknown>;
    const id = typeof q.id === "string" ? q.id : "";
    const question = typeof q.question === "string" ? q.question : "";
    if (id.length === 0 && question.length === 0) continue;
    const options: { readonly label: string; readonly description: string }[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (typeof o !== "object" || o === null) continue;
        const rec = o as Record<string, unknown>;
        options.push({
          label: typeof rec.label === "string" ? rec.label : "",
          description: typeof rec.description === "string" ? rec.description : "",
        });
      }
    }
    out.push({
      id,
      header: typeof q.header === "string" ? q.header : "",
      question,
      options,
    });
  }
  return out;
}
