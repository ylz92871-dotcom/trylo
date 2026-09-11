// Trylo Work — consumeFrame, the SINGLE transactional
// entry point for every raw ControlPlane frame
// (M3 closure spec §3, fixing M3-P0-03).
//
// The previous runtime exposed three parallel paths
// (onFrame / presentFrame / summarizeForDiagnostics), so
// the renderer could render what the router had decided
// to drop. Here the whole pipeline runs atomically:
//
//   parse → ownership → dedupe(seq) → route →
//   monotonic status → ONE diagnostic id → projection
//
// and the outcome is a `RuntimeUpdate`. A `dropped`
// update carries ONLY diagnostics — never conversation
// items — so a dropped frame cannot produce UI side
// effects. Replaying an already-seen frame returns a
// dropped(replay) update with no state change.
//
// Layering (spec §12, M3-P2-04): this file is core. It
// defines `DaemonEventLine` (previously declared in the
// renderer component WorkDiagnostics); the renderer now
// re-exports it instead of the other way around.

import { routeTaskEvent, type RouterDecision } from "./event-router.js";
import { presentTaskEvent, type ConversationItem } from "./event-presenter.js";
import { isTerminal, type TaskRegistry } from "./task-registry.js";
import { mapDaemonStatus } from "./task-reconciler.js";
import { intentFromIsChat } from "./work-domain.js";
import type { EventFrame } from "./control-plane/types.js";

/** Which route a frame finally took (spec §10.1
 *  `routeDecision`). Drop reasons reuse FrameDropReason
 *  verbatim — dropped/replayed/late frames carry their
 *  explicit decision and are never disguised as normal
 *  log lines (spec §10.2). */
export type DiagnosticRouteDecision =
  | FrameDropReason
  | "task_notice"
  | "task_error"
  | "terminal_projection"
  | "recover"
  /** Host-side artifact action denied or failed (§9.3,
   *  M3-P1-11). These records are injected by the app
   *  shell, not produced by frame consumption. */
  | "artifact_action_failed"
  /** Host dropped an artifact EVENT because its scope could not be resolved
   *  from the runtime registry (spec §8.3 — no binding / run mismatch). The
   *  shell writes this instead of silently projecting into an invented scope. */
  | "artifact_event_dropped";

export type DiagnosticSeverity = "info" | "warn" | "error";

/** One record of daemon activity for the Diagnostics
 *  drawer (spec §10.1 DiagnosticRecord). Built
 *  exclusively by consumeFrame / WorkRuntime; the
 *  renderer never derives these from raw frames. */
export interface DaemonEventLine {
  readonly id: string;
  readonly at: number;
  readonly event: string;
  readonly summary: string;
  /** Spec §10.1: the route this record took. For error
   *  projections this id equals the ErrorCard's
   *  diagnosticId, so the drawer search finds exactly
   *  one record (spec §10.2, M3-P1-07). */
  readonly routeDecision: DiagnosticRouteDecision;
  readonly severity: DiagnosticSeverity;
  readonly taskId?: string;
  readonly runId?: string;
  /** Inner daemon event type (timeline_step_updated, …). */
  readonly eventType?: string;
  /** Redacted raw payload for the details view (spec
   *  §10.2). Large text fields are replaced by length
   *  markers; never the full payload. */
  readonly rawPayloadRedacted?: string;
  /** Present when the record describes a failure. */
  readonly normalizedError?: {
    readonly code: string;
    readonly userMessage: string;
  };
}

/** Why a frame did not produce conversation items. */
export type FrameDropReason =
  | "not_task_event"
  | "ignored"
  | "unknown_task"
  | "terminal_task"
  | "replay"
  | "no_projection";

/** Fields whose content is user/model text: replaced by
 *  a length marker in the redacted payload (§10.2). */
const REDACT_FIELDS: ReadonlySet<string> = new Set([
  "output",
  "message",
  "text",
  "content",
  "rawPayload",
]);

function redactRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    if (REDACT_FIELDS.has(key) && typeof value === "string") {
      copy[key] = `<redacted ${value.length} chars>`;
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

/** One-level-deep redaction of the broadcast payload,
 *  serialised and truncated so a chatty run cannot grow
 *  the drawer store without bound (spec §13.1 capacity
 *  policy). Returns undefined when there is nothing to
 *  show or serialization fails. */
function redactPayload(
  inner: Record<string, unknown> | undefined,
): string | undefined {
  if (inner === undefined) return undefined;
  const copy = redactRecord(inner);
  const nested = copy["payload"];
  if (typeof nested === "object" && nested !== null) {
    copy["payload"] = redactRecord(nested as Record<string, unknown>);
  }
  try {
    const text = JSON.stringify(copy);
    if (text === undefined) return undefined;
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return undefined;
  }
}

/** The single outcome of consuming one frame (spec §3).
 *  `diagnostic` is present on both branches: it is the
 *  frame's ONE diagnostic record (M3-P1-06) and powers
 *  the Diagnostics drawer even for dropped frames. */
export type RuntimeUpdate =
  | {
      readonly kind: "dropped";
      readonly reason: FrameDropReason;
      readonly taskId?: string;
      readonly diagnostic: DaemonEventLine;
    }
  | {
      readonly kind: "accepted";
      readonly taskId: string;
      readonly runId: string;
      readonly conversationId: string;
      /** Zero or more conversation projections. Empty
       *  for diagnostics-only events. */
      readonly items: readonly ConversationItem[];
      /** Daemon-supplied non-terminal status hint that
       *  was applied to the registry (if any). Terminal
       *  status is NEVER hinted — task.get is the only
       *  authority (spec §6.1, M3-P1-10). */
      readonly appliedStatus?: import("./task-registry.js").TaskStatus;
      /** Which path produced this update: a router
       *  decision for a consumed frame, or the
       *  runtime's exactly-once terminal projection
       *  (spec §6.2, driven by task.get authority). */
      readonly routerDecision: RouterDecision["kind"] | "terminal_projection";
      readonly diagnostic: DaemonEventLine;
    };

export interface ConsumeFrameDeps {
  readonly registry: TaskRegistry;
  readonly dedupe: FrameDedupe;
  readonly now?: () => number;
}

/** Consume one frame transactionally. Never throws. */
export function consumeFrame(
  frame: EventFrame,
  deps: ConsumeFrameDeps,
): RuntimeUpdate {
  const at = (deps.now ?? Date.now)();
  const inner =
    typeof frame.payload === "object" && frame.payload !== null
      ? (frame.payload as Record<string, unknown>)
      : undefined;
  const taskId =
    typeof inner?.["taskId"] === "string" && inner["taskId"].length > 0
      ? (inner["taskId"] as string)
      : undefined;
  const innerType =
    typeof inner?.["type"] === "string" ? (inner["type"] as string) : "";
  const seq =
    typeof inner?.["seq"] === "number" && Number.isFinite(inner["seq"])
      ? (inner["seq"] as number)
      : undefined;

  // One diagnostic record per frame — the drawer's feed
  // (spec §10.1). The id is recomputable from
  // taskId+type+seq (spec §2.3) when the frame carries
  // them, so recovery can recognise already-surfaced
  // lines. routeDecision/severity are attached per
  // branch below, once the outcome is known.
  const base = {
    id:
      taskId !== undefined
        ? `frame:${taskId}:${innerType || frame.event}:${seq ?? "noseq"}`
        : `frame:${frame.event}:${at}`,
    at,
    event: frame.event,
    summary:
      taskId !== undefined
        ? `${frame.event} ${innerType || ""} (${taskId.slice(0, 8)})`.trim()
        : frame.event,
    taskId,
    eventType: innerType.length > 0 ? innerType : undefined,
    rawPayloadRedacted: redactPayload(inner),
  };

  // 1. Not a task event → nothing to do.
  if (frame.event !== "task.event" || !inner) {
    return {
      kind: "dropped",
      reason: "not_task_event",
      diagnostic: { ...base, routeDecision: "not_task_event", severity: "info" },
    };
  }

  // 2. Sequence dedupe (spec §5.4): an already-seen
  //    taskId+type+seq is a replay — no state change.
  if (taskId !== undefined && seq !== undefined) {
    if (deps.dedupe.isDuplicate(taskId, innerType, seq)) {
      return {
        kind: "dropped",
        reason: "replay",
        taskId,
        diagnostic: { ...base, routeDecision: "replay", severity: "warn" },
      };
    }
  }

  // 3. Routing decision (ownership, terminal, errors).
  const decision = routeTaskEvent(frame, deps.registry);

  switch (decision.kind) {
    case "ignore":
      return {
        kind: "dropped",
        reason: "ignored",
        taskId,
        diagnostic: { ...base, routeDecision: "ignored", severity: "info" },
      };
    case "drop_unknown_task":
      return {
        kind: "dropped",
        reason: "unknown_task",
        taskId,
        diagnostic: { ...base, routeDecision: "unknown_task", severity: "warn" },
      };
    case "drop_terminal_task":
      return {
        kind: "dropped",
        reason: "terminal_task",
        taskId,
        diagnostic: { ...base, routeDecision: "terminal_task", severity: "warn" },
      };

    case "task_error": {
      // A timeline_error is an execution event, not terminal authority. The
      // daemon can retry and later complete after emitting it. Marking the
      // registry failed here deactivated the binding and caused every later
      // final/progress frame to be dropped. task.get is the only terminal
      // authority; keep this as visible recovery feedback + diagnostics.
      if (seq !== undefined) {
        deps.dedupe.markSeen(decision.taskId, innerType, seq);
        deps.registry.update(decision.taskId, { lastSeq: seq });
      }
      const record = deps.registry.get(decision.taskId);
      const runId = record?.runId ?? decision.taskId;
      const item: ConversationItem = {
        kind: "progress",
        id: `recovery:${runId}:${decision.diagnosticId}`,
        at,
        conversationId: decision.conversationId,
        text: decision.userMessage,
        taskId: decision.taskId,
        runId,
        turnId: record?.turnId,
        intent: record?.intent ?? intentFromIsChat(record?.isChat),
      };
      return {
        kind: "accepted",
        taskId: decision.taskId,
        runId,
        conversationId: decision.conversationId,
        items: [item],
        appliedStatus: undefined,
        routerDecision: "task_error",
        // The drawer record adopts the router's
        // diagnosticId as its OWN id: the ErrorCard's
        // diagnosticId must locate exactly this record in
        // the drawer search (spec §10.2, M3-P1-07).
        diagnostic: {
          ...base,
          id: decision.diagnosticId,
          runId,
          routeDecision: "task_error",
          severity: "warn",
          normalizedError: {
            code: decision.errorCode,
            userMessage: decision.userMessage,
          },
        },
      };
    }

    case "task_terminal_hint":
      // Event terminal signals are HINTS only; today's
      // bridge allowlist does not even carry them. The
      // reconciler's task.get is the sole authority
      // (spec §6.1, M3-P1-10), so no registry write and
      // no projection here.
      return {
        kind: "dropped",
        reason: "ignored",
        taskId: decision.taskId,
        diagnostic: { ...base, routeDecision: "ignored", severity: "warn" },
      };

    case "task_notice": {
      const record = deps.registry.get(decision.taskId);
      if (!record) {
        return {
          kind: "dropped",
          reason: "unknown_task",
          taskId,
          diagnostic: { ...base, routeDecision: "unknown_task", severity: "warn" },
        };
      }
      // Apply the daemon-supplied status ONLY when it is
      // non-terminal; the registry's monotonic guard
      // rejects regressions (running → pending).
      const hinted = mapDaemonStatus(decision.daemonStatus);
      let appliedStatus: import("./task-registry.js").TaskStatus | undefined;
      if (hinted !== undefined && !isTerminal(hinted) && hinted !== record.status) {
        deps.registry.update(decision.taskId, { status: hinted, updatedAt: at });
        appliedStatus = hinted;
      }
      if (seq !== undefined) {
        deps.dedupe.markSeen(decision.taskId, innerType, seq);
        deps.registry.update(decision.taskId, { lastSeq: seq });
      }
      const presented = presentTaskEvent(frame, decision.taskId, record.runId);
      // Attach the run identity (spec §2.4): the mapper
      // derives turn/run membership from these fields,
      // never from surrounding messages (M3-P1-02).
      const items: readonly ConversationItem[] =
        presented === null
          ? []
          : [
              {
                ...presented,
                conversationId: decision.conversationId,
                taskId: decision.taskId,
                runId: record.runId,
                turnId: record.turnId,
                // 2026-08-29 (redesign spec §2.3): the intent is
                // snapshotted on the registry binding and travels
                // with every item — the renderer never rediscovers
                // it from tool events.
                intent: record.intent ?? intentFromIsChat(record.isChat),
              },
            ];
      return {
        kind: "accepted",
        taskId: decision.taskId,
        runId: record.runId,
        conversationId: decision.conversationId,
        items,
        appliedStatus,
        routerDecision: "task_notice",
        diagnostic: {
          ...base,
          runId: record.runId,
          routeDecision: "task_notice",
          severity: "info",
        },
      };
    }
  }
}

/** Per-task replay guard keyed on taskId+type+seq.
 *  Bounded per task so a long-running run cannot grow
 *  the set without limit. */
export class FrameDedupe {
  private readonly seen = new Map<string, Set<string>>();
  private readonly maxPerTask: number;

  constructor(maxPerTask = 256) {
    this.maxPerTask = maxPerTask;
  }

  /** True when (taskId, type, seq) was already consumed.
   *  Does NOT record; pair with markSeen after the frame
   *  is actually applied. */
  isDuplicate(taskId: string, type: string, seq: number): boolean {
    return this.seen.get(taskId)?.has(keyOf(type, seq)) === true;
  }

  markSeen(taskId: string, type: string, seq: number): void {
    let set = this.seen.get(taskId);
    if (!set) {
      set = new Set<string>();
      this.seen.set(taskId, set);
    }
    set.add(keyOf(type, seq));
    if (set.size > this.maxPerTask) {
      // Evict the oldest insertion (Sets keep order).
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
  }

  /** Drop all memory for a task (cleanup after the
   *  record is removed). */
  forget(taskId: string): void {
    this.seen.delete(taskId);
  }
}

function keyOf(type: string, seq: number): string {
  return `${type || "?"}:${seq}`;
}
