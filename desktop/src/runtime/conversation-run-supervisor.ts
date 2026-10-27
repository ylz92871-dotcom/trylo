// Trylo Desktop — ConversationRunSupervisor.
//
// v1.16.6 (M4-A runtime ownership). This is the single owner of
// every Code run in the app (spec §2.2 / §3). React doesn't own
// the child processes; it subscribes to per-conversation ViewState
// through this supervisor. Navigation never asks it to stop —
// switching mode / session / sub-mode only changes which ViewState
// React renders. Runs keyed by `(projectKey, conversationId)` keep
// a background Code conversation writing its output back to its own
// messages even while the user is looking at Work or another chat.
//
// App is the framework adapter. This class is plain TS and is no
// more than the controller registry + a versioned subscription for
// `useSyncExternalStore`.

import { useSyncExternalStore } from 'react';
import { contextPreference, resolveContextPreference } from '../settings/context-window';
import { modelReasoningEffort, type ModelReasoningPreferences } from '../settings/model-reasoning';
import { CodeRunController, type CodeRunRequest } from './code-run-controller';
import type { ActiveCodeRun, CodeRunViewState, SettingsForCodeRun } from './runtime-types';
import { IDLE_CODE_VIEW_STATE } from './runtime-types';
import { CodeRuntimePrewarm } from './code-runtime-prewarm';
import {
  CodePermissionRegistry,
  type CodePermissionAuditEntry,
  type CodePermissionRequest,
} from './code-permission-registry';
import type { FilePath } from '../host-adapter/types';
import type { PermissionLevel } from '../permission/permission-policy';
import {
  DEFAULT_CLI_RUNTIME_PROTOCOL,
  type CliRuntimeProtocol,
} from './cli-runtime-protocol';
import { getCliRuntimeResolution } from './cli-runtime-resolution';
import { effectiveV1CliPath, effectiveLegacyCliPath } from '../host-adapter/cli-runtime-path';
import type { ResolvedToolRuntime, ToolRuntimeResolver, ToolSurface } from '../tooling/types';
import type { ToolLeaseGrant, ToolRiskRouter } from '../tooling/tool-risk-classifier';
// Round-3 P0-5: see ./steer-delivery.ts — `steerCode` answers WHY, not whether.
import { STEER_NOT_RUNNING, type SteerDelivery } from './steer-delivery';
import { RecoveredConversationStop } from './recovered-conversation-stop';
import { hostAdapter } from '../host-adapter/index';
import type { CliSessionStore } from './cli-session-store';
import { RecoveredTeamOutput, type TeamOutputRecovery } from './recovered-team-output';
import { CodeInputRegistry } from './code-input-registry';
import { cancelSubagent } from '../host-adapter/trylo-v1-subagent-control';
import { buildUserPrompt } from '../host-adapter/control-protocol';

function controllerKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`;
}

function ownedProcessIds(controllers: readonly CodeRunController[]): ReadonlySet<string> {
  return new Set(controllers.flatMap(controller => [controller.getViewState().activeProcessId,
    controller.hasPrewarm().processId]).filter((id): id is string => id !== null));
}

export interface ConversationSendPreparation {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
  cancel(): void;
}

interface PendingSend extends ActiveCodeRun {
  readonly preparation: ConversationSendPreparation;
}

/** Shared idle-TTL + clock reaper config for prewarming. */
export interface PrewarmSupervisorOptions {
  readonly sessionStore?: CliSessionStore | null;
  /** Idle retention for an idle Code runtime (spec §5.5: 10–20 min). */
  readonly idleTtlMsMs?: number;
  readonly now?: () => number;
  /**
   * Hermes MCP args resolved right before a Code CLI spawn (migration spec
   * §7.2 / §7.3). Lifecycle wiring only: the supervisor does not know what
   * the args mean. A rejection or an empty result degrades to `[]`, so a
   * missing Hermes never blocks a Code run.
   *
   * This is the LEGACY path. It now runs only when the Tool Platform could
   * not answer — see `resolveToolRuntime` below.
   */
  readonly resolveCodeCliArgs?: (() => Promise<readonly string[]>) | null;
  /**
   * Surface-aware Tool Profile resolver (tool-extension spec §4.2).
   *
   * Unlike `resolveCodeCliArgs` it receives the run's context, because a
   * Profile cannot be chosen without knowing whether the run came from Code
   * or Work (§1.1). `null` is a valid answer meaning "no Profile" — the run
   * then falls back to the legacy Hermes args. A rejection degrades the same
   * way: tooling is an enhancement, never a gate on a user's message.
   */
  readonly resolveToolRuntime?: ToolRuntimeResolver | null;
  /**
   * PR-2 (tool-extension spec §6): the host risk classifier consulted
   * before a control_request is projected. Auto-allow/deny decisions are
   * answered on the CLI's stdin directly; prompt decisions surface as
   * approval cards exactly like today. Null (default) keeps the pure
   * human-approval behaviour — wiring the classifier is additive.
   */
  readonly riskClassifier?: ToolRiskRouter | null;
  /**
   * PR-3 (§6.5): records a lease granted by an explicit user approval
   * (browser first-visit navigation). Must be the SAME store the
   * classifier instance consults, so the grant unlocks later in-origin
   * navigations until expiry.
   */
  readonly onLeaseGrant?: (grant: ToolLeaseGrant) => void;
}

/** The context a Tool Profile resolver needs (spec §4.2). */
export interface ToolRuntimeRequestContext {
  readonly surface: ToolSurface;
  readonly requestedProfileId?: string;
  readonly computerUse?: boolean;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly permissionLevel: PermissionLevel;
}

export class ConversationRunSupervisor {
  private readonly recoveredInputs = new CodeInputRegistry((id, line) => hostAdapter.process.send(id, line));
  private readonly recoveredOutput = new RecoveredTeamOutput(() => hostAdapter.process,
    (frame, processId, projectKey, conversationId) => {
      if (this.recoveredInputs.handle(frame, processId, events => this.recoveredOutput.enqueue(processId, events))) return;
      // Restored requests keep human approval: today's settings cannot grant
      // yesterday's run new automatic authority.
      this.permissions.handleControlFrame(frame, { processId, projectKey, conversationId });
    }, processId => { this.permissions.clearProcess(processId); this.recoveredInputs.clearProcess(processId); }, () => this.bump());
  private readonly recoveredStops = new RecoveredConversationStop(
    async () => hostAdapter.process, () => this.bump());
  private readonly controllers = new Map<string, CodeRunController>();
  private readonly pendingSends = new Map<string, PendingSend>();
  private sendSequence = 0;
  private readonly listeners = new Set<() => void>();
  private version = 0;
  /** M4-C1: pure prewarm policy (readiness + idle TTL + LRU). */
  private readonly prewarmPolicy: CodeRuntimePrewarm;
  private readonly prewarmIdleTtlMs: number;
  private readonly now: () => number;
  private reaperId: ReturnType<typeof setInterval> | null = null;
  /** §6.4: pending can_use_tool requests across every Code CLI. One
   *  shared registry (entries carry their scope), bumping the same
   *  version counter as run-state changes. */
  private readonly permissions: CodePermissionRegistry;
  /** Hermes MCP args provider (spec §7.3). Legacy degrade path. */
  private readonly resolveCodeCliArgs: (() => Promise<readonly string[]>) | null;
  /** Tool Profile resolver (tool-extension spec §4.2). Null ⇒ legacy only. */
  private readonly resolveToolRuntime: ToolRuntimeResolver | null;
  private readonly sessionStore: CliSessionStore | null;

  constructor(options: PrewarmSupervisorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.prewarmIdleTtlMs = options.idleTtlMsMs ?? 15 * 60 * 1000;
    this.prewarmPolicy = new CodeRuntimePrewarm({
      idleTtlMs: this.prewarmIdleTtlMs,
      now: this.now,
    });
    this.permissions = new CodePermissionRegistry({
      onChange: () => this.bump(),
      ...(options.riskClassifier ? { riskClassifier: options.riskClassifier } : {}),
      ...(options.onLeaseGrant ? { onLeaseGrant: options.onLeaseGrant } : {}),
    });
    this.resolveCodeCliArgs = options.resolveCodeCliArgs ?? null;
    this.resolveToolRuntime = options.resolveToolRuntime ?? null;
    this.sessionStore = options.sessionStore ?? null;
  }

  /**
   * Ask the Tool Platform for this run's Profile (spec §4.2).
   *
   * Returns `null` — never throws — whenever the platform cannot answer, so
   * a broken tool package removes a capability instead of the conversation
   * (§4.4). The caller then falls back to the legacy Hermes args.
   */
  async resolveRuntimeFor(context: ToolRuntimeRequestContext): Promise<ResolvedToolRuntime | null> {
    if (!this.resolveToolRuntime) return null;
    try {
      return (await this.resolveToolRuntime(context)) ?? null;
    } catch {
      return null;
    }
  }

  /** Get-or-create a controller for a conversation. */
  controller(projectKey: string, conversationId: string): CodeRunController {
    const key = controllerKey(projectKey, conversationId);
    let existing = this.controllers.get(key);
    if (!existing) {
      existing = new CodeRunController({
        projectKey,
        conversationId,
        onChange: () => this.bump(),
        permissions: this.permissions,
        sessionStore: this.sessionStore,
      });
      this.controllers.set(key, existing);
    }
    return existing;
  }

  /** Publish send feedback before any tool/service work. Ownership also lets
   * Stop invalidate a send that has not acquired a CLI controller yet. */
  beginSend(projectKey: string, conversationId: string, turnId?: string): ConversationSendPreparation | null {
    const key = controllerKey(projectKey, conversationId);
    if (this.pendingSends.has(key) || this.recoveredStops.isHeld(projectKey, conversationId)
      || this.recoveredOutput.view(projectKey, conversationId)) return null;
    const abort = new AbortController();
    const preparation: ConversationSendPreparation = {
      signal: abort.signal,
      isCurrent: () => this.pendingSends.get(key)?.preparation === preparation,
      finish: () => {
        if (!preparation.isCurrent()) return;
        this.pendingSends.delete(key);
        this.bump();
      },
      cancel: () => {
        abort.abort();
        preparation.finish();
      },
    };
    this.pendingSends.set(key, { projectKey, conversationId, preparation,
      runId: turnId ?? `preparing-${++this.sendSequence}`, startedAt: this.now(), bindingState: 'spawning' });
    this.bump();
    return preparation;
  }

  /** Read-only preflight before the composer freezes or replaces team history. */
  inspectTeamOwner(projectKey: string, conversationId: string): Promise<void> {
    return this.recoveredStops.assertAvailable(projectKey, conversationId, ownedProcessIds([...this.controllers.values()]));
  }

  hasLocalOwner(projectKey: string, conversationId: string): boolean {
    const key = controllerKey(projectKey, conversationId);
    const view = this.controllers.get(key)?.getViewState();
    return this.pendingSends.has(key) || view?.running === true || Boolean(view?.activeProcessId);
  }

  hasRecoveredOwner(projectKey: string, conversationId: string): boolean {
    return this.recoveredOutput.view(projectKey, conversationId) !== null;
  }

  recoverTeamOutput(projectKey: string, conversationId: string, teamRunId: string) {
    return this.recoveredOutput.read(projectKey, conversationId, teamRunId);
  }

  async inspectRestoredOwner(projectKey: string, conversationId: string): Promise<'owned' | 'absent' | 'detached'> {
    if (this.hasLocalOwner(projectKey, conversationId)) return 'owned';
    const result = await this.recoveredStops.inspect(projectKey, conversationId, ownedProcessIds([...this.controllers.values()]));
    return this.hasLocalOwner(projectKey, conversationId) ? 'owned' : result;
  }

  /** Drive one Code user turn on a conversation. Background-safe:
   *  the controller keeps writing to its own conversation even if
   *  the user navigated away. */
  async runCode(
    projectKey: string,
    conversationId: string,
    request: Omit<CodeRunRequest, 'projectKey' | 'conversationId'> & {
      readonly sendPreparation?: ConversationSendPreparation;
    },
  ): Promise<void> {
    const { sendPreparation, ...runRequest } = request;
    const preparation = sendPreparation ?? this.beginSend(projectKey, conversationId, request.turnId);
    if (!preparation) throw new Error('This conversation is already preparing a send.');
    if (this.pendingSends.get(controllerKey(projectKey, conversationId))?.preparation !== preparation) return;
    try {
      if (request.teamMode === true) {
        try { await this.inspectTeamOwner(projectKey, conversationId); }
        catch (error) {
          // Stop invalidates an inspection before any prompt was delivered.
          if (!preparation.isCurrent()) return;
          throw error;
        }
        if (!preparation.isCurrent()) return;
      }
      // Tool Profile for THIS run, resolved from the run's OWN context
      // (tool-extension spec §4.2). `undefined` means "not decided yet" —
      // only then does the supervisor ask the Tool Platform. An explicit
      // `null` means the caller already decided there is no Profile.
      //
      // The ask is gated on a resolver being wired at all: with none, this
      // method must reach the spawn without an extra microtask, preserving the
      // existing "runCode starts synchronously" contract the lifecycle tests
      // (and the real send path) rely on.
      let toolRuntime: ResolvedToolRuntime | null | undefined = request.toolRuntime;
      if (toolRuntime === undefined && this.resolveToolRuntime) {
        toolRuntime = await this.resolveRuntimeFor({
          surface: request.surface ?? 'code',
          ...(request.requestedProfileId
            ? { requestedProfileId: request.requestedProfileId }
            : {}),
          ...(request.computerUse !== undefined
            ? { computerUse: request.computerUse }
            : {}),
          projectKey,
          projectRoot: request.settings.cwd,
          conversationId,
          permissionLevel: request.permissionLevel,
        });
        if (!preparation.isCurrent()) return;
      }

      // Hermes MCP args are the LEGACY degrade path (spec §7.3): they run only
      // when no Tool Profile was resolved. Any failure degrades to a plain
      // run; the user's turn must never depend on tooling.
      let extraCliArgs = request.extraCliArgs;
      if (!toolRuntime && !extraCliArgs && this.resolveCodeCliArgs) {
        try {
          extraCliArgs = await this.resolveCodeCliArgs();
        } catch {
          extraCliArgs = [];
        }
      }
      if (!preparation.isCurrent()) return;
      await this.controller(projectKey, conversationId).run({
        ...runRequest,
        extraCliArgs: extraCliArgs ?? [],
        toolRuntime: toolRuntime ?? null,
      });
    } finally {
      preparation.finish();
    }
  }

  /** Manual compaction stays bound to the controller that owns the journal. */
  canCompactCode(projectKey: string, conversationId: string): boolean {
    return this.controllers.get(controllerKey(projectKey, conversationId))?.canCompact() ?? false;
  }

  compactCode(projectKey: string, conversationId: string): Promise<boolean> {
    return this.controllers.get(controllerKey(projectKey, conversationId))?.compact() ?? Promise.resolve(false);
  }

  /** Redirect an in-flight turn without replacing its runId or process. */
  steerCode(
    projectKey: string,
    conversationId: string,
    prompt: string,
  ): Promise<SteerDelivery> {
    const recovered = this.recoveredOutput.activeProcess(projectKey, conversationId);
    if (recovered) return hostAdapter.process.send(recovered, buildUserPrompt(prompt))
      .then(() => ({ kind: 'delivered' as const }), () => ({ kind: 'write-failed' as const }));
    const controller = this.controllers.get(controllerKey(projectKey, conversationId));
    // Round-3 P0-5: "no controller" means no live run to inject into — which is
    // its own answer, not a generic failure the user should retry blindly.
    return controller ? controller.steer(prompt) : Promise.resolve(STEER_NOT_RUNNING);
  }

  /** Stop one Team seat / CLI task on a live conversation process. */
  stopTask(
    projectKey: string,
    conversationId: string,
    taskId: string,
  ): Promise<boolean> {
    const recovered = this.recoveredOutput.activeProcess(projectKey, conversationId);
    if (recovered) return cancelSubagent(recovered, taskId).then(() => true, () => false);
    const controller = this.controllers.get(controllerKey(projectKey, conversationId));
    return controller ? controller.stopTask(taskId) : Promise.resolve(false);
  }

  /** M4-C1: prewarm the current conversation's idle CLI once
   *  workspace/settings/history are ready. No prompt is sent — no
   *  model request, no history. `session_start` records readiness for
   *  telemetry/reaping, but adoption may write to the created stdin before
   *  that event so prompt-driven CLIs cannot deadlock. Safe to re-call.
   *
   *  `options` makes the prewarm Profile-aware (tool-extension spec §9):
   *  Code warms `code.core.v1`, Work warms `work.core.v1`, and each
   *  prewarm carries the caller's permission level so adoption stays an
   *  exact contract match instead of the old "argv is empty" guess.
   */
  async prewarmCode(
    projectKey: string,
    conversationId: string,
    settings: SettingsForCodeRun,
    options: {
      readonly surface?: ToolSurface;
      readonly requestedProfileId?: string;
      readonly permissionLevel?: PermissionLevel;
    } = {},
  ): Promise<void> {
    if (this.recoveredStops.isHeld(projectKey, conversationId) || this.recoveredOutput.view(projectKey, conversationId)) return;
    this.prewarmPolicy.ensure(projectKey, conversationId);
    const permissionLevel = options.permissionLevel ?? 'workspace_write';
    const toolRuntime = await this.resolveRuntimeFor({
      surface: options.surface ?? 'code',
      ...(options.requestedProfileId
        ? { requestedProfileId: options.requestedProfileId }
        : {}),
      projectKey,
      projectRoot: settings.cwd,
      conversationId,
      permissionLevel,
    });
    const c = this.controller(projectKey, conversationId);
    return c.prewarm(settings, {
      permissionLevel,
      toolRuntime,
      surface: options.surface ?? 'code',
      onReady: () => {
        this.prewarmPolicy.markReady(projectKey, conversationId);
        this.bump();
      },
    });
  }

  /** Idle TTL in ms this supervisor applies to reclaiming runtimes. */
  get idleTtlMs(): number {
    return this.prewarmIdleTtlMs;
  }

  /** Reap idle runtimes across all conversations (call periodically).
   *  Returns the number of runtimes ended. Only idle runtimes past
   *  their TTL are reclaimed (spec §7.1); busy ones are never
   *  touched. Used by `startPrewarmReaper` and testable directly. */
  async reapIdleRuntimes(now = this.now()): Promise<number> {
    this.prewarmPolicy.reclaim(now);
    const results = await Promise.all(
      [...this.controllers.values()].map((c) =>
        c.reapIdleRuntime(this.prewarmIdleTtlMs, now),
      ),
    );
    const reclaimed = results.filter(Boolean).length;
    if (reclaimed > 0) this.bump();
    return reclaimed;
  }

  /** Start the periodic idle-TTL reaper. Returns a stop function.
   *  The interval only fires `reapIdleRuntimes`; app teardown calls
   *  `stopAll()` regardless. */
  startPrewarmReaper(intervalMs = 60_000): () => void {
    if (this.reaperId) return () => this.stopPrewarmReaper();
    this.reaperId = setInterval(() => {
      void this.reapIdleRuntimes();
    }, intervalMs);
    return () => this.stopPrewarmReaper();
  }

  /** Stop the periodic reaper (app exit). Does not end runtimes —
   *  `stopAll()` does that. */
  stopPrewarmReaper(): void {
    if (this.reaperId) {
      clearInterval(this.reaperId);
      this.reaperId = null;
    }
  }

  /** Stop only the current run of ONE conversation. */
  async stopConversation(projectKey: string, conversationId: string,
    onRecovered?: (receipt: TeamOutputRecovery) => void | Promise<void>): Promise<void> {
    this.recoveredOutput.requestStop(projectKey, conversationId);
    this.pendingSends.get(controllerKey(projectKey, conversationId))?.preparation.cancel();
    const c = this.controllers.get(controllerKey(projectKey, conversationId));
    const owner = c?.getViewState().activeProcessId ?? c?.hasPrewarm().processId;
    await c?.stop();
    if (owner === null || owner === undefined) await this.recoveredStops.stop(projectKey, conversationId);
    const receipts = await this.recoveredOutput.confirmStopped(projectKey, conversationId);
    for (const receipt of receipts) await onRecovered?.(receipt);
  }

  /** Stop every live run currently in flight (app exit path). */
  async stopAll(): Promise<void> {
    this.recoveredOutput.requestStop();
    for (const send of this.pendingSends.values()) send.preparation.cancel();
    const controllers = [...this.controllers.values()];
    const excluded = ownedProcessIds(controllers);
    await Promise.all(
      [...controllers.map((c) => c.stop()), this.recoveredStops.stopAll(excluded)],
    );
    await this.recoveredOutput.confirmStopped();
  }

  /** Stop every run owned by one project/workspace (close-project
   *  path), THEN drop the project's controllers so no orphan handle
   *  lingers (P1-1). Navigation between workspaces does NOT call
   *  this — both runs keep going in the background. */
  async stopWorkspace(projectKey: string): Promise<void> {
    this.recoveredOutput.requestStop(projectKey);
    for (const send of this.pendingSends.values()) {
      if (send.projectKey === projectKey) send.preparation.cancel();
    }
    const targets = [...this.controllers.entries()]
      .filter(([key]) => key.startsWith(`${projectKey}::`))
      .map(([, controller]) => controller);
    const excluded = ownedProcessIds(targets);
    await Promise.all([...targets.map((c) => c.stop()), this.recoveredStops.stopWorkspace(projectKey, excluded)]);
    await this.recoveredOutput.confirmStopped(projectKey);
    for (const controller of targets) {
      this.controllers.delete(controller.key);
    }
  }

  /** Permanently remove a conversation: stop+drops its controller.
   *  Used on delete — a deleted conversation's run must end (P0-1)
   *  and its controller must not linger (P1-1). No-op when the
   *  conversation has no controller. */
  async removeConversation(projectKey: string, conversationId: string): Promise<void> {
    this.pendingSends.get(controllerKey(projectKey, conversationId))?.preparation.cancel();
    const controller = this.controllers.get(controllerKey(projectKey, conversationId));
    await this.stopConversation(projectKey, conversationId);
    if (!controller) return;
    controller.dispose();
    if (this.controllers.get(controller.key) === controller) this.controllers.delete(controller.key);
  }

  /** ViewState for ONE visible conversation (idle default). */
  getViewState(projectKey: string, conversationId: string | null): CodeRunViewState {
    if (!conversationId) return IDLE_CODE_VIEW_STATE;
    const output = this.recoveredOutput.view(projectKey, conversationId);
    if (output) return output;
    const recovered = this.recoveredStops.view(projectKey, conversationId);
    if (recovered) return recovered;
    const pending = this.pendingSends.get(controllerKey(projectKey, conversationId));
    if (pending) return { ...IDLE_CODE_VIEW_STATE, running: true, sendable: false,
      bindingState: 'spawning', runId: pending.runId };
    return (
      this.controllers.get(controllerKey(projectKey, conversationId))?.getViewState()
      ?? IDLE_CODE_VIEW_STATE
    );
  }

  /** Runs in flight across all conversations (Activity Center). */
  activeCodeRuns(): readonly ActiveCodeRun[] {
    const runs: ActiveCodeRun[] = [];
    for (const c of this.controllers.values()) {
      const active = c.getActiveRun();
      if (active && !this.pendingSends.has(controllerKey(active.projectKey, active.conversationId))) runs.push(active);
    }
    for (const send of this.pendingSends.values()) runs.push({ projectKey: send.projectKey,
      conversationId: send.conversationId, runId: send.runId, startedAt: send.startedAt, bindingState: send.bindingState });
    return runs;
  }

  /** §6.4: pending CLI permission requests across ALL workspaces. */
  pendingCodePermissions(): readonly CodePermissionRequest[] {
    return this.permissions.list();
  }

  /** §6.4: answer one pending CLI permission by requestId. Resolves
   *  false for unknown/expired ids (caller records diagnostics). */
  respondCodePermission(requestId: string, allow: boolean): Promise<boolean> {
    return this.permissions.respond(requestId, allow);
  }

  respondInputRequest(requestId: string, status: 'submitted' | 'dismissed', answers?: Record<string, import('@trylo/work').InputRequestAnswer>): Promise<boolean> {
    if (this.recoveredInputs.has(requestId)) return this.recoveredInputs.respond(requestId, status, answers);
    for (const controller of this.controllers.values()) {
      if (controller.inputRequests.has(requestId)) return controller.inputRequests.respond(requestId, status, answers);
    }
    return Promise.resolve(false);
  }

  /** PR-2: recent host-classifier decisions across every CLI (bounded,
   *  redacted — see SafeAudit). Diagnostics surface. */
  toolRiskAudits(): readonly CodePermissionAuditEntry[] {
    return this.permissions.recentAudits();
  }

  /** Versioned snapshot for useSyncExternalStore. */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * React hook: subscribe to a live supervisor and get the ViewState
 * for one visible conversation. React only ever caches ViewState —
 * it never owns the child (spec §5.1).
 */
export function useConversationRunViewState(
  supervisor: ConversationRunSupervisor,
  projectKey: string,
  conversationId: string | null,
): CodeRunViewState {
  useSyncExternalStore(supervisor.subscribe, supervisor.getVersion);
  return supervisor.getViewState(projectKey, conversationId);
}

/** Build the SettingsForCodeRun App hands each controller, mapped
 *  from its resolved TryloSettings + the workspace cwd. Kept here
 *  so App doesn't need to navigate the settings shape. */
export function settingsForCodeRun(
  settings: {
    cliPath: FilePath;
    apiKey?: string;
    apiHost?: string;
    apiModel?: string;
    reasoningEffort?: SettingsForCodeRun['reasoningEffort'];
    modelContextPreferences?: import('../settings/context-window').ModelContextPreferences;
    modelReasoningPreferences?: ModelReasoningPreferences;
    /** v-modelsel: built-in pool override; wins over apiModel. */
    poolModel?: string;
    apiFormat?: 'anthropic' | 'openai';
    apiKeyHeader?: string;
    apiKeyPrefix?: string;
    extraHeadersText?: string;
    systemPrompt?: string;
    /** P08 §3.4: new-CLI provider selection (no credential). */
    providerId?: string;
    /** P08 §4.1: which CLI contract to spawn. */
    cliRuntimeProtocol?: CliRuntimeProtocol;
    /**
     * WP-CL / B: the user-learning switch the person actually turned on.
     * Only `enabled` matters here — this mapping never invents a value the
     * settings do not hold.
     */
    userLearning?: { readonly enabled?: boolean };
  },
  cwd: FilePath,
  directive?: { readonly collectNewLearning: boolean; readonly retention: 'normal' | 'session_only' },
): SettingsForCodeRun {
  // Effective model = pool override || user's own model. The pool never
  // overwrites apiModel, so switching pool↔own always round-trips.
  const model = settings.poolModel?.trim()
    ? settings.poolModel
    : (settings.apiModel || undefined);
  // Each protocol resolves its own entry; custom paths stay untouched.
  const protocol = settings.cliRuntimeProtocol ?? DEFAULT_CLI_RUNTIME_PROTOCOL;
  const resolution = getCliRuntimeResolution();
  const cliPath =
    protocol === 'trylo-v1'
      ? effectiveV1CliPath(settings.cliPath, resolution).path
      : effectiveLegacyCliPath(settings.cliPath, resolution).path;
  const context = resolveContextPreference(contextPreference(settings));
  const reasoningEffort = modelReasoningEffort(settings);
  return {
    cliPath: cliPath as FilePath,
    cwd,
    ...(protocol === 'trylo-v1' ? {
      contextTokenLimit: context.requested,
      modelContextWindow: context.capacity,
    } : {}),
    apiKey: settings.poolModel?.trim() ? undefined : settings.apiKey || undefined,
    apiHost: settings.poolModel?.trim() ? undefined : settings.apiHost || undefined,
    apiModel: model,
    ...(settings.poolModel?.trim() ? { platformModel: settings.poolModel.trim() } : {}),
    ...(protocol === 'trylo-v1' && reasoningEffort !== undefined ? { reasoningEffort } : {}),
    apiFormat: settings.poolModel?.trim() ? 'openai' : settings.apiFormat,
    apiKeyHeader: settings.poolModel?.trim() ? undefined : settings.apiKeyHeader || undefined,
    apiKeyPrefix: settings.poolModel?.trim() ? undefined : settings.apiKeyPrefix || undefined,
    extraHeadersText: settings.poolModel?.trim() ? undefined : settings.extraHeadersText || undefined,
    systemPrompt: settings.systemPrompt || undefined,
    // P08 §3.4: provider selection travels with the run; the credential
    // never does (the new CLI reads its own ledger).
    providerId: settings.poolModel?.trim() ? 'openai-compatible' : settings.providerId || undefined,
    // P08 §4.1: snapshotted with the rest of the contract so the run
    // cannot be re-routed by a settings change after it started.
    cliRuntimeProtocol: protocol,
    // WP-CL / B: the user-learning switch, forwarded as `--learning=user`.
    //
    // Only `user` — the Desktop has no method-learning or tool-learning toggle,
    // so claiming `all` here would turn on subsystems the person never enabled.
    // Absent (the default) leaves argv byte-for-byte what it was.
    ...(settings.userLearning?.enabled === true && directive?.collectNewLearning !== false && directive?.retention !== 'session_only'
      ? { learning: 'user' as const } : {}),
    // P08 §WP6 (audit P1): the pinned Node travels WITH the script — the
    // two come from one resolution and must not be separated, or a
    // machine without Node on PATH fails despite the bundle carrying one.
    ...((protocol === 'trylo-v1' || resolution?.legacyCliScript) && resolution?.nodeProgram
      ? { cliNodeProgram: resolution.nodeProgram }
      : {}),
  };
}
