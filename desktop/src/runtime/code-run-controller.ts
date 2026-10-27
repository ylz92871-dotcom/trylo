// Trylo Desktop — CodeRunController.
//
// v1.16.6 (M4-A runtime ownership, spec §5.1/§5.2): owns the FULL
// Code run lifecycle for ONE conversation. There is no module-level
// `activeRunGeneration` / `activeHostProcessId` anymore — each
// controller carries its own generation and process handle, so:
//
//   - starting a run in conversation A never silences a concurrent
//     run in conversation B;
//   - stop() targets THIS controller's child, not "the global
//     active process";
//   - a child that dies on its own (process.exited) clears this
//     controller's binding instead of leaving a fake-lively entry;
//   - the WARM path (reuse the same idle CLI for the next turn)
//     keeps that process's stdout flowing — the generation guard
//     only detaches a process when it is superseded by a new
//     spawn, a stop, or an exit, NOT when a new turn reuses it.
//
// The controller is framework-agnostic: no React. It notifies a
// single `onChange` callback (the supervisor) on any visible-state
// change so the renderer can re-read the ViewState.

import type { LoopEvent } from '../host-adapter/loop-events';
import type { ProcessExitInfo } from '../host-adapter/process-service';
import {
  sendControlLineToProcess,
  sendPromptToProcess,
  startTrylo,
  startTryloPrewarm,
  stopTryloProcess,
} from '../host-adapter/trylo-runner';
import {
  startTryloV1,
  stopTryloV1,
  TryloV1UnsupportedError,
} from '../host-adapter/trylo-v1-runner';
import {
  providerArgsFor,
} from '../host-adapter/cli-auth-status';
import { ensureV1Connection } from '../host-adapter/trylo-v1-connection';
import { platformModelConnection } from '../account/platform-models';
import { resolveContextPreference } from '../settings/context-window';
import { usesV1ApprovalTransport } from '../host-adapter/trylo-v1-control';
import {
  beginSessionCreate,
  isSessionResumable,
  probeCliSessions,
  resolveUnknownBinding,
  type CliSessionBinding,
} from '../host-adapter/cli-session-binding';
import {
  DEFAULT_CLI_RUNTIME_PROTOCOL,
  capabilitiesFor,
  supportsPrewarm,
  supportsSteering,
  type CliRuntimeProtocol,
} from './cli-runtime-protocol';
import { buildStopTaskRequest } from '../host-adapter/control-protocol';
import { cancelSubagent } from '../host-adapter/trylo-v1-subagent-control';
import type { ChatMessage } from '../components/chat/types';
import type { CodeRunBindingState, CodeRunViewState, SettingsForCodeRun } from './runtime-types';
import type { RuntimeResultScope } from '../results/result-scope';
import type { CodeRunLifecycleObserver, CodeRunOutcome } from './code-run-lifecycle';
import type { CodePermissionRegistry, CodePermissionRequest } from './code-permission-registry';
import { CodeInputRegistry } from './code-input-registry';
import type { CodeDiagnosticsBuffer } from '../diagnostics/code-diagnostics-buffer';
// Round-3 P0-5: `steer` must say WHY it did not inject, not just that it did
// not. See ./steer-delivery.ts.
import {
  STEER_DELIVERED,
  STEER_NOT_RUNNING,
  STEER_UNSUPPORTED,
  type SteerDelivery,
} from './steer-delivery';
import type { PermissionLevel } from '../permission/permission-policy';
import type { ResolvedToolRuntime, ToolSurface } from '../tooling/types';
import { verifyCliRuntime } from './cli-runtime-guard';
import { fingerprintForRun } from '../tooling/runtime-fingerprint';
import { spawnEnvForTeamAccess } from '../tooling/team-surface-env';
import { observeToolProtocol, protocolDriftReasonCode } from '../tooling/tool-protocol-observer';
import type { CliSessionLease, CliSessionStore } from './cli-session-store';

let runSeq = 0;

interface V1StartupTicket {
  state: 'starting' | 'cancelled';
}

/** Baseline capture budget (spec §7.2 / §14): a slow Git snapshot never
 *  blocks the run from starting. */
const BASELINE_TIMEOUT_MS = 3000;

export interface CodeRunControllerOptions {
  readonly projectKey: string;
  readonly conversationId: string;
  /** Called whenever the visible ViewState changes. */
  readonly onChange: () => void;
  /** C-Edge P2-5: structured diagnostic event sink. Optional — when
   *  omitted, the controller still runs but produces no diagnostics.
   *  The buffer is owned at the App level (one per app instance) and
   *  is shared across every controller. */
  readonly diagnostics?: CodeDiagnosticsBuffer | null;
  /** §6.4 (Code path): shared pending-permission registry. When wired,
   *  control_request frames from this controller's CLI surface as pending
   *  permissions and are answerable by requestId. Optional — without it,
   *  control frames are dropped (chat/plan mode runs would stall on
   *  approval with no answer path). */
  readonly permissions?: CodePermissionRegistry | null;
  readonly sessionStore?: CliSessionStore | null;
}

export interface CodeRunRequest {
  readonly prompt: string;
  readonly settings: SettingsForCodeRun;
  readonly codeMode: 'plan' | 'agent' | 'chat';
  /** P2 (spec §4.4 / §5): the resolved UI permission level for THIS
   *  run, snapshotted by `App.onSend`. The runtime does NOT re-read
   *  it from a global ref; a mid-run picker change must not leak
   *  into the running CLI. */
  readonly permissionLevel: PermissionLevel;
  /** Recovery-only history passed when we must SPAWN (a live
   *  idle process is reused without replaying it). */
  readonly priorMessages: readonly ChatMessage[];
  /** Applied to the ORIGINAL conversation even if the user has
   *  since navigated away (background write-back). */
  readonly onEvents: (events: readonly LoopEvent[]) => void;
  /** M4-C5 (P1-3): fired exactly once per run with the path taken
   *  (warm = reused an idle CLI or adopted a prewarm; cold = a fresh
   *  spawn). Lets App drive RunTelemetry's cold/warm mark. Optional. */
  readonly onRuntimeAcquired?: (info: { warm: boolean }) => void;
  /** P2-1 (spec §7.2): the originating user-message id, generated by App
   *  before the user message is created. The controller passes it into the
   *  result scope; it is NOT a Run primary-key substitute. */
  readonly turnId?: string;
  /** P2-1 (spec §7.2): optional result lifecycle observer. When set, the
   *  controller awaits `onRunStarted` (bounded) before writing the prompt,
   *  forwards structured events via `onEvents`, and fires `onRunTerminal`
   *  exactly once per runId on loop_end / session_end / process exit /
   *  cancel. Result projection failures never block the Agent run. */
  readonly lifecycleObserver?: CodeRunLifecycleObserver;
  /** Hermes MCP args for THIS run (migration spec §7.2 / §7.3). Empty for a
   *  plain run — the learning profile is per-run, never a global default.
   *  A live warm/prewarm process is only reused when its argv matches, so a
   *  learning-capable run can never silently inherit a plain CLI. */
  readonly extraCliArgs?: readonly string[];
  /**
   * The composed Tool Profile for THIS run (tool-extension spec §4.2 / §9).
   *
   * `null` (or omitted) means "no tool plane answer" and is a VALID state:
   * the run degrades to `extraCliArgs` and its fingerprint falls back to the
   * legacy argv key, so a plain Code run keeps byte-identical warm/prewarm
   * behaviour. Two processes may be shared only when the FULL runtime
   * contract matches — model, host, permission level, system prompt, Profile
   * and MCP config — not merely the injected argv (spec §1.4).
   */
  readonly toolRuntime?: ResolvedToolRuntime | null;
  /**
   * §4.2: which surface this run belongs to. Used to ASK for a Profile when
   * `toolRuntime` was left undecided, and to inject TRYLO_TEAM_SURFACE=work
   * even when the Profile is missing so Work seats cannot degrade to Code.
   */
  readonly surface?: ToolSurface;
  readonly requestedProfileId?: string;
  /** 电脑控制 switch (`settings.workComputer`). `false` on a Work run drops
   *  the Windows desktop-control package from the resolved Tool Profile. */
  readonly computerUse?: boolean;
  /** Team Access (PR-7): this run's Governor decided spawn_team and the
   *  gate passed. Adds TRYLO_TEAM_MODE to the spawn env so the Code
   *  surface lists the five seats; changes the fingerprint so a warm
   *  stay_solo CLI is never silently reused (spec §14.5). */
  readonly teamMode?: boolean;
  readonly teamRunId?: string;
}

/** Profile env plus TRYLO_TEAM_SURFACE for Work, even when the Profile is missing.
 *  teamMode adds TRYLO_TEAM_MODE for Code spawn_team runs (never on Work). */
function effectiveSpawnEnv(
  surface: ToolSurface | undefined,
  runtime: ResolvedToolRuntime | null | undefined,
  teamMode?: boolean,
): Readonly<Record<string, string>> {
  return spawnEnvForTeamAccess(surface, teamMode === true, runtime?.spawnEnv);
}

/** Build the full runtime identity of a run (spec §9). */
function runFingerprint(request: Pick<CodeRunRequest, 'settings' | 'permissionLevel' | 'extraCliArgs' | 'toolRuntime' | 'surface' | 'teamMode'>): string {
  const s = request.settings;
  const runtime = request.toolRuntime ?? null;
  return fingerprintForRun({
    cliPath: s.cliPath,
    cwd: s.cwd,
    apiKey: s.apiKey,
    apiHost: s.platformModel ? 'trylo-account:' + s.platformModel : s.apiHost,
    apiModel: s.apiModel,
    apiFormat: s.apiFormat,
    apiKeyHeader: s.apiKeyHeader,
    apiKeyPrefix: s.apiKeyPrefix,
    extraHeadersText: s.extraHeadersText,
    systemPrompt: s.systemPrompt,
    permissionLevel: request.permissionLevel,
    // The EFFECTIVE argv: when a Profile was resolved the runner sends the
    // Profile's flags, so the identity must be computed from those — using
    // the raw request args here would mint a different fingerprint for the
    // same actual spawn (the prewarm/run adoption contract would break).
    extraCliArgs: runtime ? [...runtime.cliArgs] : (request.extraCliArgs ?? []),
    toolRuntime: runtime,
    spawnEnv: effectiveSpawnEnv(request.surface, runtime, request.teamMode),
    // P08 §4.1: the protocol is fixed at spawn, so it is part of the
    // identity. A legacy process must never be reused for a v1 run.
    cliRuntimeProtocol: request.settings.cliRuntimeProtocol ?? DEFAULT_CLI_RUNTIME_PROTOCOL,
  });
}

export class CodeRunController {
  private readonly projectKey: string;
  private readonly conversationId: string;
  private readonly onChange: () => void;
  /** Optional. When wired, every visible lifecycle transition emits
   *  a hashed event into the buffer. The buffer is the only place
   *  production-mode Code diagnostics live; it never depends on
   *  `RUN_TELEMETRY_DEBUG` or `console.log`. */
  private readonly diagnostics: CodeDiagnosticsBuffer | null;

  /**
   * Detaches superseded processes. Bumped on a NEW spawn, a stop,
   * or a process exit — NOT on warm reuse of the same process. A
   * spawn's stdout handler checks `snapshot === this.generation`
   * so output that belongs to a replaced / stopped process is
   * dropped, while output from the current process (including
   * later turns reusing it) keeps flowing.
   */
  private generation = 0;
  private stoppingProcessId: string | null = null;
  private stopOperation: Promise<void> | null = null;
  /** Native spawn owns this ticket before its exact handle is delivered. */
  private pendingV1Start: V1StartupTicket | null = null;
  private processId: string | null = null;
  private pid: number | null = null;
  private bindingState: CodeRunBindingState = 'idle';
  /** One selected-profile notice until the selection or its configuration changes. */
  private warnedV1Profile: string | null = null;
  private error = false;
  private runId: string | null = null;
  /** User-turn attribution retained until this controller releases its native handle. */
  private nativeTurnId: string | null = null;
  private startedAt = 0;
  /** True while a user turn expects model output. Cleared on
   *  loop_end; if process.exited arrives while busy it is a
   *  crash (error). */
  private busy = false;
  /** P2-1: the result scope for the CURRENT in-flight run. Set at the top
   *  of `run()`, cleared by the exactly-once terminal guard so a late entry
   *  never re-fires. Captured eagerly so a later runId=null (cleanup) can
   *  never orphan the terminal notification. */
  private resultScope: RuntimeResultScope | null = null;
  private lifecycleObserver: CodeRunLifecycleObserver | null = null;
  private readonly permissions: CodePermissionRegistry | null;
  readonly inputRequests = new CodeInputRegistry(async (id, line) => {
    if (!await sendControlLineToProcess(id, line)) throw new Error('User input could not reach its owning CLI process');
  });

  // M4-C1 prewarm: an idle CLI spawned ahead of the first send so
  // cold-start (Node loading the ~50.8 MiB single-file bundle) is
  // OUT of the first-turn critical path. The controller spawns it,
  // records the structured `session_start` gate for telemetry, and a
  // user turn ADOPTS the process as soon as its stdin handle exists.
  // `turnSink` is the conversation-scoped event sink
  // the adopted process routes its turn output through.
  private prewarming = false;
  private prewarmProcessId: string | null = null;
  private prewarmReady = false;
  private prewarmSpawnedAt = 0;
  private lastIdleAt = 0;
  /** Invalidates callbacks from a prewarm that was adopted, superseded,
   *  stopped, or completed after a real run had already started. */
  private prewarmAttempt = 0;
  private turnSink: ((events: readonly LoopEvent[]) => void) | null = null;
  /** The FULL runtime identity of the currently owned process (spec §9).
   *  Null until a spawn lands. A run may reuse this process only when its
   *  own fingerprint is byte-identical — argv alone is not enough, because
   *  model / host / permission level / system prompt / MCP config are all
   *  fixed at spawn time too. */
  private ownedFingerprint: string | null = null;
  /** The runtime identity a prewarmed process was spawned with. */
  private prewarmFingerprint: string | null = null;
  /** P08 §4.1: the protocol of the process this controller currently
   *  owns. Decides whether `stop` may reuse the legacy killer path or
   *  must mark a one-shot run as cancelled (v1 has no other way to tell
   *  "the user stopped it" from "it crashed"). */
  private ownedProtocol: CliRuntimeProtocol = DEFAULT_CLI_RUNTIME_PROTOCOL;
  /**
   * P08 §6.2: this conversation's CLI session binding for the v1 path.
   * Lives on the controller (one per conversation) so a second turn
   * resumes instead of starting over. Ephemeral on the legacy path —
   * there the CLI is a resident process and owns its own context.
   */
  private cliSession: CliSessionBinding = { state: 'none' };
  private readonly sessionStore: CliSessionStore | null;
  private sessionLease: CliSessionLease | null = null;
  private sessionRoot: string | null = null;
  private sessionWrites: Promise<void> = Promise.resolve();
  private compactRequest: CodeRunRequest | null = null;

  constructor(options: CodeRunControllerOptions) {
    this.projectKey = options.projectKey;
    this.conversationId = options.conversationId;
    this.onChange = options.onChange;
    this.diagnostics = options.diagnostics ?? null;
    this.permissions = options.permissions ?? null;
    this.sessionStore = options.sessionStore ?? null;
  }

  /** Stable registry key for this conversation's controller. */
  get key(): string {
    return `${this.projectKey}::${this.conversationId}`;
  }

  getViewState(): CodeRunViewState {
    const starting = this.bindingState === 'spawning';
    const running = this.bindingState === 'busy' || starting || this.pendingV1Start !== null;
    return {
      running,
      error: this.error,
      activeProcessId: this.processId,
      sendable: !running,
      bindingState: this.bindingState,
      runId: this.runId,
      pid: this.pid,
    };
  }

  ownsNativeTurn(turnId: string): boolean {
    return turnId.length > 0 && this.nativeTurnId === turnId && (this.processId !== null || this.pendingV1Start !== null);
  }

  /** A run in flight (for the Activity Center). */
  getActiveRun(): { projectKey: string; conversationId: string; runId: string; startedAt: number; bindingState: CodeRunBindingState } | null {
    if (!this.runId || this.bindingState === 'idle' || this.bindingState === 'exited') {
      return null;
    }
    return {
      projectKey: this.projectKey,
      conversationId: this.conversationId,
      runId: this.runId,
      startedAt: this.startedAt,
      bindingState: this.bindingState,
    };
  }

  /** Pending permission requests owned by THIS conversation's CLI
   *  (§6.4; used by the companion projection / ApprovalService). */
  pendingPermissions(): readonly CodePermissionRequest[] {
    if (!this.permissions) return [];
    return this.permissions.list().filter(
      (request) => request.projectKey === this.projectKey && request.conversationId === this.conversationId,
    );
  }

  /**
   * Drive one user turn on this conversation. Reuses a live idle
   * CLI when one exists; otherwise spawns. Resolves once the prompt
   * is accepted — it does not await the full model loop (that
   * streams via `request.onEvents`). If this controller is
   * superseded while a spawn is in flight, the spawn is cancelled
   * and this resolves quietly.
   */
  /** One-line helper: emit a diagnostic event if a buffer is wired.
   *  Run id is read from the in-flight `runId` so the transition is
   *  always traceable, even when the event fires from a path that
   *  ran without a turn context (e.g. prewarm adoption). */
  private diag(
    type: import('../diagnostics/code-diagnostics-buffer').DiagEventType,
    extras: {
      readonly latencyMs?: number;
      readonly reasonCode?: string;
      readonly exitCode?: number;
      readonly signal?: number;
    } = {},
  ): void {
    const buf = this.diagnostics;
    if (!buf) return;
    const runId = this.runId ?? `prewarm-${this.conversationId}`;
    buf.push({
      type,
      runId,
      projectKey: this.projectKey,
      conversationId: this.conversationId,
      ...extras,
    });
  }

  /**
   * PR-2 (§3 / §4.4): compare the tool list the CLI reported at init against
   * the run Profile's expectedTools. Drift lands in run diagnostics — tool
   * names only, never paths or input. A package whose manifest asserts
   * nothing stays silent (honest, not faked).
   */
  private reportToolProtocolDrift(
    observedTools: readonly string[],
    runtime: ResolvedToolRuntime | null,
  ): void {
    if (!runtime) return;
    try {
      for (const record of observeToolProtocol(observedTools, runtime)) {
        if (record.protocol !== 'drift') continue;
        this.diag('tool.protocol_drift', { reasonCode: protocolDriftReasonCode(record) });
      }
    } catch {
      /* non-fatal: diagnostics must never break the event fan-out */
    }
  }

  private reportV1ProfileUnavailable(request: CodeRunRequest, onEvents: CodeRunRequest['onEvents'], now: number): void {
    const runtime = request.toolRuntime;
    if (!request.requestedProfileId?.trim() || !runtime
        || runtime.spawnEnv.TRYLO_MCP_RUNTIME_REGISTRY
      || !runtime.cliArgs.some(arg => /^--(?:mcp-config|settings|strict-mcp-config)(?:=|$)/.test(arg))) {
      this.warnedV1Profile = null;
      return;
    }
    const identity = JSON.stringify([runtime.profileId, runtime.profileRevision, runtime.mcpConfigHash, runtime.permissionSettingsHash]);
    if (identity === this.warnedV1Profile) return;
    this.warnedV1Profile = identity;
    onEvents([{ type: 'runtime_warning', seq: 0, ts: now, id: `${this.runId ?? 'run'}:desktop-profile`,
      code: 'desktop_profile_unavailable',
      message: '所选 Desktop Tool Profile 尚未接通新 CLI；本次使用 CLI 自身的 MCP 配置。',
    }]);
  }

  /** Tracks whether we've already emitted the first-event transition
   *  for the current run — the spec only cares about the FIRST frame
   *  of each kind, not every subsequent one. */
  private firstRawEmitted = false;
  private firstSemanticEmitted = false;

  private maybeEmitFirstEvents(events: readonly LoopEvent[]): void {
    if (this.firstRawEmitted && this.firstSemanticEmitted) return;
    for (const e of events) {
      if (!this.firstRawEmitted && e.type !== 'session_start') {
        this.firstRawEmitted = true;
        const latency = this.startedAt > 0 ? Math.max(0, Date.now() - this.startedAt) : 0;
        this.diag('first.raw_event', { latencyMs: latency });
        if (this.firstSemanticEmitted) return;
      }
      if (
        !this.firstSemanticEmitted &&
        (e.type === 'text' || e.type === 'thinking' || e.type === 'tool_use' || e.type === 'api_stream')
      ) {
        this.firstSemanticEmitted = true;
        const latency = this.startedAt > 0 ? Math.max(0, Date.now() - this.startedAt) : 0;
        this.diag('first.semantic_event', { latencyMs: latency });
        if (this.firstRawEmitted) return;
      }
    }
  }

  async run(request: CodeRunRequest): Promise<void> {
    if (this.stoppingProcessId || this.stopOperation || this.pendingV1Start) throw new Error('The previous process start or stop is unconfirmed; retry Stop before starting another run.');
    if (request.prompt.trim() !== '/compact') this.compactRequest = { ...request, priorMessages: [],
      lifecycleObserver: undefined, onRuntimeAcquired: undefined };
    const protocol: CliRuntimeProtocol = request.settings.cliRuntimeProtocol ?? DEFAULT_CLI_RUNTIME_PROTOCOL;
    // A one-shot run acquires ownership before asynchronous authentication.
    // Stop or a newer send can invalidate it without a late probe reviving it.
    const startupGeneration = protocol === 'trylo-v1' ? ++this.generation : this.generation;
    const now = Date.now();
    this.runId = `run-${this.conversationId}:${now.toString(36)}:${++runSeq}`;
    this.nativeTurnId = request.turnId ?? null;
    this.startedAt = now;
    this.busy = true;
    this.error = false;
    // First-event emission is per-run, not per-process. Reset here so
    // a second turn on the same warm CLI still gets a fresh latency
    // measurement.
    this.firstRawEmitted = false;
    this.firstSemanticEmitted = false;
    // Become visibly busy before Git baseline capture or runtime adoption.
    // Otherwise a slow additive step makes Send look like a no-op and leaves
    // the composer enabled for a second submission.
    this.bindingState = 'spawning';
    this.notify();
    // Conversation-scoped sink. The adopted (prewarmed) process
    // routes its output through this; it stays the same across
    // turns of one conversation (M4-A background write-back).
    this.turnSink = request.onEvents;

    // P2-1: build the result scope eagerly and establish the (bounded)
    // projection state BEFORE any prompt write (spec §7.2, audit P1-1).
    // The observer creates the run's event buffer synchronously; the Git
    // baseline itself completes asynchronously and never gates the run.
    this.lifecycleObserver = request.lifecycleObserver ?? null;
    const scope: RuntimeResultScope = {
      projectKey: this.projectKey,
      projectRoot: request.settings.cwd,
      conversationId: this.conversationId,
      mode: 'code',
      runId: this.runId!,
      turnId: request.turnId ?? '',
      startedAt: now,
    };
    this.resultScope = scope;
    await this.captureBaseline(scope);
    if (protocol === 'trylo-v1' && startupGeneration !== this.generation) return;

    // P08 §4.1: the protocol is snapshotted with everything else. A
    // run must never be re-routed mid-flight by a settings change.
    const caps = capabilitiesFor(protocol);

    // A different engine did not write this journal. Returning to v1 must
    // replay visible history into a fresh session so intervening legacy turns
    // cannot disappear behind a resume of the earlier v1 context.
    try {
      if (this.sessionStore && !this.sessionLease) {
        const lease = await this.sessionStore.open(request.settings.cwd, this.conversationId);
        if (startupGeneration !== this.generation) return;
        this.sessionLease = lease;
        this.sessionRoot = request.settings.cwd;
        this.cliSession = lease.binding.state === 'none' ? lease.binding : {
          state: 'unknown', sessionId: lease.binding.sessionId, reason: 'Desktop owner reconstructed',
        };
      }
      if (this.sessionRoot !== null && this.sessionRoot !== request.settings.cwd) {
        throw new Error('CLI session workspace changed; create a controller for the new workspace.');
      }
      // Drain prior event writes before reading/updating this controller's state.
      // A failed event write is retried below with the current binding.
      if (this.sessionLease) await this.sessionWrites.catch(() => undefined);
      if (startupGeneration !== this.generation) return;
      if (protocol !== this.ownedProtocol) this.cliSession = { state: 'none' };

      // The CLI journal, rather than stored Desktop metadata, decides whether
      // a reconstructed association may resume.
      if (protocol === 'trylo-v1' && this.cliSession.state === 'unknown') {
        const probe = await probeCliSessions({
          cliPath: request.settings.cliPath,
          ...(request.settings.cliNodeProgram
            ? { nodeProgram: request.settings.cliNodeProgram }
            : {}),
        });
        if (startupGeneration !== this.generation) return;
        this.cliSession = resolveUnknownBinding(
          this.cliSession,
          isSessionResumable(probe, this.cliSession.sessionId),
        );
        if (this.cliSession.state === 'unknown') {
          throw new Error('CLI session recovery could not be verified; retry after the session probe is available.');
        }
      }
      // Even if run_start never arrives, a creating identity remains available
      // for a probe after reconstruction instead of orphaning its journal.
      if (protocol === 'trylo-v1' && this.cliSession.state === 'none') {
        this.cliSession = beginSessionCreate(this.runId ?? `run-${this.conversationId}`);
      }
      // A recoverable identity must exist durably before any root process is
      // dispatched. Stop during this await invalidates the startup generation.
      if (this.sessionLease) await this.saveCliSession(this.cliSession);
    } catch (error) {
      if (startupGeneration !== this.generation) return;
      this.failStartup(scope, error);
      throw error;
    }
    if (startupGeneration !== this.generation) return;
    const pendingBinding: CliSessionBinding | undefined =
      protocol === 'trylo-v1' ? this.cliSession : undefined;

    // Check the CLI's actual credential visibility before task spawn.
    // A refusal clears the startup state; no prompt has been delivered.
    //
    // No provider configured (the M0 dev path) skips the probe entirely:
    // the CLI's own default applies, and paying two extra process spawns
    // per turn to learn "fixture needs no credential" would be waste.
    let providerArgs: ReturnType<typeof providerArgsFor>;
    let v1SpawnEnv: Readonly<Record<string, string>> | undefined;
    let connection = request.settings;
    try {
      if (request.settings.platformModel) {
        const local = await platformModelConnection(request.settings.platformModel);
        connection = { ...request.settings, ...local, apiKeyHeader: undefined, apiKeyPrefix: undefined, extraHeadersText: undefined };
        const budget = resolveContextPreference({ window: request.settings.contextTokenLimit, capacity: request.settings.modelContextWindow }, local.modelContextWindow);
        connection = { ...connection, contextTokenLimit: budget.requested, modelContextWindow: budget.capacity };
      }
      providerArgs = providerArgsFor({
        providerId: connection.providerId,
        apiHost: connection.apiHost,
        apiModel: connection.apiModel,
        apiFormat: connection.apiFormat,
      });
      // Runtime identity and credential visibility are independent read-only
      // checks. Await both before sending a prompt, without adding their cold
      // process startup times together. The guard memoizes runtime identity.
      const checkRuntime = async (): Promise<void> => {
        const guard = await verifyCliRuntime({
          protocol,
          ...(protocol === 'trylo-v1' ? { requiredFlags: [
            ...(connection.contextTokenLimit !== undefined ? ['--context-window'] : []),
            ...(connection.modelContextWindow !== undefined ? ['--model-context-window'] : []),
          ] } : {}),
          entryScript: request.settings.cliPath,
          ...(request.settings.cliNodeProgram
            ? { nodeProgram: request.settings.cliNodeProgram }
            : {}),
        });
        if (!guard.ok) throw new Error(guard.message);
      };
      if (protocol === 'trylo-v1') {
        const [connectionEnv] = await Promise.all([
          ensureV1Connection(connection, providerArgs),
          checkRuntime(),
        ]);
        v1SpawnEnv = { ...effectiveSpawnEnv(request.surface, request.toolRuntime, request.teamMode),
          ...connectionEnv };
        if (usesV1ApprovalTransport(request.permissionLevel) && !this.permissions) {
          throw new TryloV1UnsupportedError('trylo-v1: Desktop approval registry is unavailable.');
        }
      } else {
        await checkRuntime();
      }
    } catch (error) {
      if (protocol === 'trylo-v1' && startupGeneration !== this.generation) return;
      if (!this.busy) return;
      this.failStartup(scope, error);
      throw error;
    }
    if (protocol === 'trylo-v1' && startupGeneration !== this.generation) return;

    // A stop (or a newer run) while the guard was in flight supersedes this
    // run the same way it supersedes an in-flight spawn: generation moved,
    // so return quietly without ever spawning (no orphan to stop later).
    if (startupGeneration !== this.generation) return;

    const fingerprint = runFingerprint(request);

    // Warm path: the same controller already owns a live idle CLI whose
    // ENTIRE runtime contract already matches this run (spec §9) — argv,
    // model, host, permission level, system prompt and Tool Profile.
    //
    // P08 §3.3: trylo-v1 is one process per turn, so there is no warm
    // path at all. Reusing a v1 process would send a second prompt to a
    // process whose stdin is already closed — it would be ignored, and
    // the run would look like "the model didn't answer".
    if (caps.warmReuse && !request.settings.platformModel && this.processId && this.ownedFingerprint === fingerprint) {
      this.bindingState = 'busy';
      this.notify();
      request.onRuntimeAcquired?.({ warm: true });
      const sent = await sendPromptToProcess(this.processId, request.prompt);
      if (sent) {
        this.diag('prompt.write.accepted');
        this.notify();
        return;
      }
      this.diag('prompt.write.rejected', { reasonCode: 'warm_reuse' });
      // The live handle rejected the write — it's dead. Detach it
      // and fall through to a fresh spawn.
      this.generation += 1;
      const rejectedId = this.processId;
      this.processId = null;
      this.pid = null;
      await stopTryloProcess(rejectedId).catch(() => { /* already gone */ });
    }

    // M4-C1 prewarm adoption: process_spawn returning means stdin is writable.
    // Do not wait for session_start here: the CLI can legitimately emit that
    // event only after it receives its first stream-json user message. Waiting
    // for the event before writing the message creates a permanent deadlock.
    // OS pipes buffer the prompt while the child finishes initialization.
    // A prewarm is adopted only by a run whose FULL runtime contract equals
    // the one the idle process was spawned with (spec §9). The old rule —
    // "argv is empty" — let a run adopt a process started with a different
    // model, host, permission level or system prompt, all of which are fixed
    // at spawn (spec §1.4). A Work run carrying a Tool Profile therefore
    // adopts only a Work prewarm of the same Profile.
    //
    // CONTEXT (2026-09-03): a prewarm is ALWAYS spawned EMPTY — no prompt and
    // no conversation history. Adopting it is therefore only safe for a run
    // that has nothing to replay (a genuinely fresh first message). A RESUMED
    // conversation carries `priorMessages`; reusing the empty idle CLI here
    // would hand the model only the current message, silently resetting the
    // thread to "first message". So history-bearing runs MUST skip adoption
    // and fall through to a cold spawn that replays `priorMessages` via
    // `promptWithHistory` (trylo-runner.ts).
    if (
      caps.prewarm &&
      request.priorMessages.length === 0 &&
      !this.processId &&
      this.prewarmProcessId &&
      this.prewarmFingerprint === fingerprint
    ) {
      const adoptedId = this.prewarmProcessId;
      this.prewarmProcessId = null;
      this.prewarmReady = false;
      this.prewarmAttempt += 1;
      this.processId = adoptedId;
      this.ownedProtocol = protocol;
      this.ownedFingerprint = fingerprint;
      this.bindingState = 'busy';
      this.notify();
      request.onRuntimeAcquired?.({ warm: true });
      this.diag('prewarm.adopted');
      const sent = await sendPromptToProcess(adoptedId, request.prompt);
      if (sent) {
        this.diag('prompt.write.accepted');
        this.notify();
        return;
      }
      this.diag('prompt.write.rejected', { reasonCode: 'prewarm_adoption' });
      // Prewarm process rejected the write — it's dead. Detach
      // and fall through to a cold spawn.
      this.generation += 1;
      this.processId = null;
      this.pid = null;
      await stopTryloProcess(adoptedId).catch(() => { /* already gone */ });
    }

    // Cold path: (re)spawn for this conversation only. Detach any
    // prior process now that we are replacing it.
    // A live process whose runtime fingerprint differs from this run's — a
    // plain warm/prewarm CLI facing a run that needs a Tool Profile, a
    // different model, a different host, or a different permission level —
    // is stopped here so the cold spawn cannot leave an orphan behind
    // (spec §9: Profile / permission / model changes restart at the safety
    // boundary).
    if (this.processId) {
      const replacedId = this.processId;
      const stop = this.ownedProtocol === 'trylo-v1' ? stopTryloV1 : stopTryloProcess;
      try { await stop(replacedId); }
      catch (error) {
        if (startupGeneration !== this.generation || this.processId !== replacedId) return;
        this.retainUnconfirmedProcess(replacedId);
        throw error;
      }
      // Stop or a newer dispatch can invalidate replacement while cleanup waits.
      if (startupGeneration !== this.generation) return;
      this.processId = null;
      this.pid = null;
    }
    // Same for an un-adopted prewarm: once this run's contract differs, OR the
    // run must replay history (which the empty idle process never saw — see the
    // CONTEXT note above), the idle process can never be adopted — keeping it
    // would be exactly the process explosion §9 warns about (one active runtime
    // + one stale candidate per conversation, growing on every Profile flip).
    if (
      this.prewarmProcessId &&
      (this.prewarmFingerprint !== fingerprint || request.priorMessages.length > 0)
    ) {
      const stalePrewarmId = this.prewarmProcessId;
      this.prewarmProcessId = null;
      this.prewarmFingerprint = null;
      this.prewarmReady = false;
      this.prewarmAttempt += 1;
      await stopTryloProcess(stalePrewarmId).catch(() => { /* already gone */ });
    }
    this.generation += 1;
    const spawnGeneration = this.generation;
    request.onRuntimeAcquired?.({ warm: false });
    if (protocol === 'trylo-v1' && spawnGeneration !== this.generation) return;
    this.diag('cold.fallback');
    const guard = { isSuperseded: () => spawnGeneration !== this.generation };
    // PR-2 (§6.2): the classifier scope is snapshotted from THIS run's
    // request, exactly like the permission level — a mid-run picker change
    // must not re-classify an in-flight process's requests. An empty list
    // when no Profile was resolved means "nothing is managed by this run",
    // so an unexpected managed-looking frame routes to a human.
    const spawnToolRuntime = request.toolRuntime ?? null;
    const classifierScope = {
      projectRoot: request.settings.cwd,
      permissionLevel: request.permissionLevel,
      ...(spawnToolRuntime?.profileId ? { profileId: spawnToolRuntime.profileId } : {}),
      managedPackageIds: spawnToolRuntime
        ? spawnToolRuntime.packageHealth.filter((p) => p.available).map((p) => p.id)
        : [],
    };
    // PR-2: the CLI reports its tool list once per process (system/init →
    // loop_start). Observed per closure so a warm reuse never re-reports.
    let toolProtocolChecked = false;
    // Shared by both runner routes so the v1 path cannot drift from the
    // legacy one on turn bookkeeping (P2-1 projection, busy clearing,
    // terminal fan-out).
    let terminalState: 'open' | 'observed' = 'open';
    let lastSequence = -1;
    const publishRunEvents = (events: readonly LoopEvent[]): void => {
      for (const event of events) if (event.seq > lastSequence) lastSequence = event.seq;
      if (events.some(event => event.type === 'loop_end' || event.type === 'session_end')) terminalState = 'observed';
      if (!toolProtocolChecked) {
        const init = events.find((e) => e.type === 'loop_start');
        if (init && init.type === 'loop_start') {
          toolProtocolChecked = true;
          this.reportToolProtocolDrift(init.tools, spawnToolRuntime);
        }
      }
      if (protocol === 'legacy-stream-json') {
        // Cold and prewarmed legacy processes share the same per-turn sink
        // and idle timestamp. This handler also serves later warm turns.
        this.handleTurnEvents(events);
        return;
      }
      const scope = this.resultScope;
      if (scope && this.lifecycleObserver) {
        try {
          this.lifecycleObserver.onEvents(scope, events);
        } catch {
          /* non-fatal: never let projection poison the event fan-out */
        }
      }
      this.maybeEmitFirstEvents(events);
      if (events.some((e) => e.type === 'loop_end' || e.type === 'session_end')) {
        this.busy = false;
        this.bindingState = 'idle';
        this.notify();
        if (scope) this.fireTerminal(scope, outcomeFromEvents(events));
      }
      request.onEvents(events);
    };
    const onRunEvents = (events: readonly LoopEvent[]): void => {
      if (spawnGeneration === this.generation) publishRunEvents(events);
    };
    const publishConfirmedCancellation = (): void => {
      if (protocol !== 'trylo-v1' || terminalState === 'observed') return;
      const ts = Date.now();
      publishRunEvents([{ type: 'loop_end', seq: lastSequence + 1, ts, reason: 'cancelled',
        durationMs: Math.max(0, ts - now), totalCost: 0, numTurns: 0, finalResult: '', isError: true }]);
    };
    let processExited = false;
    const onRunExit = (info: ProcessExitInfo): void => {
      processExited = true;
      if (spawnGeneration !== this.generation && this.stoppingProcessId !== info.id) return;
      try {
        if (this.stoppingProcessId === info.id) publishConfirmedCancellation();
      } finally { this.onChildExit(info); }
    };
    const startupTicket: V1StartupTicket | null = protocol === 'trylo-v1' ? { state: 'starting' } : null;
    this.pendingV1Start = startupTicket;
    this.bindingState = 'spawning';
    this.notify();
    try {
      if (protocol === 'trylo-v1') this.reportV1ProfileUnavailable(request, onRunEvents, now);
      if (protocol === 'trylo-v1' && guard.isSuperseded()) return;
      const { processId } = protocol === 'trylo-v1'
        ? await startTryloV1({
            onSpawn: (handle) => {
              const ownsCancelledStartup = this.pendingV1Start === startupTicket && startupTicket?.state === 'cancelled';
              if (spawnGeneration !== this.generation && !ownsCancelledStartup) return;
              this.processId = handle.id;
              this.pid = handle.pid;
              this.ownedFingerprint = fingerprint;
              this.ownedProtocol = protocol;
              if (startupTicket?.state === 'cancelled') this.stoppingProcessId = handle.id;
              this.notify();
            },
            prompt: request.prompt,
            cliPath: request.settings.cliPath,
            ...(request.settings.cliNodeProgram
              ? { nodeProgram: request.settings.cliNodeProgram }
              : {}),
            cwd: request.settings.cwd,
            // P08 §6.2: first v1 turn creates a session, later turns
            // resume it. Ephemeral until then.
            binding: pendingBinding,
            onBindingChange: (binding) => {
              // `unknown` is resolved by a probe outside this controller;
              // we only record what the runner learned.
              if (spawnGeneration === this.generation) this.setCliSession(binding);
            },
            // Replayed only while there is no CLI-owned session (§6.1).
            priorMessages: request.priorMessages,
            // Connection argv excludes credentials; an explicit builtin key
            // travels only through the ephemeral child environment.
            ...providerArgs,
            ...(request.settings.reasoningEffort === undefined ? {} : { reasoningEffort: request.settings.reasoningEffort }),
            ...(connection.contextTokenLimit === undefined ? {} : { contextTokenLimit: connection.contextTokenLimit }),
            ...(connection.modelContextWindow === undefined ? {} : { modelContextWindow: connection.modelContextWindow }),
            spawnEnv: v1SpawnEnv,
            systemPrompt: request.settings.systemPrompt,
            teamMode: request.teamMode,
            ...(request.teamMode && request.teamRunId && request.turnId ? { recoveryIdentity: {
              teamRunId: request.teamRunId, turnId: request.turnId,
            } } : {}),
            permissionLevel: request.permissionLevel,
            // WP-CL / B: the CLI owns learning; the Desktop only forwards the
            // effective setting. Absent means "not enabled" and the argv stays
            // exactly what it was — never a hard-coded `--learning=all`.
            ...(request.settings.learning === undefined ? {} : { learning: request.settings.learning }),
            projectKey: this.projectKey,
            conversationId: this.conversationId,
            ...(this.runId ? { runId: this.runId } : {}),
            guard,
            onEvents: onRunEvents,
            onControlFrame: (frame, processId) => {
              if (spawnGeneration !== this.generation) return;
              if (this.inputRequests.handle(frame, processId, onRunEvents)) return;
              this.permissions?.handleControlFrame(frame, {
                processId, projectKey: this.projectKey, conversationId: this.conversationId,
                ...classifierScope,
              });
            },
            onExit: onRunExit,
          })
        : await startTrylo({
        prompt: request.prompt,
        cliPath: request.settings.cliPath,
        nodeProgram: request.settings.cliNodeProgram,
        cwd: request.settings.cwd,
        apiKey: connection.apiKey,
        apiHost: connection.apiHost,
        apiModel: connection.apiModel,
        apiFormat: connection.apiFormat,
        apiKeyHeader: connection.apiKeyHeader,
        apiKeyPrefix: connection.apiKeyPrefix,
        extraHeadersText: connection.extraHeadersText,
        systemPrompt: request.settings.systemPrompt,
        codeMode: request.codeMode,
        // P2: the snapshotted level travels with the request, NOT
        // via a mutable global. A mid-run picker change cannot
        // reach this controller for the in-flight run.
        permissionLevel: request.permissionLevel,
        extraCliArgs: request.toolRuntime
          ? [...request.toolRuntime.cliArgs]
          : request.extraCliArgs,
        // §4.2: Profile env plus TRYLO_TEAM_SURFACE on Work, even when
        // the Profile failed — otherwise the child loads the Code roster.
        // teamMode (spawn_team on Code) adds TRYLO_TEAM_MODE.
        spawnEnv: effectiveSpawnEnv(request.surface, request.toolRuntime, request.teamMode),
        priorMessages: request.priorMessages,
        runId: this.runId,
        guard,
        projectKey: this.projectKey,
        conversationId: this.conversationId,
        onEvents: onRunEvents,
        onControlFrame: (frame) => {
          if (spawnGeneration !== this.generation) return;
          const processId = this.processId;
          if (!processId || !this.permissions) return;
          this.permissions.handleControlFrame(frame, {
            processId,
            projectKey: this.projectKey,
            conversationId: this.conversationId,
            ...classifierScope,
          });
        },
        onExit: onRunExit,
      });
      if (spawnGeneration !== this.generation) {
        if (processExited) return;
        // Superseded while spawning — stop the orphan we created.
        if (protocol === 'trylo-v1') await stopTryloV1(processId);
        else await stopTryloProcess(processId).catch(() => { /* already gone */ });
        return;
      }
      if (protocol === 'legacy-stream-json' && (this.bindingState as CodeRunBindingState) === 'exited') {
        await stopTryloProcess(processId).catch(() => {});
        return;
      }
      this.processId = processId;
      this.ownedFingerprint = fingerprint;
      // P08 §4.1: remember which contract this process speaks so `stop`
      // can mark a one-shot run cancelled instead of just killing it.
      this.ownedProtocol = protocol;
      this.bindingState = 'busy';
      this.notify();
      this.diag('cold.spawn');
    } catch (error) {
      if (startupTicket?.state === 'cancelled' && this.processId && this.stoppingProcessId === this.processId) {
        this.retainUnconfirmedProcess(this.processId);
        throw error;
      }
      if (spawnGeneration !== this.generation) return;
      if (protocol === 'trylo-v1' && this.processId) {
        // An acquired root survives an uncertain prompt/cleanup failure.
        // Only Stop or its real exit can release it for another dispatch.
        this.retainUnconfirmedProcess(this.processId);
        throw error;
      }
      this.failStartup(scope, error);
      throw error;
    } finally {
      if (startupTicket && this.pendingV1Start === startupTicket) {
        try {
          if (startupTicket.state === 'cancelled' && this.processId === null) {
            try { publishConfirmedCancellation(); }
            finally { this.releaseStoppedProcess(null); }
          }
        } finally {
          this.pendingV1Start = null;
          this.notify();
        }
      }
    }
  }

  private retainUnconfirmedProcess(processId: string): void {
    this.processId = processId;
    this.stoppingProcessId = processId;
    this.busy = true;
    this.error = true;
    this.bindingState = 'busy';
    this.diag('process.stop.failed', { reasonCode: 'stop_unconfirmed' });
    this.notify();
  }

  private failStartup(scope: RuntimeResultScope, error: unknown): void {
    this.processId = null;
    this.pid = null;
    this.bindingState = 'exited';
    this.error = true;
    this.busy = false;
    const reason = error instanceof Error ? error.message : 'unknown';
    this.diag('terminal', { reasonCode: `cold_spawn_failed:${reason.slice(0, 64)}` });
    this.fireTerminal(scope, 'failed');
    this.runId = null;
    this.nativeTurnId = null;
    this.notify();
  }

  private setCliSession(binding: CliSessionBinding): void {
    this.cliSession = binding;
    if (this.sessionLease) void this.saveCliSession(binding);
  }

  private saveCliSession(binding: CliSessionBinding): Promise<void> {
    const lease = this.sessionLease;
    if (!lease) return Promise.resolve();
    const pending = this.sessionWrites.catch(() => undefined).then(() => lease.save(binding));
    this.sessionWrites = pending;
    // CLI output handlers are synchronous. Retain a failed save as a visible
    // warning and retry its current binding before allowing the next dispatch.
    void pending.catch(() => {
      this.error = true;
      try {
        this.turnSink?.([{ type: 'runtime_warning', seq: 0, ts: Date.now(),
          id: `${this.conversationId}:session-save`, code: 'session_metadata_write_failed',
          message: 'CLI 会话关联保存失败；下一次启动前会重试保存。',
        }]);
      } catch { /* A consumer exception must not create an unhandled rejection. */
      } finally { this.notify(); }
    });
    return pending;
  }

  /** Send a correction into the current live turn without creating a second
   * controller run or resetting result attribution. The stream-json runtime
   * treats an additional user frame as steering at its next safe boundary. */
  async steer(prompt: string): Promise<SteerDelivery> {
    const processId = this.processId;
    // V1 retains framed stdin for guidance until this one-shot turn exits.
    if (!supportsSteering(this.ownedProtocol)) return STEER_UNSUPPORTED;
    if (!this.busy || !processId || this.bindingState !== 'busy') return STEER_NOT_RUNNING;
    const sent = await sendPromptToProcess(processId, prompt);
    this.diag(sent ? 'prompt.write.accepted' : 'prompt.write.rejected', {
      reasonCode: 'steering',
    });
    return sent ? STEER_DELIVERED : { kind: 'write-failed' };
  }

  /**
   * Stop one child task (Team seat) without killing the parent turn.
   * `taskId` is the CLI task id or the Agent tool_use_id (seat.id).
   */
  async stopTask(taskId: string): Promise<boolean> {
    const processId = this.processId;
    if (!processId || (this.bindingState !== 'busy' && this.bindingState !== 'ready')) {
      return false;
    }
    if (this.ownedProtocol === 'trylo-v1') {
      try {
        await cancelSubagent(processId, taskId);
        return true;
      } catch {
        // A refused or missing receipt is a failed cancellation, never success.
        this.diag('prompt.write.rejected', { reasonCode: 'stop_task' });
        return false;
      }
    }
    const sent = await sendControlLineToProcess(processId, buildStopTaskRequest(taskId));
    this.diag(sent ? 'prompt.write.accepted' : 'prompt.write.rejected', {
      reasonCode: 'stop_task',
    });
    return sent;
  }

  /**
   * M4-C1: spawn an idle CLI for this conversation, ahead of
   * the first user send, so the Node/CLI cold-start is paid before
   * the user submits. No prompt is written — no model request, no
   * history. `onReady` records the structured `session_start` signal;
   * adoption does not wait for it. Safe to re-call while a process or another
   * prewarm is already live. A prewarm failure is swallowed — the
   * next `run()` falls through to a normal cold spawn.
   *
   * `options.toolRuntime` makes the prewarm Profile-aware (spec §9): a Work
   * prewarm carries `work.core.v1` so the first Work message does not pay
   * MCP connect + cold start at once, and a Code prewarm is never adopted by
   * a Work run (or vice versa) because their fingerprints differ.
   */
  async prewarm(
    settings: SettingsForCodeRun,
    options: {
      readonly onReady?: () => void;
      readonly permissionLevel?: PermissionLevel;
      readonly toolRuntime?: ResolvedToolRuntime | null;
      readonly surface?: ToolSurface;
    } = {},
  ): Promise<void> {
    const onReady = options.onReady;
    // P08 §3.3: prewarming means keeping an idle process alive and
    // adopting it later. trylo-v1 is one process per turn with EOF
    // semantics, so an idle v1 process could never be adopted. Skipping
    // here is not an optimisation — spawning one would create an
    // orphan the reaper has to clean up.
    if (settings.platformModel || !supportsPrewarm(settings.cliRuntimeProtocol ?? DEFAULT_CLI_RUNTIME_PROTOCOL)) return;
    if (this.processId || this.prewarmProcessId || this.prewarming) return;
    this.prewarming = true;
    this.prewarmReady = false;
    this.diag('prewarm.requested');
    const attempt = ++this.prewarmAttempt;
    let spawnedProcessId: string | null = null;
    let failedBeforeAdoption = false;
    // The idle process is spawned with THIS contract; only a run with the
    // same fingerprint may adopt it (spec §9).
    const runtime = options.toolRuntime ?? null;
    const spawnEnv = effectiveSpawnEnv(options.surface, runtime);
    const prewarmFingerprint = fingerprintForRun({
      cliRuntimeProtocol: settings.cliRuntimeProtocol ?? DEFAULT_CLI_RUNTIME_PROTOCOL,
      cliPath: settings.cliPath,
      cwd: settings.cwd,
      apiKey: settings.apiKey,
      apiHost: settings.apiHost,
      apiModel: settings.apiModel,
      apiFormat: settings.apiFormat,
      apiKeyHeader: settings.apiKeyHeader,
      apiKeyPrefix: settings.apiKeyPrefix,
      extraHeadersText: settings.extraHeadersText,
      systemPrompt: settings.systemPrompt,
      permissionLevel: options.permissionLevel ?? 'workspace_write',
      extraCliArgs: runtime ? [...runtime.cliArgs] : [],
      toolRuntime: runtime,
      spawnEnv,
    });
    try {
      // PR-2: same classifier-scope snapshot as a real run, from the
      // prewarm's OWN contract (§9: adoption is an exact fingerprint match,
      // so the scope the closure carries matches the adopting run).
      const prewarmToolRuntime = runtime;
      const prewarmClassifierScope = {
        projectRoot: settings.cwd,
        permissionLevel: options.permissionLevel ?? 'workspace_write',
        ...(prewarmToolRuntime?.profileId ? { profileId: prewarmToolRuntime.profileId } : {}),
        managedPackageIds: prewarmToolRuntime
          ? prewarmToolRuntime.packageHealth.filter((p) => p.available).map((p) => p.id)
          : [],
      };
      let toolProtocolChecked = false;
      const { processId } = await startTryloPrewarm({
        cliPath: settings.cliPath,
        nodeProgram: settings.cliNodeProgram,
        cwd: settings.cwd,
        apiKey: settings.apiKey,
        apiHost: settings.apiHost,
        apiModel: settings.apiModel,
        apiFormat: settings.apiFormat,
        apiKeyHeader: settings.apiKeyHeader,
        apiKeyPrefix: settings.apiKeyPrefix,
        extraHeadersText: settings.extraHeadersText,
        systemPrompt: settings.systemPrompt,
        codeMode: 'agent',
        permissionLevel: options.permissionLevel ?? 'workspace_write',
        extraCliArgs: runtime ? [...runtime.cliArgs] : undefined,
        spawnEnv,
        projectKey: this.projectKey,
        conversationId: this.conversationId,
        runId: `prewarm-${this.conversationId}`,
        onReady: () => {
          if (attempt !== this.prewarmAttempt) return;
          this.prewarmReady = true;
          onReady?.();
          this.notify();
        },
        onEvents: (events) => {
          // Adoption keeps this callback alive; discarded prewarms must not
          // clear a newer idle process or contribute its protocol events.
          if (attempt !== this.prewarmAttempt && (!spawnedProcessId || this.processId !== spawnedProcessId)) return;
          // PR-2: observe the tool list the idle CLI reports at init, even
          // before a turn adopts this process — the init frame arrives once
          // per process and would otherwise be dropped here.
          if (!toolProtocolChecked) {
            const init = events.find((e) => e.type === 'loop_start');
            if (init && init.type === 'loop_start') {
              toolProtocolChecked = true;
              this.reportToolProtocolDrift(init.tools, prewarmToolRuntime);
            }
          }
          if (events.some((event) => event.type === 'aborted') && (!spawnedProcessId || this.processId !== spawnedProcessId)) {
            failedBeforeAdoption = true;
            this.prewarmProcessId = null;
            this.prewarmFingerprint = null;
            this.prewarmReady = false;
            if (spawnedProcessId) void stopTryloProcess(spawnedProcessId).catch(() => {});
            this.notify();
            return;
          }
          // Route output only once this process has been adopted as
          // the current owned process. Idle prewarm frames (ready
          // / nothing) are dropped.
          if (spawnedProcessId && this.processId === spawnedProcessId) {
            this.handleTurnEvents(events);
          }
        },
        onControlFrame: (frame) => {
          if (!spawnedProcessId || !this.permissions) return;
          if (this.processId !== spawnedProcessId && this.prewarmProcessId !== spawnedProcessId) return;
          this.permissions.handleControlFrame(frame, {
            processId: spawnedProcessId,
            projectKey: this.projectKey,
            conversationId: this.conversationId,
            ...prewarmClassifierScope,
          });
        },
        onExit: (info) => {
          if (spawnedProcessId && this.processId === spawnedProcessId) {
            this.onChildExit(info);
          } else if (spawnedProcessId && this.prewarmProcessId === spawnedProcessId) {
            // Prewarm died before being adopted — drop the idle
            // runtime; the next turn cold-spawns.
            this.prewarmProcessId = null;
            this.prewarmFingerprint = null;
            this.prewarmReady = false;
            this.notify();
          }
        },
      });
      spawnedProcessId = processId;
      this.diag('prewarm.spawned');
      // A user run may have started while process_spawn was in flight. Never
      // publish that late prewarm beside the real runtime; stop the orphan.
      if (failedBeforeAdoption || attempt !== this.prewarmAttempt || this.busy || this.processId) {
        this.diag('prewarm.late_discarded', { reasonCode: 'superseded' });
        await stopTryloProcess(processId).catch(() => { /* already gone */ });
        return;
      }
      this.prewarmProcessId = processId;
      this.prewarmFingerprint = prewarmFingerprint;
      this.prewarmSpawnedAt = Date.now();
    } catch {
      // Prewarm failed; treat as unready so the next run cold-spawns.
      this.prewarmProcessId = null;
      this.prewarmFingerprint = null;
      this.prewarmReady = false;
      this.diag('prewarm.late_discarded', { reasonCode: 'spawn_failed' });
    } finally {
      this.prewarming = false;
    }
  }

  /** True while an idle prewarm is in flight or ready (for the
   *  Activity Center / status). */
  hasPrewarm(): { processId: string | null; ready: boolean } {
    return { processId: this.prewarmProcessId, ready: this.prewarmReady };
  }

  /** Shared output path for cold, adopted and warm legacy turns. The
   *  current sink and idle timestamp belong to the turn, not the spawn. */
  private handleTurnEvents(events: readonly LoopEvent[]): void {
    const scope = this.resultScope;
    if (scope && this.lifecycleObserver) {
      try {
        this.lifecycleObserver.onEvents(scope, events);
      } catch {
        /* non-fatal */
      }
    }
    this.maybeEmitFirstEvents(events);
    if (this.finishLegacyAbort(events)) {
      // The adopted idle process must not remain busy after a fatal abort.
    } else if (events.some((e) => e.type === 'loop_end' || e.type === 'session_end')) {
      this.busy = false;
      this.bindingState = 'idle';
      this.lastIdleAt = Date.now();
      this.notify();
      if (scope) this.fireTerminal(scope, outcomeFromEvents(events));
    }
    const sink = this.turnSink;
    if (sink) sink(events);
  }

  private finishLegacyAbort(events: readonly LoopEvent[]): boolean {
    const aborted = events.find((event) => event.type === 'aborted');
    if (!aborted || aborted.type !== 'aborted') return false;
    const processId = this.processId;
    this.processId = null;
    this.pid = null;
    this.ownedFingerprint = null;
    this.busy = false;
    this.error = aborted.reason !== 'user';
    this.bindingState = 'exited';
    const scope = this.resultScope;
    if (scope) this.fireTerminal(scope, this.error ? 'failed' : 'cancelled');
    if (processId) void stopTryloProcess(processId).catch(() => {});
    this.notify();
    return true;
  }

  /** P2-1 (spec §7.2): fire the exactly-once terminal notification for the
   *  active result scope. Clears the scope so a duplicate loop_end /
   *  session_end / exit / stop cannot re-finalize or re-save. */
  private fireTerminal(scope: RuntimeResultScope, outcome: CodeRunOutcome): void {
    if (this.resultScope !== scope) return;
    this.resultScope = null;
    this.diag('terminal', { reasonCode: outcome });
    const observer = this.lifecycleObserver;
    if (!observer) return;
    Promise.resolve(observer.onRunTerminal(scope, outcome)).catch(() => {
      /* non-fatal */
    });
  }

  /**
   * M4-C1 idle reclaim (spec §5.5 / §7.1): end THIS controller's
   * runtime if it has been idle >= `ttlMs`. Never touches a busy /
   * spawning runtime. Two cases:
   *   - an UN-ADOPTED prewarm (spawned but no turn adopted it yet);
   *   - an ADOPTED idle CLI sitting after loop_end.
   * Returns true when a runtime was reclaimed. The reaper only ever
   * calls this — busy runtimes are never reclaimed.
   */
  async reapIdleRuntime(ttlMs: number, now = Date.now()): Promise<boolean> {
    if (
      this.busy ||
      this.bindingState === 'busy' ||
      this.bindingState === 'spawning'
    ) {
      return false;
    }
    if (this.prewarmProcessId) {
      if (now - this.prewarmSpawnedAt < ttlMs) return false;
      const pid = this.prewarmProcessId;
      this.prewarmProcessId = null;
      this.prewarmFingerprint = null;
      this.prewarmReady = false;
      this.prewarmSpawnedAt = 0;
      this.prewarmAttempt += 1;
      await stopTryloProcess(pid).catch(() => { /* already gone */ });
      this.notify();
      return true;
    }
    if (this.processId && this.bindingState === 'idle') {
      if (now - this.lastIdleAt < ttlMs) return false;
      await this.stop();
      return true;
    }
    return false;
  }

  /** Stop THIS conversation's run and terminate its CLI. */
  async stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    const operation = this.stopOwnedProcess();
    this.stopOperation = operation;
    try { await operation; }
    finally { if (this.stopOperation === operation) this.stopOperation = null; }
  }

  private async stopOwnedProcess(): Promise<void> {
    if (this.processId) this.inputRequests.clearProcess(this.processId);
    // A forced one-shot stop cannot release or seal the CLI-owned journal.
    // Continue later in a fresh CLI session, using the visible chat as context;
    // never remove the CLI's lock or pretend its interrupted turn is resumable.
    if ((this.ownedProtocol === 'trylo-v1' || this.pendingV1Start) && this.busy) this.setCliSession({ state: 'none' });
    const processId = this.processId ?? this.prewarmProcessId;
    const protocol = this.processId ? this.ownedProtocol : 'legacy-stream-json';
    const stopGeneration = ++this.generation;
    if (this.pendingV1Start) this.pendingV1Start.state = 'cancelled';
    this.stoppingProcessId = processId;
    this.prewarmProcessId = null;
    this.prewarmFingerprint = null;
    this.prewarmReady = false;
    this.prewarmAttempt += 1;
    if (!processId && this.pendingV1Start) {
      this.busy = true;
      this.error = true;
      this.bindingState = 'spawning';
      this.notify();
      throw new Error('原生启动回执尚未返回，已请求取消；收到回执后会停止原进程，请稍后重试停止。');
    }
    if (processId) {
      // Keep the owner and block replacement until stop succeeds or an exit
      // receipt arrives. A failed native command is not proof of cancellation.
      this.processId = processId;
      this.permissions?.clearProcess(processId);
      this.busy = true;
      this.bindingState = 'busy';
      this.notify();
      const stop = protocol === 'trylo-v1' ? stopTryloV1 : stopTryloProcess;
      try { await stop(processId); }
      catch (error) {
        if (this.processId !== processId) return; // Exit independently confirmed.
        this.retainUnconfirmedProcess(processId);
        throw error;
      }
      if (this.processId !== processId || this.generation !== stopGeneration) return;
    }
    this.releaseStoppedProcess(processId);
  }

  private releaseStoppedProcess(processId: string | null): void {
    this.fireTerminalForActive('cancelled');
    this.stoppingProcessId = null;
    this.busy = false;
    this.turnSink = null;
    this.processId = null;
    this.ownedFingerprint = null;
    this.pid = null;
    this.bindingState = 'exited';
    this.runId = null;
    this.nativeTurnId = null;
    this.error = false;
    if (processId) { this.permissions?.clearProcess(processId); this.inputRequests.clearProcess(processId); }
    this.notify();
  }

  /** Compaction can reopen only this controller's established, idle session. */
  canCompact(): boolean {
    return !this.busy && this.compactRequest !== null && (this.compactRequest.settings.cliRuntimeProtocol === 'trylo-v1'
      ? this.cliSession.state === 'established' && this.processId === null : this.processId !== null && this.bindingState === 'idle');
  }

  async compact(): Promise<boolean> {
    if (!this.canCompact() || !this.compactRequest) return false;
    try {
      await this.run({ ...this.compactRequest, prompt: '/compact' });
      return true;
    } catch { return false; } // run() owns the scoped, visible startup failure.
  }

  /** Tear down this controller's handles without stopping the
   *  child process (workspace close / conversation delete). */
  dispose(): void {
    this.pendingV1Start = null;
    this.compactRequest = null;
    // P2-1: a disposed mid-run conversation must not stay `collecting`
    // forever — cancel its projection (spec §6.5). No-op when already final.
    this.fireTerminalForActive('cancelled');
    this.generation += 1;
    this.busy = false;
    this.turnSink = null;
    this.prewarmProcessId = null;
    this.prewarmFingerprint = null;
    this.prewarmReady = false;
    this.prewarmAttempt += 1;
    this.processId = null;
    this.ownedFingerprint = null;
    this.pid = null;
    this.bindingState = 'exited';
    this.runId = null;
    this.nativeTurnId = null;
  }

  private onChildExit(info: ProcessExitInfo): void {
    if (this.processId) this.inputRequests.clearProcess(this.processId);
    // Process exit always lands here, both for cold spawns and for
    // prewarms that have been adopted. We log it (no prompt text,
    // no signal name) so the diagnostic chain is complete.
    this.diag('process.exit', {
      ...(info.code !== null ? { exitCode: info.code } : {}),
      ...(info.signal !== null ? { signal: info.signal } : {}),
    });
    const stopped = this.stoppingProcessId === info.id;
    const crashedWhileBusy = this.busy && this.bindingState !== 'idle' && !stopped;
    // P2-1: a process that died on its own is a terminal outcome; if it was
    // already final (idle after loop_end) the guard makes this a no-op.
    this.fireTerminalForActive(stopped ? 'cancelled' : 'exited');
    this.generation += 1;
    const deadProcessId = this.processId;
    this.processId = null;
    this.stoppingProcessId = null;
    this.ownedFingerprint = null;
    this.pid = null;
    this.bindingState = 'exited';
    this.runId = null;
    this.nativeTurnId = null;
    this.busy = false;
    if (deadProcessId) { this.permissions?.clearProcess(deadProcessId); this.inputRequests.clearProcess(deadProcessId); }
    if (crashedWhileBusy) {
      this.error = true;
    } else if (stopped) this.error = false;
    this.notify();
  }

  private fireTerminalForActive(outcome: CodeRunOutcome): void {
    if (this.resultScope) {
      this.fireTerminal(this.resultScope, outcome);
    }
  }

  /** P2-1 (spec §7.2, audit P1-1): establish the Run-start projection state
   *  with a bounded budget. On timeout or error we proceed anyway — result
   *  projection is additive, never a gate on the Agent run. */
  private async captureBaseline(scope: RuntimeResultScope): Promise<void> {
    const observer = this.lifecycleObserver;
    if (!observer) return;
    try {
      await Promise.race([
        Promise.resolve(observer.onRunStarted(scope)),
        new Promise<void>((resolve) => {
          setTimeout(resolve, BASELINE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      /* non-fatal: a failed baseline degrades the projection, not the run */
    }
  }

  private notify(): void {
    this.onChange();
  }
}

/** Map a terminal batch of loop events to a result outcome (spec §7.2).
 *  Assistant text is never used — only the structured event fields. */
function outcomeFromEvents(events: readonly LoopEvent[]): CodeRunOutcome {
  for (const e of events) {
    if (e.type === 'session_end') {
      if (e.reason === 'abort') return 'cancelled';
      if (e.reason === 'error') return 'failed';
      return 'completed';
    }
    if (e.type === 'loop_end') {
      return e.isError ? 'failed' : 'completed';
    }
    if (e.type === 'aborted') return 'cancelled';
  }
  return 'completed';
}
