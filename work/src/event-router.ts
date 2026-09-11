// Trylo Work — EventRouter.
//
// v1.16.5+ (W-RUN-003, Phase B2 of the M1 lifecycle
// milestone): routes a raw ControlPlane `task.event`
// frame to the right consumer using the taskId the daemon
// now includes in every broadcast (see upstream
// `vendor/cowork-os/src/electron/control-plane/handlers.ts`
// around line 2269 — `server.broadcastToOperators(
// Events.TASK_EVENT, { taskId, type, payload, ... })`).
//
// Previous behaviour (App.tsx v1.16.4) routed every
// `task.event` to a single `workRunTargetRef` regardless
// of which task emitted it, so concurrent tasks in the
// same workspace misattributed each other's progress. The
// router here is the corrective layer.
//
// Three responsibilities:
//   1. Extract the taskId from the frame.
//   2. Look up the TaskRecord in the TaskRegistry.
//   3. Decide what to do with the event and return a
//      decision the renderer can act on.
//
// Pure: no side effects on the registry. The renderer
// applies the decision (e.g. update status, push a
// message to the conversation, fire the reconciler). All
// routing logic is testable in isolation.

import {
  isErrorEvent,
  normalizeError,
  type NormalizedErrorCode,
} from "./event-normalizer.js";
import {
  isTerminal,
  type TaskRegistry,
  type TaskStatus,
} from "./task-registry.js";
import type { EventFrame } from "./control-plane/types.js";

/** What the renderer should do with this event. The
 *  renderer is responsible for pushing the message into
 *  the correct conversation and (for terminal events)
 *  updating the registry status. */
export type RouterDecision =
  | { kind: "ignore" }
  | { kind: "drop_unknown_task" }
  | { kind: "drop_terminal_task" }
  | {
      kind: "task_error";
      taskId: string;
      conversationId: string;
      userMessage: string;
      diagnosticId: string;
      /** Stable normalizer code, carried into the
       *  diagnostic record (spec §10.1). */
      errorCode: NormalizedErrorCode;
    }
  | {
      kind: "task_notice";
      taskId: string;
      conversationId: string;
      text: string;
      /** Daemon-supplied status, if any (e.g. from
       *  task events that carry a `status` field). The
       *  reconciler uses this for early hints, but the
       *  reconciler's task.get polling remains the source
       *  of truth. */
      daemonStatus: string | undefined;
    }
  | {
      kind: "task_terminal_hint";
      taskId: string;
      conversationId: string;
      /** Best-effort terminal status from the event. The
       *  renderer should treat this as a hint, not as
       *  truth — the reconciler will confirm via task.get. */
      status: TaskStatus;
    };

/** Inner type of a `task.event` payload, narrowed to what
 *  the router cares about. We only read fields; we never
 *  hand the raw payload back to the UI. */
interface TaskEventPayload {
  taskId?: string;
  type?: string;
  status?: string;
  payload?: {
    message?: string;
    legacyType?: string;
    attempt?: number;
    maxRetries?: number;
    routeReason?: string;
  };
  seq?: number;
}

function asPayload(value: unknown): TaskEventPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as TaskEventPayload;
}

/** M4-E (spec §6.7 Core "approval / input"): inner event
 *  types that carry a decision card the presenter projects.
 *  The bridge allowlist already forwards them; the router
 *  must pass them through as notices (the generic
 *  `payload.payload.message` check would otherwise drop
 *  them, because approval/input events carry `approval` /
 *  `request` records instead of `message`). */
const DECISION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "input_request_created",
  "input_request_resolved",
  "input_request_dismissed",
]);

/** Decide what to do with one frame. Pure. */
export function routeTaskEvent(
  frame: EventFrame,
  registry: TaskRegistry,
): RouterDecision {
  // 1. Not a task event → ignore.
  if (frame.event !== "task.event") return { kind: "ignore" };

  // 2. Bad payload → ignore silently. App.tsx used to
  //    console.warn here; we don't, because that path
  //    fires hundreds of times per second and is normal
  //    bookkeeping that the user does not need to see.
  const payload = asPayload(frame.payload);
  if (!payload) return { kind: "ignore" };

  // 3. No taskId → the frame is a top-level `task.event`
  //    without a routing key. The vendor only does this
  //    for legacy paths; we ignore.
  const taskId = payload.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { kind: "ignore" };
  }

  // 4. Unknown task → drop. This is the case codex called
  //    "events for a task we don't own arrive" — e.g.
  //    another project's task, or a task that was
  //    already cleaned up. Critical: do NOT deliver to
  //    any conversation.
  const record = registry.get(taskId);
  if (!record) return { kind: "drop_unknown_task" };

  // 5. Terminal task → drop. The reconciler is the only
  //    one allowed to mark a task terminal; once it has,
  //    any late events for that task are stale.
  if (isTerminal(record.status)) {
    return { kind: "drop_terminal_task" };
  }

  // 6. Error events → use the normalizer. Produces a
  //    user-facing message and a diagnostic id; the
  //    registry update is the renderer's job (it may
  //    also want to surface a retry / copy-diagnostics
  //    button, which the router knows nothing about).
  if (isErrorEvent(frame)) {
    const norm = normalizeError(frame);
    if (norm) {
      return {
        kind: "task_error",
        taskId,
        conversationId: record.conversationId,
        userMessage: norm.userMessage,
        diagnosticId: norm.diagnosticId,
        errorCode: norm.errorCode,
      };
    }
  }

  // 7. Hint of terminal status from the event itself.
  //    vendor can attach a `status` field to certain
  //    events; treat as a hint, never as truth. The
  //    reconciler's task.get polling will confirm.
  const innerType = typeof payload.type === "string" ? payload.type : "";
  const legacyType = payload.payload?.legacyType;
  if (
    innerType === "execution_run_summary" ||
    innerType === "task_completed" ||
    innerType === "task_cancelled" ||
    (innerType === "timeline_step_updated" &&
      payload.payload?.message === "execution_run_summary")
  ) {
    const hintStatus: TaskStatus =
      innerType === "task_cancelled" ? "cancelled" : "completed";
    return {
      kind: "task_terminal_hint",
      taskId,
      conversationId: record.conversationId,
      status: hintStatus,
    };
  }

  // 8. M4-E: approval / input-request events pass through as
  //    notices — the presenter builds the inline decision
  //    card from the frame payload. The empty `text` is
  //    intentional: these never become chat bubbles, only
  //    the presenter's card item.
  if (DECISION_EVENT_TYPES.has(innerType)) {
    return {
      kind: "task_notice",
      taskId,
      conversationId: record.conversationId,
      text: "",
      daemonStatus: payload.status,
    };
  }

  // Provider recovery is persisted as a generic timeline update with the
  // original semantic name in legacyType. These events deliberately have no
  // message, but suppressing them leaves the UI apparently frozen for every
  // retry window.
  if (
    innerType === "timeline_step_updated" &&
    (legacyType === "llm_retry" ||
      legacyType === "llm_routing_changed" ||
      legacyType === "llm_slow" ||
      legacyType === "llm_plan_fallback")
  ) {
    // The daemon now repeats `llm_slow` on an interval with a growing
    // elapsedMs. Surface the elapsed time so a slow gateway reads as "still
    // waiting, Ns" instead of a panel that looks frozen.
    const elapsedMs = (payload.payload as { elapsedMs?: unknown } | undefined)?.elapsedMs;
    const waited =
      typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
        ? Math.max(1, Math.round(elapsedMs / 1000))
        : null;
    const suffix = waited !== null ? `（已等待 ${waited}s）` : "";
    return {
      kind: "task_notice",
      taskId,
      conversationId: record.conversationId,
      text:
        legacyType === "llm_retry"
          ? `模型响应较慢，正在重试${suffix}`
          : legacyType === "llm_slow"
            ? `模型仍在响应，任务没有中断${suffix}`
            : legacyType === "llm_plan_fallback"
              ? "规划响应较慢，已切换安全方案继续执行"
              : "模型连接异常，正在恢复",
      daemonStatus: payload.status,
    };
  }

  // 9. Generic notice: push the daemon's text to the
  //    conversation, but route by taskId (the old code
  //    did this with the singleton ref; the new code
  //    does it by record).
  const message = payload.payload?.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return {
      kind: "task_notice",
      taskId,
      conversationId: record.conversationId,
      text: message,
      // The vendor's task_paused / awaiting_user_input frames often omit the
      // outer status even though task.get already says `paused`. Carry the
      // semantic status immediately so the composer unlocks without waiting
      // for the next reconciler poll.
      daemonStatus:
        innerType === "task_paused" || innerType === "awaiting_user_input"
          ? "paused"
          : payload.status,
    };
  }
  // Contract-tested against vendor emitters (§7.2):
  // real `timeline_command_output` frames carry the text
  // in `payload.output` (shell-tools.ts logEvent) and
  // real `timeline_artifact_emitted` frames carry
  // `payload.path` (timeline-emitter.ts emitArtifact) —
  // neither has `message`. Without this pass-through the
  // presenter never sees them and both silently vanish.
  if (
    innerType === "timeline_command_output" ||
    innerType === "timeline_artifact_emitted"
  ) {
    return {
      kind: "task_notice",
      taskId,
      conversationId: record.conversationId,
      text: "",
      daemonStatus: payload.status,
    };
  }
  return { kind: "ignore" };
}
