// Trylo Desktop — Companion controller (migration spec §6.3 / §6.4 / §6.5).
//
// Lifecycle wiring that turns the Desktop into the pet's owner:
//   - starts/stops the ServiceManager + CompanionPort (Windows only);
//   - taps Code run lifecycle + Work item flow → companion projection →
//     pet.publish;
//   - merges Code + Work pending permissions into one
//     permissionRequestState (requestIds always carried by the request
//     itself — dual-workspace safe, spec §6.3);
//   - answers host.permissionDecision through the ApprovalService;
//   - drives pet chat via pet.chatHandle with the per-request chat config
//     derived from the Desktop settings (spec §6.4);
//   - re-enables the pet after a sidecar restart (hello + heartbeat
//     reconnect; the WPF mutex prevents duplicate exes, §6.5).
//
// Framework-free: App only constructs it and flips setEnabled.

import type { ConversationItem } from '@trylo/work';

import { ApprovalService, type WorkApprovalAuthority } from '../approval/approval-service';
import type { CodeRunLifecycleObserver, CodeRunOutcome } from '../runtime/code-run-lifecycle';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import type { TryloSettings } from '../settings/settings-store';
import type { ServiceManager } from '../services-host/service-manager';
import type {
  ChatClientConfig,
  PetChatRequestMessage,
  PetStatusSnapshot,
} from '../services-host/methods';
import type { CompanionPublishPayload, PetPermissionRequest, ServicesCompanionPort } from './companion-port';
import { EMPTY_PET_STATUS, normalizePetStatus } from './companion-port';
import {
  AGENT_STATES,
  permissionRequestStatePayload,
  projectCodeBindingState,
  projectCodeOutcome,
  projectLoopEventDetail,
  projectLoopEventToState,
  projectToolUseToState,
  workApprovalToPetRequest,
} from './companion-projection';

/** Desktop settings → pet chat LLM config. Field-for-field mirror of the
 *  legacy readConfig surface (spec §6.4: 配置来源改为 Desktop settings). */
function isDesktopForeground(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    // Pet should only handle approvals when desktop is minimized/hidden/background.
    // When desktop is visible and focused, desktop's ApprovalCard is the authority.
    return document.visibilityState === 'visible' && document.hasFocus() && !document.hidden;
  } catch {
    return false;
  }
}

export function chatConfigFromSettings(settings: TryloSettings): ChatClientConfig {
  return {
    endpoint: settings.apiHost,
    apiKey: settings.apiKey || undefined,
    apiKeyHeader: settings.apiKeyHeader || undefined,
    apiKeyPrefix: settings.apiKeyPrefix || undefined,
    apiFormat: settings.apiFormat,
    model: settings.apiModel || undefined,
    systemPrompt: settings.systemPrompt || undefined,
    extraHeadersText: settings.extraHeadersText || undefined,
  };
}

/** Chain two lifecycle observers (result projection + companion tap). */
export function composeLifecycleObservers(
  first: CodeRunLifecycleObserver,
  second: CodeRunLifecycleObserver,
): CodeRunLifecycleObserver {
  return {
    async onRunStarted(scope) {
      await first.onRunStarted(scope);
      await second.onRunStarted(scope);
    },
    onEvents(scope, events) {
      first.onEvents(scope, events);
      second.onEvents(scope, events);
    },
    async onRunTerminal(scope, outcome) {
      await first.onRunTerminal(scope, outcome);
      await second.onRunTerminal(scope, outcome);
    },
  };
}

export interface CompanionControllerOptions {
  readonly manager: ServiceManager;
  readonly port: ServicesCompanionPort;
  readonly supervisor: ConversationRunSupervisor;
  readonly settings: () => TryloSettings;
  /** Legacy hook: resolved the workd runtime for approval.respond.
   *  2026-09-04 (CLI 单核): the workd daemon is retired, so Work approvals
   *  never pend here anymore — the option is kept optional for compat. */
  readonly workRuntime?: () => { respondApproval(approvalId: string, approved: boolean): Promise<void> } | null;
  readonly isWindows?: () => boolean;
}

export class CompanionController {
  private readonly manager: ServiceManager;
  private readonly port: ServicesCompanionPort;
  private readonly supervisor: ConversationRunSupervisor;
  private readonly settingsFn: () => TryloSettings;
  private readonly workRuntimeFn: NonNullable<CompanionControllerOptions['workRuntime']>;
  private readonly isWindows: () => boolean;

  private readonly disposers: (() => void)[] = [];
  private readonly pendingWorkApprovals = new Map<string, PetPermissionRequest>();
  /** Whether a Work-surface task is currently running (tool item live,
   *  not yet terminated by final/error/cancelled). Code runs are counted
   *  from the supervisor; this covers the Work side. */
  private workActive = false;
  private lastPublishedState = '';
  private lastPublishedPermissionKey = '';
  private started = false;
  private channelEnabled = false;
  private startupInFlight = false;
  private lifecycleGeneration = 0;
  private needsChannelReenable = false;
  private disposed = false;
  // Real pet status (audit §4.2 PET-P0-1): projected to the UI so a failed
  // launch is visible instead of silent.
  private petStatusValue: PetStatusSnapshot = EMPTY_PET_STATUS;
  private readonly statusListeners = new Set<(status: PetStatusSnapshot) => void>();

  readonly approvals: ApprovalService;

  constructor(options: CompanionControllerOptions) {
    this.manager = options.manager;
    this.port = options.port;
    this.supervisor = options.supervisor;
    this.settingsFn = options.settings;
    this.workRuntimeFn = options.workRuntime ?? (() => null);
    this.isWindows = options.isWindows ?? (() => /win/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : ''));

    const workAuthority: WorkApprovalAuthority = {
      isPending: (approvalId) => this.pendingWorkApprovals.has(approvalId),
      respond: async (approvalId, approved) => {
        const runtime = this.workRuntimeFn();
        if (!runtime) throw new Error('Work runtime is not available');
        await runtime.respondApproval(approvalId, approved);
      },
    };
    this.approvals = new ApprovalService({
      work: workAuthority,
      code: {
        isPending: (requestId) =>
          this.supervisor.pendingCodePermissions().some((r) => r.requestId === requestId),
        respond: (requestId, allow) => this.supervisor.respondCodePermission(requestId, allow),
      },
      onUnrouted: ({ requestId, decision }) => {
        // Observability only (spec §11): no chat/permission bodies.
        console.warn(`[companion] unrouted permission decision id=${requestId.slice(0, 24)} decision=${decision}`);
      },
    });
  }

  /** The companion-side Code lifecycle tap — App composes it behind the
   *  result projector (composeLifecycleObservers). */
  readonly lifecycle: CodeRunLifecycleObserver = {
    onRunStarted: () => {
      this.publishState(AGENT_STATES.planning, 'Starting the run');
      return Promise.resolve();
    },
    onEvents: (_scope, events: readonly LoopEvent[]) => {
      for (const event of events) {
        const state = projectLoopEventToState(event);
        if (state) {
          // Detail = what the run is doing right now (file name, command).
          // The pet bubble shows it as the running task; publishState
          // dedupes on state+detail so a new file re-publishes.
          this.publishState(state, projectLoopEventDetail(event) ?? '');
        }
      }
    },
    onRunTerminal: (_scope, outcome: CodeRunOutcome) => {
      this.publish(projectCodeOutcome(outcome));
    },
  };

  /** Work item tap — App forwards every accepted ConversationItem. */
  onWorkItem(item: ConversationItem): void {
    if (item.kind === 'approval') {
      const request = workApprovalToPetRequest(item);
      if (request) {
        this.pendingWorkApprovals.set(request.requestId, request);
        this.publishState(AGENT_STATES.stalled, request.title);
      } else {
        this.pendingWorkApprovals.delete(item.approvalId);
      }
      this.publishPermissions();
      return;
    }
    if (item.kind === 'tool') {
      if (item.status === 'running') {
        this.workActive = true;
        // summary carries the file/command the Work seat is on right now —
        // the pet bubble shows it as the running task.
        this.publishState(projectToolUseToState(item.tool), item.summary ?? '');
      }
      return;
    }
    if (item.kind === 'final') {
      this.workActive = false;
      this.publish({ type: 'assistant' });
      return;
    }
    if (item.kind === 'error') {
      this.workActive = false;
      this.publish({ type: 'error', message: 'Work run failed' });
      return;
    }
    if (item.kind === 'cancelled') {
      this.workActive = false;
      this.publish({ type: 'stopped' });
    }
  }

  /** Settings switch (§6.5). Non-Windows is a no-op that reports status. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return;
    if (!enabled || !this.isWindows()) {
      this.lifecycleGeneration += 1;
      // The Service Host is shared by pet + Hermes (and later Remote).
      // Disabling one domain must not tear down the process for the others.
      await this.shutdown(false);
      return;
    }
    if (this.started) return;
    const generation = ++this.lifecycleGeneration;
    await this.startup(generation);
  }

  /** App exit path (§6.5): pet.disable → servicehost_stop. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifecycleGeneration += 1;
    await this.shutdown(true);
  }

  /** Subscribe to pet status changes (audit §4.2 PET-P0-1). Returns an
   *  unsubscribe; the current value is delivered immediately. */
  onStatus(listener: (status: PetStatusSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.petStatusValue);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** The last known real status — never `undefined`. */
  petStatus(): PetStatusSnapshot {
    return this.petStatusValue;
  }

  /** Re-query the sidecar and republish. Cheap and side-effect free; safe
   *  for the UI to call after an "open pet" attempt that showed nothing. */
  async refreshStatus(): Promise<PetStatusSnapshot> {
    if (!this.started) {
      this.setPetStatus(EMPTY_PET_STATUS);
      return this.petStatusValue;
    }
    try {
      this.setPetStatus(normalizePetStatus(await this.port.status()));
    } catch {
      // A dead sidecar is not a UI error; the status just stays stale and
      // the service-host health chip tells the rest of the story.
    }
    return this.petStatusValue;
  }

  private setPetStatus(next: PetStatusSnapshot): void {
    const previous = this.petStatusValue;
    const unchanged =
      previous.enabled === next.enabled &&
      previous.exeFound === next.exeFound &&
      previous.launched === next.launched &&
      previous.chatConnected === next.chatConnected &&
      previous.exePath === next.exePath &&
      previous.reasonCode === next.reasonCode;
    if (unchanged) return;
    this.petStatusValue = next;
    for (const listener of [...this.statusListeners]) listener(next);
  }

  private async startup(generation: number): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startupInFlight = true;
    this.watchSupervisor();
    const client = this.manager.client;
    this.disposers.push(
      // S→D status push: the sidecar emits on every bind/enable/disable.
      client.onEvent('pet.status', (payload: PetStatusSnapshot) => {
        this.setPetStatus(normalizePetStatus(payload));
      }),
      client.onEvent('host.permissionDecision', (payload) => {
        void this.approvals.decide(payload.requestId, payload.decision).catch(() => {});
      }),
      client.onEvent('host.petChat', (message: PetChatRequestMessage) => {
        // Config is injected per request; the sidecar stores no keys.
        void this.port.chatHandle(message, chatConfigFromSettings(this.settingsFn())).catch(() => {});
      }),
      this.manager.onHealth((health) => {
        if (health === 'ready') {
          this.publishState(AGENT_STATES.idle, 'Ready');
          // Initial ready arrives while port.start() is still awaiting spawn;
          // that path sends pet.enable itself. Only a later host generation
          // needs an explicit domain rebind.
          if (!this.startupInFlight && this.needsChannelReenable) {
            this.needsChannelReenable = false;
            const reenableGeneration = this.lifecycleGeneration;
            void this.port
              .enableChannel()
              .then(async (status) => {
                if (this.disposed || !this.started || reenableGeneration !== this.lifecycleGeneration) {
                  await this.port.stop().catch(() => {});
                  this.channelEnabled = false;
                  return;
                }
                this.channelEnabled = true;
                this.setPetStatus(normalizePetStatus(status));
              })
              .catch((error: unknown) => {
                this.channelEnabled = false;
                this.needsChannelReenable = true;
                this.setPetStatus(EMPTY_PET_STATUS);
                console.warn('[companion] failed to re-enable after service host restart', error);
              });
          }
          return;
        }
        // Every non-ready state (stopped / starting / restarting / down)
        // invalidates the previous generation's launch facts: a status that
        // still says `launched:true` after the host died is a lie the UI
        // would happily show (audit §4.2 PET-P0-1).
        this.setPetStatus(EMPTY_PET_STATUS);
        this.channelEnabled = false;
        if (health === 'restarting' || health === 'down') {
          this.needsChannelReenable = true;
        }
      }),
      this.manager.onDown(() => {
        // Degradation: Code/Work keep working without the pet (§5.1).
        // Status goes back to "nothing launched" — the host is gone, so
        // `launched`/`chatConnected` from the old generation are lies.
        this.setPetStatus(EMPTY_PET_STATUS);
        console.warn('[companion] service host down — pet disabled until restart');
      }),
    );
    try {
      // `start()` now RETURNS the real post-enable status (PET-P0-1).
      const status = normalizePetStatus(await this.port.start());
      this.channelEnabled = true;
      // Settings may have changed while path resolution / host readiness was
      // in flight. Do not let an obsolete startup resurrect the pet.
      if (this.disposed || generation !== this.lifecycleGeneration) {
        await this.port.stop().catch(() => {});
        this.channelEnabled = false;
        return;
      }
      this.setPetStatus(status);
      this.needsChannelReenable = false;
      if (!this.petStatusValue.launched && this.petStatusValue.reasonCode) {
        // Observability only: the reason code, never a private path.
        console.warn(`[companion] pet not launched reason=${this.petStatusValue.reasonCode}`);
      }
    } catch (err) {
      if (generation !== this.lifecycleGeneration) return;
      console.warn('[companion] failed to start the pet channel', err);
      this.started = false;
      this.channelEnabled = false;
      this.setPetStatus(EMPTY_PET_STATUS);
      // Startup is transactional. A retry must not accumulate supervisor,
      // event, or health listeners from the failed attempt.
      for (const dispose of this.disposers.splice(0)) dispose();
    } finally {
      if (generation === this.lifecycleGeneration) this.startupInFlight = false;
    }
  }

  private async shutdown(stopManager: boolean): Promise<void> {
    if (this.channelEnabled) {
      await this.port.stop().catch(() => {});
    }
    this.started = false;
    this.channelEnabled = false;
    this.startupInFlight = false;
    this.needsChannelReenable = false;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.pendingWorkApprovals.clear();
    this.lastPublishedState = '';
    this.lastPublishedPermissionKey = '';
    this.setPetStatus(EMPTY_PET_STATUS);
    if (stopManager) await this.manager.stop().catch(() => {});
  }

  /** Supervisor subscription (wired once by `watchSupervisor`, called by
   *  startup) keeps binding-state + Code permission changes flowing. */
  private watchSupervisor(): void {
    this.disposers.push(
      this.supervisor.subscribe(() => {
        // Several conversations may run at once. Publish ONE coarse state —
        // a busy run wins over a spawning one, which wins over idle; loop
        // events refine the detail, and publishState adds the light "+N"
        // suffix for the sibling tasks.
        const runs = this.supervisor.activeCodeRuns();
        const primary =
          runs.find((r) => r.bindingState === 'busy') ??
          runs.find((r) => r.bindingState === 'spawning') ??
          runs[0];
        if (primary) {
          this.publishState(projectCodeBindingState(primary.bindingState));
        }
        this.publishPermissions();
      }),
    );
    // When desktop becomes visible/foreground, suppress pet approvals (desktop handles them);
    // when desktop goes background/minimized, republish pending to pet.
    try {
      const onVis = (): void => this.publishPermissions();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVis);
        this.disposers.push(() => document.removeEventListener('visibilitychange', onVis));
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', onVis);
        window.addEventListener('blur', onVis);
        this.disposers.push(() => window.removeEventListener('focus', onVis));
        this.disposers.push(() => window.removeEventListener('blur', onVis));
      }
    } catch {
      // never block companion startup
    }
  }

  private publishState(state: string, detail = ''): void {
    // Dedupe: the bridge turns every agentState publish into a UDP state
    // frame, so repeated identical states are suppressed. The key includes
    // detail — two consecutive file edits share the same state
    // (writing_files) but the bubble must follow the file name.
    // Multi-task: while more than one task is running, append a trailing
    // "  +N" sibling suffix (N = other tasks). The pet protocol has no count
    // field; the WPF parses this suffix into a dim "+N" hint, and an older
    // pet just renders the text as-is.
    let effectiveDetail = detail;
    if (CompanionController.isWorkingPetState(state)) {
      const total = this.activeTaskCount();
      if (total > 1) effectiveDetail = `${detail}  +${total - 1}`;
    }
    const key = `${state} ${effectiveDetail}`;
    if (key === this.lastPublishedState) return;
    this.lastPublishedState = key;
    void this.port.publish({ type: 'agentState', state, detail: effectiveDetail, level: 'info', meta: {} }).catch(() => {});
  }

  /** Total tasks currently in flight across BOTH surfaces: Code runs that
   *  are spawning/busy (from the supervisor) plus a live Work run. The pet
   *  shows the most active one and a light "+N" hint for the rest. */
  private activeTaskCount(): number {
    let count = 0;
    for (const run of this.supervisor.activeCodeRuns()) {
      if (run.bindingState === 'busy' || run.bindingState === 'spawning') count += 1;
    }
    if (this.workActive) count += 1;
    return count;
  }

  private static isWorkingPetState(state: string): boolean {
    return (
      state === AGENT_STATES.thinking ||
      state === AGENT_STATES.planning ||
      state === AGENT_STATES.writingFiles ||
      state === AGENT_STATES.runningCommand ||
      state === AGENT_STATES.waitingOutput ||
      state === AGENT_STATES.programRunning
    );
  }

  private publish(payload: CompanionPublishPayload): void {
    void this.port.publish(payload).catch(() => {});
  }

  private publishPermissions(): void {
    const requests: PetPermissionRequest[] = [...this.pendingWorkApprovals.values()];
    for (const pending of this.supervisor.pendingCodePermissions()) {
      if (requests.some((r) => r.requestId === pending.requestId)) continue;
      requests.push({
        requestId: pending.requestId,
        title: pending.title || pending.toolName,
        detail: pending.toolName,
        description: pending.title || pending.toolName,
        category: 'edit',
        approvalState: 'pending',
      });
    }
    // Desktop is the primary approval surface when visible. Suppress pet popup
    // in that case to avoid duplicate approvals and the "only pet works" bug.
    // When desktop is minimized/hidden/background, pet becomes the fallback.
    const desktopForeground = isDesktopForeground();
    const effectiveRequests = desktopForeground ? [] : requests;
    // Use a key that includes foreground state so a visibility change that
    // hides/shows approvals is not deduped away.
    const key = `${desktopForeground ? 'fg:' : 'bg:'}${requests.map((r) => r.requestId).join(',')}`;
    if (key === this.lastPublishedPermissionKey) return;
    this.lastPublishedPermissionKey = key;
    this.publish(permissionRequestStatePayload(effectiveRequests));
    if (effectiveRequests.length > 0) {
      this.publishState(AGENT_STATES.stalled, effectiveRequests[0]?.title ?? '');
    } else if (this.lastPublishedState === AGENT_STATES.stalled) {
      this.publishState(AGENT_STATES.idle, 'Ready');
    }
  }
}
