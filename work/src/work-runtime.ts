// Trylo Work — WorkRuntimePort (the stable adapter the
// Desktop UI consumes).
//
// v1.16.5+ (Phase B of the M1 lifecycle milestone): a
// thin facade that hides the Control Plane protocol,
// TaskRegistry, EventRouter, and TaskReconciler behind
// stable Trylo-domain operations. The Desktop renderer
// (App.tsx) must consume ONLY this port; the protocol-
// level client.ts is an implementation detail of the
// port, not a renderer dependency.
//
// Why a port, not a free-floating client:
//   - Codex §9 "no more if (frame.event === ...) in
//     App.tsx". Every new error shape, every new
//     task-list variant, every vendor protocol change
//     has to land in a new method on the port; App.tsx
//     is untouched.
//   - The port owns the lifecycle: ensureRuntime,
//     reconcileProject, dispose. The renderer is a
//     consumer, not a driver.
//   - Tests can drive the port against a mock client
//     without ever touching a real WebSocket.
//
// Methods (the minimum the renderer needs to drive
// Work without reaching into the protocol):
//
//   ensureRuntime(env)
//     Spawn / adopt the daemon (delegates to Tauri via
//     the `workd_spawn` IPC). The port is the only
//     caller of `workd_spawn`.
//
//   ensureWorkspace(projectRoot)
//     Resolve or create the daemon-side workspaceId for
//     a project. Cached.
//
//   startTask(conversationId, prompt)
//     Create the task, register the binding, return
//     the taskId. Renderer does not get a raw frame.
//
//   cancelTask(taskId)
//     Best-effort cancel. The reconciler will pick up
//     the terminal state.
//
//   observeTask(taskId, onEvent)
//     Subscribe to the normalised event stream for one
//     task. Returns an unsubscribe function.
//
//   reconcileProject(projectRoot)
//     Refresh recovery (B4): re-bind non-terminal
//     tasks from the persisted conversation history.
//
//   dispose()
//     Stop the reconciler, disconnect the client.

import { Methods } from "./control-plane/types.js";
import type { ControlPlaneClient } from "./control-plane/types.js";
import { TaskReconciler, mapDaemonStatus } from "./task-reconciler.js";
import {
  TaskRegistry,
  isTerminal,
  newRunId,
  type TaskChangeKind,
  type TaskRecord,
} from "./task-registry.js";
import {
  consumeFrame,
  FrameDedupe,
  type DaemonEventLine,
  type RuntimeUpdate,
} from "./consume-frame.js";
import {
  normalizeInputRequestQuestions,
  presentTaskEvent,
  type ConversationItem,
} from "./event-presenter.js";
import type { EventFrame } from "./control-plane/types.js";
import {
  WorkContextAdapter,
  extractWorkContextEvent,
} from "./work-context-adapter.js";
import {
  intentFromIsChat,
  type WorkRunIdentity,
  type WorkTurnProjection,
} from "./work-domain.js";
import {
  createWorkTurnProjection,
  reduceWorkItem,
} from "./work-workflow-reducer.js";
import {
  isTrivialFinalText,
  isMissingFinalAnswer,
  resolveFinalAnswerText,
} from "./work-result-resolver.js";

/** Bounded semantic-item cache size per run (spec §10.4): a chatty
 *  run cannot grow the terminal projection's input without bound. */
const MAX_RUN_ITEMS = 512;

/** Bounded `task.events` replay page (spec §6.3 / §10.4): at most
 *  2000 events are pulled back to recover a missed assistant final. */
const TASK_EVENTS_REPLAY_LIMIT = 2000;
const MAX_PENDING_TASK_EVENT_STREAMS = 16;
const MAX_PENDING_TASK_EVENTS = 64;
const AWAITING_DECISION_TEXT = /(?:paused\s*[-—:]?\s*)?awaiting\s+user\s+input|等待用户输入|等待你的输入/i;

function signalsMissingDecision(item: ConversationItem): boolean {
  if (item.kind !== "thinking" && item.kind !== "progress" && item.kind !== "plan") return false;
  return AWAITING_DECISION_TEXT.test(item.text);
}

/** P2 (spec §4.4): the permission mode the daemon expects. Mirrors
 *  the upstream `task.create.permissionMode` field — the vendor
 *  `cowork-os` accepts `plan | default | accept_edits | dont_ask`
 *  and also a `bypass_permissions` value reserved for the dev
 *  switch. The Desktop UI never emits `bypass_permissions`; this
 *  type does not include it on purpose so the surface stays
 *  constrained. */
export type WorkPermissionMode =
  | "plan"
  | "default"
  | "accept_edits"
  | "dont_ask";

/** Minimal Tauri invoke surface. The Desktop shell
 *  injects the real `invoke`; tests can inject a stub. */
export interface WorkTauriInvoke {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export interface WorkEnv {
  readonly mode: "real" | "stub";
  readonly extra?: Readonly<Record<string, string>>;
}

export interface WorkSpawnResult {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Per-launch local Control Plane credential returned by the Tauri
   * supervisor. It must never be persisted or written to diagnostics. */
  readonly token: string;
}

export interface WorkRuntimeEvents {
  /** Called whenever the registry changes (B1). The
   *  renderer uses this to know when a task reaches a
   *  terminal state, when a new task is created, etc.
   *  `deactivated` fires when the conversation's active
   *  binding is cleared (terminal transition). */
  onRegistryChange?: (record: TaskRecord, kind: TaskChangeKind) => void;
  /** Every runtime-produced RuntimeUpdate (spec §6.2):
   *  the exactly-once terminal projection, consumed by
   *  the renderer exactly like a consumeFrame result. */
  onRuntimeUpdate?: (update: RuntimeUpdate) => void;
  /** A persisted RunBinding pointed at a task the daemon
   *  no longer knows (spec §5.3). The renderer must
   *  invalidate the persisted binding; the user-visible
   *  error item is pushed through onRuntimeUpdate. */
  onStaleBinding?: (args: {
    readonly projectRoot: string;
    readonly conversationId: string;
  }) => void;
  /** M4-C2: fired when a task's ContextSnapshot changed (an
   *  llm_usage or context_compaction_* frame was consumed or a
   *  task.get recovery applied). The renderer re-reads
   *  `runtime.context.snapshot(taskId)` for the ContextRing. */
  onContextChange?: (taskId: string) => void;
  /** P2-1 (spec §8.2): optional result-projection lifecycle. The Desktop
   *  `WorkResultProjector` subscribes so it can capture the `.trylo/out`
   *  baseline BEFORE the daemon begins, and finalise on the registry's
   *  authoritative terminal — instead of the renderer guessing run
   *  boundaries. `onProjectionRunStarted` is awaited before the frame is
   *  sent; `onProjectionRunTerminal` fires exactly once per runId. */
  onProjectionRunStarted?: (scope: WorkProjectionScope) => Promise<void> | void;
  onProjectionRunTerminal?: (record: TaskRecord) => void;
}

/** The run identity the projector receives at start/terminal (spec §8.2).
 *  `runId` is generated by the runtime BEFORE the daemon frame so the
 *  baseline can be keyed to the same run terminal will finalise. */
export interface WorkProjectionScope {
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly turnId: string | undefined;
  readonly startedAt: number;
}

export interface WorkRuntimeOptions {
  readonly client: ControlPlaneClient;
  readonly tauri: WorkTauriInvoke;
  readonly events?: WorkRuntimeEvents;
  /** Polling interval for the reconciler. Defaults to
   *  5s; tests can shorten this. */
  readonly pollIntervalMs?: number;
  /** Maximum events per task to dedupe. Defaults to
   *  256; older seqs are dropped from the dedupe set. */
}

export class WorkRuntime {
  readonly registry: TaskRegistry;
  readonly context: WorkContextAdapter;
  private readonly client: ControlPlaneClient;
  private readonly tauri: WorkTauriInvoke;
  private readonly events: WorkRuntimeEvents;
  private readonly pollIntervalMs: number | undefined;
  private readonly dedupe = new FrameDedupe();
  /** Runs whose terminal projection already fired
   *  (spec §6.2: exactly one user-visible terminal per
   *  run, no matter how many terminal notifications the
   *  registry emits or how often the reconciler polls). */
  private readonly terminalProjected = new Set<string>();
  /** Runs whose result-projection terminal (spec §8.2) already fired — the
   *  Desktop projector's scan is exactly-once per runId. */
  private readonly projectionTerminalFired = new Set<string>();
  /** Bounded semantic item cache per run (spec §10.4 /
   *  §6.3). The terminal projection folds these through
   *  the pure workflow reducer so the result resolver can
   *  build a content-bearing final answer — never the
   *  forbidden "未返回文本结论" placeholder. */
  private readonly runItems = new Map<string, ConversationItem[]>();
  /** Events can beat the task.create response on some WebSocket/event-loop
   * schedules. Keep a tiny ownership-neutral buffer and replay only if that
   * exact task is subsequently registered by start/recovery. */
  private readonly pendingTaskFrames = new Map<string, EventFrame[]>();
  private reconciler: TaskReconciler | null = null;
  private readonly workspaceIds = new Map<string, string>();
  /** Single-flight guard for recovery (spec §5.4): one
   *  reconcile promise at a time, StrictMode duplicate
   *  effects ride the same promise instead of doubling
   *  the task.get burst. */
  private readonly reconcileInFlight = new Map<string, Promise<void>>();
  /** A missed decision-created frame must not strand a live task forever.
   * Bounded per-task retries query the daemon's source-of-truth lists. */
  private readonly decisionRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: WorkRuntimeOptions) {
    this.client = opts.client;
    this.tauri = opts.tauri;
    this.events = opts.events ?? {};
    this.pollIntervalMs = opts.pollIntervalMs;
    this.registry = new TaskRegistry();
    this.context = new WorkContextAdapter();
    // One subscription serves both: the terminal
    // projection (internal, exactly-once) and the
    // caller's onRegistryChange hook (M3-P2-02: no
    // second notification path).
    this.registry.subscribe((record, kind) => {
      if (kind === "removed") {
        this.dedupe.forget(record.taskId);
        this.runItems.delete(record.runId);
        return;
      }
      if (kind === "registered") {
        queueMicrotask(() => this.flushPendingTaskFrames(record.taskId));
      }
      if (isTerminal(record.status)) {
        // Defer by one microtask: a synchronous
        // consumeFrame task_error path updates the
        // registry INSIDE the frame transaction and
        // projects its own ErrorItem; it must be able
        // to claim the run's single terminal slot
        // before the registry-triggered projection
        // runs (spec §6.2, exactly one terminal).
        const terminalRecord = record;
        queueMicrotask(() => {
          this.projectTerminal(terminalRecord);
          // P2-1 (spec §8.2): exactly-once result-projection terminal.
          this.fireProjectionRunTerminal(terminalRecord);
        });
      }
      if (opts.events?.onRegistryChange) {
        try {
          opts.events.onRegistryChange(record, kind);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[WorkRuntime] onRegistryChange threw:", err);
        }
      }
    });
  }

  /** Spawn (or adopt) the daemon. Idempotent — multiple
   *  concurrent calls result in one spawn, see
   *  `workd_spawn`'s single-flight gate. */
  async ensureRuntime(env: WorkEnv): Promise<WorkSpawnResult> {
    const r = await this.tauri.invoke<WorkSpawnResult>("workd_spawn", {
      mode: env.mode,
      env: env.extra ?? {},
    });
    return r;
  }

  /** Resolve or create the daemon workspaceId for a
   *  project. Cached per project root.
   *
   *  P2-3: this port stub intentionally does NOT implement resolution.
   *  The renderer owns it today via
   *  `host-adapter/control-plane-workspace.resolveControlPlaneWorkspace`
   *  (cached in App.tsx's workspaceIdsRef), because it needs the
   *  `missing-control-plane-workspace` error handling that the port
   *  would otherwise duplicate. Keep resolution there until W-RUN-002
   *  cleanup folds it back into this file; do NOT throw from App.
   */
  async ensureWorkspace(projectRoot: string): Promise<string> {
    const cached = this.workspaceIds.get(projectRoot);
    if (cached) return cached;
    // The actual resolution / creation logic stays in
    // the renderer's existing
    // `resolveControlPlaneWorkspace` helper for now;
    // the port only owns the cache. A future step can
    // fold that helper into this file.
    throw new Error(
      "WorkRuntime.ensureWorkspace is not yet wired " +
        "through the port; use resolveControlPlaneWorkspace " +
        "from the host-adapter until W-RUN-002 cleanup lands.",
    );
  }

  /** Create a task. Returns the taskId. Registers the
   *  binding immediately. The renderer must persist
   *  the taskId in the conversation history (via
   *  `bindConversationTask`) for refresh recovery. */
  async startTask(args: {
    workspaceId: string;
    conversationId: string;
    sessionId: string;
    projectRoot: string;
    title: string;
    prompt: string;
    turnId?: string;
    /** Conversation (chat) run vs a work-order. Chat runs
     *  must not gate the composer — W-RUN handoff §3.2. */
    isChat?: boolean;
    /** P2 (spec §4.4): the snapshotted permission mode for
     *  this run. Traveled with the request, NOT pulled from
     *  any mutable global. The daemon accepts the four
     *  values declared in `WorkPermissionMode`; a mid-run
     *  picker change on the desktop must not leak here. */
    permissionMode?: WorkPermissionMode;
    /** Expose the daemon's command tool for this task. The permission mode
     * still decides whether an individual command needs approval; without
     * this capability bit the upstream executor pauses before it can even
     * request approval. */
    shellAccess?: boolean;
    /** 2026-08-30 (routing-fix step 10): token budget guardrail. The
     *  daemon's `sanitizeTaskCreateParams` natively accepts
     *  `budgetTokens`; a runaway task otherwise burns unbounded tokens
     *  (a single greeting once burned 110,406/100,000 tokens —
     *  `a1863e32`). Conversations are now routed to the Code runtime, so
     *  this guards the task side. */
    budgetTokens?: number;
  }): Promise<string> {
    // P2-1 (spec §8.2): generate runId BEFORE the daemon frame so the result
    // projector can capture the `.trylo/out` baseline keyed to the same run
    // terminal will finalise. Fire + await the hook first: a slow baseline is
    // the projector's bounded budget, and the run must not start before it.
    const runId = newRunId();
    const startedAt = Date.now();
    await this.fireProjectionRunStarted({
      projectRoot: args.projectRoot,
      conversationId: args.conversationId,
      runId,
      turnId: args.turnId,
      startedAt,
    });
    // Spec §2.3: a conversation turn must NOT execute — force the
    // read-only `plan` mode regardless of the picker value. Only a
    // task honors the caller's permission mode. This is the runtime
    // backstop; the Desktop also gates it on the send path.
    const permissionMode = args.isChat === true ? "plan" : args.permissionMode;
    const res = (await this.client.send("task.create", {
      title: args.title,
      prompt: args.prompt,
      workspaceId: args.workspaceId,
      // The headless Control Plane persists task permissions through
      // agentConfig. Keeping the top-level field as well preserves
      // compatibility with the Electron handler used by older packages.
      ...(permissionMode ? { permissionMode } : {}),
      ...(permissionMode
        ? {
            agentConfig: {
              permissionMode,
              // Spec §2.3: a conversation (chat) turn must route to the daemon's
              // lightweight companion path. The daemon's `shouldHandleInitialPromptAsCompanion`
              // fires on `conversationMode: "chat"` and only on the FIRST turn —
              // follow-up `task.sendMessage` routing reads the thread-created
              // `agentConfig.conversationMode` persisted at create time, so this
              // is a first-turn fast path, not a per-message intent switch.
              // Keeping the forward makes an in-thread chat usable; real chat
              // traffic is routed to the Code runtime (routing-fix step 7/8).
              ...(args.isChat === true ? { conversationMode: "chat" } : {}),
            },
          }
        : {}),
      // 2026-08-30 (routing-fix step 10): the daemon natively accepts a
      // `budgetTokens` cap on task.create; see the args doc.
      ...(args.budgetTokens !== undefined ? { budgetTokens: args.budgetTokens } : {}),
      ...(args.isChat !== true && args.shellAccess === true ? { shellAccess: true } : {}),
    })) as { task?: { id?: string }; id?: string } | undefined;
    const taskId = res?.task?.id ?? res?.id;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error(
        "WorkRuntime.startTask: daemon did not return a taskId. " +
          `response=${JSON.stringify(res)}`,
      );
    }
    this.registry.register({
      taskId,
      runId,
      turnId: args.turnId,
      delivery: "create",
      workspaceId: args.workspaceId,
      projectRoot: args.projectRoot,
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      status: "starting",
      lastSeq: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
      terminalError: undefined,
      isChat: args.isChat,
      intent: intentFromIsChat(args.isChat),
    });
    return taskId;
  }

  /**
   * Continue a durable task (architecture doc §6.1): send a
   * `task.sendMessage` follow-up on an existing taskId and
   * register a brand-NEW local run for that turn. The
   * taskId stays fixed (durable thread id); only the runId
   * changes, so the daemon's `beginFollowUpRun` keeps the
   * original conversation history.
   *
   * Returns the new runId. Throws if the task is not known
   * to the local registry (the renderer must have bound it
   * via startTask or reconcileProject first).
   */
  async sendMessage(args: {
    taskId: string;
    message: string;
    turnId?: string;
    /** Conversation (chat) run vs a work-order. Passed
     *  through to beginFollowUp — W-RUN handoff §3.2. */
    isChat?: boolean;
    /** P2 (spec §4.4): see `startTask.permissionMode`.
     *  Forwarded on the `task.sendMessage` frame so a
     *  follow-up turn can land on a different level than
     *  the task was created with (the user changed the
     *  picker between turns). */
    permissionMode?: WorkPermissionMode;
    shellAccess?: boolean;
  }): Promise<string> {
    // P2-1 (spec §8.2): resolve the bound project so the projection start
    // hook can capture the baseline before the follow-up is sent. The new
    // runId is generated up front and awaited-through the hook, then re-used
    // by beginFollowUp below so runId stays the identity of this turn.
    const record = this.registry.get(args.taskId);
    if (!record) {
      throw new Error(`WorkRuntime.sendMessage: unknown taskId=${args.taskId}`);
    }
    const runId = newRunId();
    const startedAt = Date.now();
    await this.fireProjectionRunStarted({
      projectRoot: record.projectRoot,
      conversationId: record.conversationId,
      runId,
      turnId: args.turnId,
      startedAt,
    });
    // Spec §2.3: force `plan` for conversation follow-ups — same
    // backstop as startTask; a chat turn can never take the task
    // permission level.
    const permissionMode = args.isChat === true ? "plan" : args.permissionMode;
    await this.client.send(Methods.TaskSendMessage, {
      taskId: args.taskId,
      message: args.message,
      // P2: same gating as startTask — only emit the field when
      // one was resolved, so the daemon's default behaviour is
      // unchanged for legacy callers.
      ...(permissionMode ? { permissionMode } : {}),
      ...(args.isChat !== true && args.shellAccess === true ? { shellAccess: true } : {}),
    });
    this.registry.beginFollowUp({
      taskId: args.taskId,
      runId,
      turnId: args.turnId,
      isChat: args.isChat,
    });
    return runId;
  }

  /** Inject guidance into the CURRENT non-terminal run.
   *
   * The upstream daemon already distinguishes the two cases:
   * - executing: queueFollowUp injects the message at the next model boundary;
   * - paused: sendMessage resumes the same executor.
   *
   * This deliberately does not call `beginFollowUp`: steering belongs to the
   * current runId/result baseline and must not fabricate a second run while
   * the first one is still active. */
  async steerTask(args: {
    taskId: string;
    message: string;
    permissionMode?: WorkPermissionMode;
    shellAccess?: boolean;
  }): Promise<void> {
    const record = this.registry.get(args.taskId);
    if (!record) {
      throw new Error(`WorkRuntime.steerTask: unknown taskId=${args.taskId}`);
    }
    if (isTerminal(record.status)) {
      throw new Error(`WorkRuntime.steerTask: taskId=${args.taskId} is terminal`);
    }
    await this.client.send(Methods.TaskSendMessage, {
      taskId: args.taskId,
      message: args.message,
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(args.shellAccess === true ? { shellAccess: true } : {}),
    });
    if (record.status === "paused") {
      this.registry.update(args.taskId, {
        status: "running",
        updatedAt: Date.now(),
      });
    }
  }

  /** Cancel a task. Best-effort: the reconciler will
   *  pick up the terminal state via task.get. */
  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.client.send(Methods.TaskCancel, { taskId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] task.cancel failed:", err);
    }
  }

  // M4-E (spec §6.7 Core "approval / input"): the daemon
  // pauses a task awaiting a user decision; Trylo surfaces
  // the pending request inline (via the presenter cards) and
  // responds through these methods. The daemon resumes the
  // task when the decision lands — without these, an
  // awaiting-approval task would sit paused until its
  // 5-minute timeout and look like a failure.

  // M4-E P1 (spec §6.7 "avoid false failure"): replay the
  // daemon's PENDING approvals / input requests as decision
  // cards after refresh / restart. The live event stream is
  // dead while Trylo is down, so `approval.list` /
  // `input_request.list` are the source of truth for
  // decisions that were created but never resolved. Each
  // record is projected through the SAME presenter shapes
  // (`normalizeInputRequestQuestions` + stable
  // `approval:{runId}:{approvalId}` /
  // `input_request:{runId}:{requestId}` ids) so a later
  // realtime granted / resolved event upserts in place.
  // Already-resolved records are skipped — only `pending`
  // needs restoring. Best-effort: a daemon that no longer
  // has the task simply yields nothing.
  private async restorePendingDecisions(args: {
    taskId: string;
    runId: string;
    turnId?: string;
    conversationId: string;
  }): Promise<number> {
    const { taskId, runId, turnId, conversationId } = args;
    const at = Date.now();
    const items: ConversationItem[] = [];
    try {
      for (const raw of await this.listApprovals({ taskId })) {
        const rec = raw as Record<string, unknown>;
        if (!rec || typeof rec.id !== "string" || rec.id.length === 0) continue;
        const status =
          rec.status === "approved"
            ? "approved"
            : rec.status === "denied"
              ? "denied"
              : "pending";
        if (status !== "pending") continue;
        items.push({
          kind: "approval",
          id: `approval:${runId}:${rec.id}`,
          at,
          conversationId,
          taskId,
          runId,
          turnId,
          approvalId: rec.id,
          type: typeof rec.type === "string" ? rec.type : undefined,
          description:
            typeof rec.description === "string" && rec.description.length > 0
              ? rec.description
              : "Permission request",
          status,
          autoApproved: rec.autoApproved === true,
          // P3 (spec §4.6): forward the upstream record so
          // the Desktop mapper can hand it to the safe
          // preview builder after refresh / restart.
          details: rec as Record<string, unknown>,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[WorkRuntime] approval.list restore failed:`, err);
    }
    try {
      for (const raw of await this.listInputRequests({ taskId })) {
        const rec = raw as Record<string, unknown>;
        if (!rec || typeof rec.id !== "string" || rec.id.length === 0) continue;
        if (rec.status !== "pending") continue;
        items.push({
          kind: "input_request",
          id: `input_request:${runId}:${rec.id}`,
          at,
          conversationId,
          taskId,
          runId,
          turnId,
          requestId: rec.id,
          questions: normalizeInputRequestQuestions(rec.questions),
          status: "pending",
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[WorkRuntime] input_request.list restore failed:`, err);
    }
    if (items.length === 0) return 0;
    const diagnosticId = `decision-restore:${runId}`;
    const update: RuntimeUpdate = {
      kind: "accepted",
      taskId,
      runId,
      conversationId,
      items,
      // Routing mirrors the live decision events (task_notice);
      // restored cards are append, and subsequent realtime
      // granted / resolved events update the same ids.
      routerDecision: "task_notice",
      diagnostic: {
        id: diagnosticId,
        at,
        event: "task.decision-restore",
        summary: `restored ${items.length} pending decision(s) (${taskId.slice(0, 8)})`,
        routeDecision: "task_notice",
        severity: "info",
        taskId,
        runId,
      },
    };
    try {
      this.events.onRuntimeUpdate?.(update);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] onRuntimeUpdate threw:", err);
    }
    return items.length;
  }

  private scheduleDecisionRecovery(record: TaskRecord, attempt = 0): void {
    if (this.decisionRecoveryTimers.has(record.taskId) || isTerminal(record.status)) return;
    const delay = attempt === 0 ? 0 : Math.min(3000, 500 * (2 ** attempt));
    const timer = setTimeout(() => {
      this.decisionRecoveryTimers.delete(record.taskId);
      void this.restorePendingDecisions({
        taskId: record.taskId,
        runId: record.runId,
        turnId: record.turnId,
        conversationId: record.conversationId,
      }).then((restored) => {
        if (restored === 0 && attempt < 3) {
          const current = this.registry.get(record.taskId);
          if (current && !isTerminal(current.status)) this.scheduleDecisionRecovery(current, attempt + 1);
        }
      });
    }, delay);
    this.decisionRecoveryTimers.set(record.taskId, timer);
  }

  /** List pending approvals for a task (`approval.list`).
   *  Returns the raw `approvals` array; consumers map it
   *  into Trylo display shapes, never raw payloads. */
  async listApprovals(args: {
    taskId: string;
    limit?: number;
  }): Promise<readonly unknown[]> {
    const res = (await this.client.send(Methods.ApprovalList, {
      taskId: args.taskId,
      limit: args.limit ?? 20,
      offset: 0,
    })) as { approvals?: unknown[] } | undefined;
    return Array.isArray(res?.approvals) ? res.approvals : [];
  }

  /** Respond to a daemon permission request (`approval.respond`).
   *  `approved` true/false resolves the pending request; the
   *  daemon resumes (approve) or pauses (deny) the task. */
  async respondApproval(approvalId: string, approved: boolean): Promise<void> {
    await this.client.send(Methods.ApprovalRespond, { approvalId, approved });
  }

  /** List input requests for a task (`input_request.list`).
   *  Returns the raw `inputRequests` array. */
  async listInputRequests(args: {
    taskId: string;
    limit?: number;
  }): Promise<readonly unknown[]> {
    const res = (await this.client.send(Methods.InputRequestList, {
      taskId: args.taskId,
      limit: args.limit ?? 20,
      offset: 0,
      status: "pending",
    })) as { inputRequests?: unknown[] } | undefined;
    return Array.isArray(res?.inputRequests) ? res.inputRequests : [];
  }

  /** Submit a structured input-request response
   *  (`input_request.respond`). `status` is `submitted` to
   *  answer the questions, or `dismissed` to skip them. */
  async respondInputRequest(args: {
    requestId: string;
    status: "submitted" | "dismissed";
    answers?: Record<string, { optionLabel?: string; otherText?: string }>;
  }): Promise<void> {
    await this.client.send(Methods.InputRequestRespond, {
      requestId: args.requestId,
      status: args.status,
      answers: args.answers,
    });
  }

  /** THE single entry point for raw ControlPlane frames
   *  (M3 closure spec §3, M3-P0-03). Parse → ownership →
   *  dedupe → route → monotonic status → ONE diagnostic
   *  id → projection, all in one transaction. The
   *  renderer consumes the returned RuntimeUpdate and
   *  never touches frame payloads itself:
   *    - `accepted.items` → conversation projections;
   *    - `diagnostic` → the Diagnostics drawer line
   *      (present for dropped frames too, so failures
   *      stay visible even when nothing renders);
   *    - `dropped` → NO UI side effects by contract. */
  consumeFrame(frame: EventFrame): RuntimeUpdate {
    const update = consumeFrame(frame, {
      registry: this.registry,
      dedupe: this.dedupe,
    });
    if (update.kind === "dropped" && update.reason === "unknown_task" && update.taskId) {
      this.bufferPendingTaskFrame(update.taskId, frame);
    }
    // M4-C2: route Work context events (llm_usage /
    // context_compaction_*) to the context adapter regardless of
    // whether they produced conversation items. These never become
    // chat bubbles — they only update the ContextRing snapshot. The
    // adapter consumes the raw frame; the renderer never does.
    const ctx = extractWorkContextEvent(frame, Date.now());
    if (ctx) {
      try {
        this.context.consume(ctx);
        this.events.onContextChange?.(ctx.taskId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[WorkRuntime] context consume failed:", err);
      }
    }
    // Cache every accepted item per run (bounded) so the
    // terminal projection can fold them through the pure
    // workflow reducer and the result resolver can build a
    // content-bearing final (spec §10.4). A frame-projected
    // terminal item also claims the run's single terminal
    // slot: the deferred registry-triggered projection then
    // no-ops (spec §6.2).
    if (update.kind === "accepted") {
      this.recordRunItems(update.runId, update.items);
      for (const item of update.items) {
        if (
          item.kind === "final" ||
          item.kind === "error" ||
          item.kind === "cancelled"
        ) {
          this.terminalProjected.add(update.runId);
        }
      }
      const hasDecisionCard = update.items.some((item) => (
        item.kind === "approval" || item.kind === "input_request"
      ));
      if (!hasDecisionCard && update.items.some(signalsMissingDecision)) {
        const record = this.registry.get(update.taskId);
        if (record) this.scheduleDecisionRecovery(record);
      }
    }
    return update;
  }

  private bufferPendingTaskFrame(taskId: string, frame: EventFrame): void {
    let frames = this.pendingTaskFrames.get(taskId);
    if (!frames) {
      if (this.pendingTaskFrames.size >= MAX_PENDING_TASK_EVENT_STREAMS) {
        const oldest = this.pendingTaskFrames.keys().next().value;
        if (typeof oldest === "string") this.pendingTaskFrames.delete(oldest);
      }
      frames = [];
      this.pendingTaskFrames.set(taskId, frames);
    }
    frames.push(frame);
    if (frames.length > MAX_PENDING_TASK_EVENTS) frames.splice(0, frames.length - MAX_PENDING_TASK_EVENTS);
  }

  private flushPendingTaskFrames(taskId: string): void {
    if (!this.registry.get(taskId)) return;
    const frames = this.pendingTaskFrames.get(taskId);
    if (!frames) return;
    this.pendingTaskFrames.delete(taskId);
    for (const frame of frames) {
      const update = this.consumeFrame(frame);
      try {
        this.events.onRuntimeUpdate?.(update);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[WorkRuntime] buffered onRuntimeUpdate threw:", err);
      }
    }
  }

  /** Exactly-once terminal projection (spec §6.2,
   *  M3-P1-01). The registry is the trigger; task.get
   *  (via the reconciler or reconcileProject) is the
   *  authority that moved it to a terminal status. For
   *  each run this produces EXACTLY one user-visible
   *  terminal item, pushed through the same
   *  RuntimeUpdate channel the renderer already
   *  consumes:
   *    - completed → final (`final:${runId}`), text =
   *      captured final text, else an explainer line —
   *      a completed run must never look unfinished;
   *    - failed → error whose diagnosticId matches the
   *      drawer line pushed alongside;
   *    - cancelled → an explicit cancelled state,
   *      never disguised as success or failure. */
  /** P2-1 (spec §8.2): fire the run-started projection hook and await it so a
   *  caller (the Desktop projector) can capture the baseline BEFORE the
   *  daemon frame is dispatched. A throwing observer is logged, never allowed
   *  to break the run. */
  private async fireProjectionRunStarted(scope: WorkProjectionScope): Promise<void> {
    if (!this.events.onProjectionRunStarted) return;
    try {
      await this.events.onProjectionRunStarted(scope);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] onProjectionRunStarted threw:", err);
    }
  }

  /** P2-1 (spec §8.2): exactly-once result-projection terminal per runId. */
  private fireProjectionRunTerminal(record: TaskRecord): void {
    if (this.projectionTerminalFired.has(record.runId)) return;
    this.projectionTerminalFired.add(record.runId);
    if (!this.events.onProjectionRunTerminal) return;
    try {
      this.events.onProjectionRunTerminal(record);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] onProjectionRunTerminal threw:", err);
    }
  }

  private projectTerminal(record: TaskRecord): void {
    if (!isTerminal(record.status)) return;
    if (this.terminalProjected.has(record.runId)) return;
    // Claim the exactly-once slot synchronously (spec §6.2):
    // the deferred registry projection and a frame-projected
    // terminal both race here; only the first wins. The async
    // resolve below may await a bounded task.events replay.
    this.terminalProjected.add(record.runId);
    void this.resolveTerminalProjection(record);
  }

  /** Bounded per-run item cache (spec §10.4). Keeps the tail
   *  so a chatty run cannot grow the terminal input unbounded. */
  private recordRunItems(runId: string, items: readonly ConversationItem[]): void {
    if (items.length === 0) return;
    const existing = this.runItems.get(runId) ?? [];
    const next = existing.concat(items);
    this.runItems.set(
      runId,
      next.length > MAX_RUN_ITEMS ? next.slice(-MAX_RUN_ITEMS) : next,
    );
  }

  /** Build the terminal projection and emit the single
   *  user-visible terminal item (spec §10.4 atomic terminal).
   *  A `completed` run always lands on a content-bearing final
   *  answer — the forbidden "未返回文本结论" placeholder is gone. */
  private async resolveTerminalProjection(record: TaskRecord): Promise<void> {
    const at = Date.now();
    const diagnosticId = `terminal:${record.runId}`;
    const identity: WorkRunIdentity = {
      taskId: record.taskId,
      runId: record.runId,
      turnId: record.turnId,
      conversationId: record.conversationId,
      intent: record.intent ?? intentFromIsChat(record.isChat),
    };
    let projection: WorkTurnProjection = createWorkTurnProjection(identity);
    for (const item of this.runItems.get(record.runId) ?? []) {
      projection = reduceWorkItem(projection, item);
    }

    let item: ConversationItem;
    let summary: string;
    if (record.status === "completed") {
      // Spec §10.4: if the WebSocket stream dropped the assistant
      // final, replay a bounded task.events page to recover it
      // before falling back to the deterministic summary.
      if (isMissingFinalAnswer(projection)) {
        projection = await this.replayTaskEvents(record, projection);
      }
      const daemonSummary = record.resultSummary?.trim();
      const resolved =
        daemonSummary && !isTrivialFinalText(daemonSummary)
          ? daemonSummary
          : resolveFinalAnswerText(projection);
      const isPartial = record.terminalStatus === "partial_success";
      const text = isPartial
        ? isTrivialFinalText(resolved) || resolved === "已完成。"
          ? `任务未能完整完成：${describePartialFailure(record.failureClass)}。你可以直接重试，我会从现有产物继续。`
          : `部分完成。\n\n${resolved}`
        : resolved;
      item = {
        kind: "final",
        id: `final:${record.runId}`,
        at,
        conversationId: record.conversationId,
        text,
        taskId: record.taskId,
        runId: record.runId,
        turnId: record.turnId,
        intent: identity.intent,
      };
      // Spec §10.3: a completed run with no recoverable natural-
      // language final is still a real terminal (the resolver
      // produced a deterministic summary), but we record the
      // diagnostics code — never show it to the user.
      summary = `task completed (${record.taskId.slice(0, 8)})${
        isMissingFinalAnswer(projection) ? " [missing_final_answer]" : ""
      }`;
    } else if (record.status === "failed") {
      item = {
        kind: "error",
        id: `error:${record.runId}:${diagnosticId}`,
        at,
        conversationId: record.conversationId,
        userMessage: record.terminalError ?? "任务执行失败",
        diagnosticId,
        taskId: record.taskId,
        runId: record.runId,
        turnId: record.turnId,
        intent: identity.intent,
      };
      summary = `task failed (${record.taskId.slice(0, 8)})`;
    } else {
      item = {
        kind: "cancelled",
        id: `cancelled:${record.runId}`,
        at,
        conversationId: record.conversationId,
        text: "任务已取消",
        taskId: record.taskId,
        runId: record.runId,
        turnId: record.turnId,
        intent: identity.intent,
      };
      summary = `task cancelled (${record.taskId.slice(0, 8)})`;
    }
    // Spec §10.1: full identity + routeDecision on the
    // drawer record; the failed branch reuses the
    // diagnosticId as the record id so the ErrorCard
    // search lands exactly here (spec §10.2).
    const diagnostic: DaemonEventLine = {
      id: diagnosticId,
      at,
      event: "task.terminal",
      summary,
      routeDecision: "terminal_projection",
      severity: record.status === "failed" ? "error" : "info",
      taskId: record.taskId,
      runId: record.runId,
    };
    const update: RuntimeUpdate = {
      kind: "accepted",
      taskId: record.taskId,
      runId: record.runId,
      conversationId: record.conversationId,
      items: [item],
      appliedStatus: record.status,
      routerDecision: "terminal_projection",
      diagnostic,
    };
    try {
      this.events.onRuntimeUpdate?.(update);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] onRuntimeUpdate threw:", err);
    }
  }

  /** Spec §6.3 / §10.4: bounded `task.events` replay. Used only
   *  when the WebSocket stream missed the assistant final; folds
   *  the replayed events through the SAME reducer (idempotent by
   *  event/seq identity), never reopening a terminal run. */
  private async replayTaskEvents(
    record: TaskRecord,
    projection: WorkTurnProjection,
  ): Promise<WorkTurnProjection> {
    try {
      const res = (await this.client.send(Methods.TaskEvents, {
        taskId: record.taskId,
        limit: TASK_EVENTS_REPLAY_LIMIT,
      })) as { events?: readonly unknown[] } | undefined;
      const events = Array.isArray(res?.events) ? res.events : [];
      let next = projection;
      for (const ev of events) {
        if (!ev || typeof ev !== "object") continue;
        const presented = presentTaskEvent(
          { type: "event", event: "task.event", payload: ev },
          record.taskId,
          record.runId,
        );
        if (!presented) continue;
        const item: ConversationItem = {
          ...presented,
          conversationId: record.conversationId,
          taskId: record.taskId,
          runId: record.runId,
          turnId: record.turnId,
          // 2026-08-29 (redesign spec §2.3): replayed events carry
          // the same snapshotted intent as the live stream — the
          // terminal projection's phase rail must match the live one.
          intent: record.intent ?? intentFromIsChat(record.isChat),
        };
        next = reduceWorkItem(next, item);
      }
      return next;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] task.events replay failed:", err);
      return projection;
    }
  }

  /** Start the polling reconciler. Idempotent. The
   *  reconciler's terminal transitions surface through
   *  the registry subscription (updated + deactivated);
   *  there is no second notification path (M3-P2-02). */
  startReconciler(): void {
    if (this.reconciler) return;
    this.reconciler = new TaskReconciler({
      client: this.client,
      registry: this.registry,
      // honour the configured interval (M3-P2-01); the
      // reconciler falls back to its 5s default.
      pollIntervalMs: this.pollIntervalMs,
    });
    this.reconciler.start();
  }

  /** Refresh recovery (B4): re-bind non-terminal tasks
   *  from the persisted conversation history. The
   *  renderer supplies the persisted taskIds; the port
   *  verifies each via task.get and registers the
   *  ones that are still active. Terminal ones are
   *  reported via `onRegistryChange` with the final
   *  status so the renderer can clear the binding. */
  async reconcileProject(args: {
    projectRoot: string;
    /** Map of sessionId → persisted taskId for this
     *  project. */
    persisted: ReadonlyMap<string, string>;
    /** Optional sessionId → turnId, computed ONCE from
     *  the persisted conversation at re-bind time (spec
     *  §2: never guessed per event). */
    turnIds?: ReadonlyMap<string, string>;
    /** Optional sessionId → intent, computed ONCE from the
     *  persisted conversation at re-bind time (spec §2.3).
     *  Restores conversation vs task without rediscovering
     *  it from tool events. */
    intents?: ReadonlyMap<string, "conversation" | "task">;
  }): Promise<void> {
    const key = `${args.projectRoot}\u0000${Array.from(args.persisted.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sessionId, taskId]) => `${sessionId}:${taskId}`)
      .join("|")}`;
    const inFlight = this.reconcileInFlight.get(key);
    if (inFlight) return inFlight;
    const run = this.reconcileProjectInner(args);
    this.reconcileInFlight.set(key, run);
    try {
      await run;
    } finally {
      if (this.reconcileInFlight.get(key) === run) {
        this.reconcileInFlight.delete(key);
      }
    }
  }

  private async reconcileProjectInner(args: {
    projectRoot: string;
    persisted: ReadonlyMap<string, string>;
    turnIds?: ReadonlyMap<string, string>;
    intents?: ReadonlyMap<string, "conversation" | "task">;
  }): Promise<void> {
    for (const [sessionId, taskId] of args.persisted) {
      if (!taskId) continue;
      try {
        const res = (await this.client.send("task.get", { taskId })) as {
          task?: {
            id?: string;
            status?: string;
            workspaceId?: string;
            compactionCount?: unknown;
            lastCompactionAt?: unknown;
            lastCompactionTokensBefore?: unknown;
            lastCompactionTokensAfter?: unknown;
            error?: string | null;
            terminalStatus?: string;
            failureClass?: string;
            resultSummary?: string;
            bestKnownOutcome?: { resultSummary?: string };
          };
        };
        const task = res?.task;
        if (!task || typeof task.id !== "string") {
          // Spec §5.3: the daemon no longer knows this
          // task (daemon restart / database replaced).
          // Mark the binding stale, tell the renderer to
          // clear it, and surface a user-visible error —
          // never a silent skip.
          this.emitStaleBinding(args.projectRoot, sessionId, taskId);
          continue;
        }
        // Register with the daemon's REAL mapped status
        // (M3-P0-02): a task the daemon reports running
        // must not re-enter as pending. The registry's
        // monotonic update guard makes re-registration of
        // an already-known task side-effect-safe.
        //
        // M4-B: each recovery re-bind gets a fresh local
        // runId (never derived from taskId — the durable
        // task may be mid-follow-up). If the daemon reports
        // a terminal task (it finished while we were down),
        // its terminal state was ALREADY projected into the
        // conversation during the original run, so we must
        // not re-emit a duplicate terminal item: claim the
        // run's exactly-once slot up front.
        const runId = newRunId();
        const mappedStatus = mapDaemonStatus(task.status) ?? "pending";
        // Restore the snapshotted intent (spec §2.3) and mirror it
        // back into the legacy `isChat` flag so the renderer's
        // composer gating stays correct after refresh.
        const intent = args.intents?.get(sessionId);
        this.registry.register({
          taskId: task.id,
          runId,
          turnId: args.turnIds?.get(sessionId),
          workspaceId: typeof task.workspaceId === "string" ? task.workspaceId : "",
          projectRoot: args.projectRoot,
          conversationId: sessionId,
          sessionId,
          status: mappedStatus,
          lastSeq: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          terminalError: typeof task.error === "string" ? task.error : undefined,
          terminalStatus: task.terminalStatus,
          failureClass: task.failureClass,
          resultSummary:
            typeof task.resultSummary === "string" && task.resultSummary.trim()
              ? task.resultSummary
              : task.bestKnownOutcome?.resultSummary,
          isChat:
            intent === "conversation"
              ? true
              : intent === "task"
                ? false
                : undefined,
          intent,
        });
        if (isTerminal(mappedStatus)) {
          this.terminalProjected.add(runId);
        }
        // P2-1 (spec §8.2): a recovered terminal run has no fresh baseline, so
        // its result projection finalises as a recovery scan — the projector
        // treats first-seen files as `discovered`, never `created`. Fire the
        // terminal hook exactly once so it runs that scan.
        if (isTerminal(mappedStatus)) {
          this.fireProjectionRunTerminal(this.registry.get(task.id) as TaskRecord);
        }
        // M4-C2: recover the task's last compaction metadata (priority
        // 3) so refresh restores the Work ContextRing before any new
        // llm_usage / compaction frame arrives. No-op when the task
        // has no compaction history.
        this.context.restoreFromTaskGet(task.id, task, Date.now());
        this.events.onContextChange?.(task.id);
        // M4-E P1 (spec §6.7 "avoid false failure"): a task that is
        // still awaiting a user decision must re-surface its pending
        // approval / input cards after refresh / restart. The live
        // event stream stops while Trylo is down, so the cards would
        // otherwise be lost and the task would sit paused until its
        // 5-minute timeout. `listApprovals` / `listInputRequests`
        // (see restorePendingDecisions) replay pending decisions
        // through the SAME onRuntimeUpdate channel the renderer
        // already consumes, with the SAME stable card ids — a later
        // realtime granted/resolved event upserts in place, no dupes.
        await this.restorePendingDecisions({
          taskId: task.id,
          runId,
          turnId: args.turnIds?.get(sessionId),
          conversationId: sessionId,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[WorkRuntime] reconcileProject: task.get(${taskId}) failed:`,
          err,
        );
      }
    }
  }

  /** Spec §5.3: a persisted binding whose task vanished.
   *  One user-visible error item + a callback so the
   *  renderer invalidates the persisted binding. */
  private emitStaleBinding(
    projectRoot: string,
    conversationId: string,
    taskId: string,
  ): void {
    const at = Date.now();
    const diagnosticId = `recover-missing:${taskId}`;
    const runId = newRunId();
    const update: RuntimeUpdate = {
      kind: "accepted",
      taskId,
      runId,
      conversationId,
      items: [
        {
          kind: "error",
          id: `error:${runId}:${diagnosticId}`,
          at,
          conversationId,
          userMessage:
            `已绑定的任务 ${taskId.slice(0, 8)} 在执行端不存在，` +
            `绑定已清除（可能因执行端重启）。`,
          diagnosticId,
          taskId,
          runId,
          turnId: undefined,
        },
      ],
      routerDecision: "terminal_projection",
      diagnostic: {
        id: diagnosticId,
        at,
        event: "task.recover",
        summary: `stale binding cleared (${taskId.slice(0, 8)})`,
        routeDecision: "recover",
        severity: "warn",
        taskId,
        runId,
      },
    };
    try {
      this.events.onRuntimeUpdate?.(update);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] onRuntimeUpdate threw:", err);
    }
    try {
      this.events.onStaleBinding?.({ projectRoot, conversationId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[WorkRuntime] onStaleBinding threw:", err);
    }
  }

  /** Stop the reconciler. The client is owned by the
   *  caller; we don't disconnect it here. */
  async dispose(): Promise<void> {
    for (const timer of this.decisionRecoveryTimers.values()) clearTimeout(timer);
    this.decisionRecoveryTimers.clear();
    this.pendingTaskFrames.clear();
    if (this.reconciler) {
      await this.reconciler.stop();
      this.reconciler = null;
    }
  }
}

function describePartialFailure(failureClass: string | undefined): string {
  switch (failureClass) {
    case "budget_exhausted":
      return "模型响应超时或执行预算已用尽";
    case "dependency_unavailable":
      return "所需服务暂时不可用";
    case "provider_quota":
      return "模型服务额度或频率受限";
    case "tool_error":
      return "部分工具执行失败";
    default:
      return "执行过程中存在未完成项";
  }
}
