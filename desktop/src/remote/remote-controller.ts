// Trylo Desktop — Remote controller (migration spec §8.1 / §8.2, arch §7.2/§7.3).
//
// Lifecycle wiring that turns the Desktop into the remote gateway's owner:
// starts/stops the sidecar gateway, routes host.remoteRequest through
// RemoteRouter (Desktop-owned authorities), taps Code/Work into the remote
// projection → publish, re-enables after Service Host restarts, and degrades
// when the host is down (§5.1). Framework-free.

import type { ConversationItem } from '@trylo/work';

import type { ApprovalService } from '../approval/approval-service';
import type { PetChatHandle, PetPermissionRequest } from '../companion/companion-port';
import { workApprovalToPetRequest } from '../companion/companion-projection';
import type { ConversationKind, PersistedWorkspaceEntry, WorkspaceConversationHistory, WorkspaceIndex } from '../host-adapter/conversation-history';
import type { LoopEvent } from '../host-adapter/loop-events';
import type { CodeRunLifecycleObserver, CodeRunOutcome } from '../runtime/code-run-lifecycle';
import type { CodePermissionRequest } from '../runtime/code-permission-registry';
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import type { TryloSettings } from '../settings/settings-store';
import type { RemoteEnableParams, RemoteGatewayEvent, RemotePairingInfoResult, RemotePermissionRequestStateEvent, RemoteProjectSummary, RemoteSessionSummary, RemoteStatusResult } from '../services-host/methods';
import type { ServiceManager } from '../services-host/service-manager';
import { EMPTY_REMOTE_STATUS } from './remote-port';
import type { ServicesRemotePort } from './remote-port';
import { buildFullSnapshot, projectApprovals, projectBindingState, projectLoopEvents, projectTaskReceipt } from './remote-projection';
import { RemoteRouter } from './remote-routing';
import type { RemoteArtifactContent, RemoteArtifactSummary, RemoteTaskSurface } from './remote-routing';

/** Remote knobs App injects into TryloSettings (no `remote` group in the
 *  settings store yet — read defensively). */
interface RemoteSettingsLike {
  readonly port?: number;
  readonly tunnelMode?: 'named' | 'quick' | 'manual' | 'off';
  readonly publicUrl?: string;
  readonly cloudflaredPath?: string;
}

/** A projection may return one event or a batch; the gateway takes one event
 *  per `publish` call. */
function asEvents(value: RemoteGatewayEvent | readonly RemoteGatewayEvent[] | null | undefined): RemoteGatewayEvent[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Coerce projectApprovals output (null only at runtime) into a publishable
 *  permissionRequestState event. */
function asPermissionEvent(value: RemotePermissionRequestStateEvent | null | undefined): RemotePermissionRequestStateEvent {
  return value ?? { type: 'permissionRequestState', requests: [] };
}

export interface RemoteControllerOptions {
  readonly manager: ServiceManager;
  readonly port: ServicesRemotePort;
  readonly supervisor: ConversationRunSupervisor;
  readonly settings: () => TryloSettings;
  readonly paths: () => Promise<{ sidecarsDir: string; appDataDir: string }>;
  readonly isTauri: () => boolean;
  /** Handler authorities — Desktop owns every gateway handler (arch §7.2). */
  readonly workspaces: { list(): readonly RemoteProjectSummary[]; activeProjectId(): string; select(projectId: string): Promise<void> };
  readonly sessions: { list(): readonly RemoteSessionSummary[]; activeSessionId(): string; select(sessionId: string): Promise<{ switching: boolean }> };
  readonly sendTask: (req: { projectKey: string; conversationId: string; mode: string; surface: RemoteTaskSurface; text: string; requestId: string; attachments?: readonly import('./remote-routing').RemoteChatAttachment[] }) => Promise<unknown>;
  readonly cancelTask: (projectKey: string, conversationId: string) => Promise<void>;
  readonly approvals: ApprovalService;
  /** Read-only Work deliverables (`.trylo/out` of the active workspace). */
  readonly artifacts: {
    list(): Promise<readonly RemoteArtifactSummary[]>;
    read(relativePath: string): Promise<RemoteArtifactContent>;
  };
  /** Reuse pet-chat (spec §8.1: chat → §6.4 pet-chat). Null ⇒ chat unavailable. */
  readonly chatHandle: PetChatHandle | null;
  readonly history: () => WorkspaceConversationHistory | null;
  readonly workspaceIndex: () => WorkspaceIndex | null;
  readonly currentWorkspace: () => PersistedWorkspaceEntry | null;
  readonly conversationKind: () => ConversationKind;
  readonly codePermissions: () => readonly CodePermissionRequest[];
  readonly workApprovals: () => readonly PetPermissionRequest[];
  readonly projectKey: () => string;
  readonly conversationId: () => string;
  readonly mode: () => string;
}

export class RemoteController {
  private readonly options: RemoteControllerOptions;
  private readonly router: RemoteRouter;
  private readonly disposers: (() => void)[] = [];
  private readonly pendingWorkApprovals = new Map<string, PetPermissionRequest>();
  private readonly statusListeners = new Set<(status: RemoteStatusResult) => void>();
  private readonly thinkAccum = new Map<string, string>();
  private readonly textAccum = new Map<string, string>();
  private lastPublishedState = '';
  private lastPublishedPermissionKey = '';
  private remoteStatusValue: RemoteStatusResult = EMPTY_REMOTE_STATUS;
  private started = false;
  private channelEnabled = false;
  private startupInFlight = false;
  private lifecycleGeneration = 0;
  private needsReenable = false;
  private disposed = false;

  constructor(options: RemoteControllerOptions) {
    this.options = options;
    const o = options;
    this.router = new RemoteRouter({
      workspaces: o.workspaces,
      sessions: o.sessions,
      sendTask: o.sendTask,
      cancelTask: o.cancelTask,
      approvals: o.approvals,
      artifacts: o.artifacts,
      chatHandle: o.chatHandle,
      settings: o.settings,
      projectKey: o.projectKey,
      conversationId: o.conversationId,
      mode: o.mode,
      onSelectionChanged: () => this.publishSnapshot(),
      respond: (requestId, ok, result, error) => this.respond(requestId, ok, result, error),
    });
  }

  readonly lifecycle: CodeRunLifecycleObserver = {
    onRunStarted: () => {
      this.publishAgentState('running', 'Starting the run');
      return Promise.resolve();
    },
    onEvents: (scope, events: readonly LoopEvent[]) => {
      for (const event of asEvents(projectLoopEvents(events, scope.turnId, this.options.mode(), undefined, this.thinkAccum, this.textAccum))) this.publish(event);
    },
    onRunTerminal: (scope, outcome: CodeRunOutcome) => {
      this.thinkAccum.delete(scope.turnId);
      this.textAccum.delete(scope.turnId);
      this.publish(
        outcome === 'failed'
          ? { type: 'error', message: 'Code run failed' }
          : outcome === 'cancelled' || outcome === 'exited'
            ? { type: 'stopped' }
            : { type: 'assistant' },
      );
    },
  };

  onWorkItem(item: ConversationItem): void {
    if (item.kind !== 'approval') return;
    const request = workApprovalToPetRequest(item);
    if (request) this.pendingWorkApprovals.set(request.requestId, request);
    else this.pendingWorkApprovals.delete(item.approvalId);
    this.publishPermissions();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return;
    if (!enabled || !this.options.isTauri()) {
      this.lifecycleGeneration += 1;
      await this.shutdown(false);
      return;
    }
    if (this.started) return;
    const generation = ++this.lifecycleGeneration;
    await this.startup(generation);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifecycleGeneration += 1;
    await this.shutdown(true);
  }

  onStatus(listener: (status: RemoteStatusResult) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.remoteStatusValue);
    return () => this.statusListeners.delete(listener);
  }

  status(): RemoteStatusResult {
    return this.remoteStatusValue;
  }

  async refreshStatus(): Promise<RemoteStatusResult> {
    if (!this.started) {
      this.setStatus(EMPTY_REMOTE_STATUS);
      return this.remoteStatusValue;
    }
    try {
      this.setStatus(await this.options.port.status());
    } catch {
      // Dead sidecar — keep the stale status; the host health chip tells the story.
    }
    return this.remoteStatusValue;
  }

  pairing(): Promise<RemotePairingInfoResult> {
    return this.options.port.pairingInfo();
  }

  /** Announce a mobile task receipt on the phone (frozen-gateway vocabulary
   *  only — see projectTaskReceipt). Called by the sendTask authority, which
   *  knows the surface and the qualifier (Code mode / Work profile id). */
  announceTaskSurface(opts: { surface: RemoteTaskSurface; mode: string; profileId?: string }): void {
    if (this.disposed || !this.started) return;
    for (const event of projectTaskReceipt({ ...opts, now: Date.now })) this.publish(event);
  }

  // ── internals ────────────────────────────────────────────────────────

  private async startup(generation: number): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startupInFlight = true;
    this.watchSupervisor();
    const client = this.options.manager.client;
    this.disposers.push(
      client.onEvent('host.remoteRequest', (request) => void this.router.handle(request).catch(() => {})),
      client.onEvent('remote.status', (payload) => this.setStatus(payload)),
      this.options.manager.onHealth((health) => {
        if (health === 'ready') {
          // The initial ready lands while enable() is still in flight — that
          // path enables itself; only a later host generation needs a rebind.
          if (!this.startupInFlight && this.needsReenable) {
            this.needsReenable = false;
            void this.reenable(this.lifecycleGeneration);
          }
          return;
        }
        this.setStatus(EMPTY_REMOTE_STATUS);
        if (health === 'restarting' || health === 'down') this.needsReenable = true;
      }),
      this.options.manager.onDown(() => {
        this.setStatus(EMPTY_REMOTE_STATUS);
        console.warn('[remote] service host down — remote disabled until restart');
      }),
    );
    try {
      await this.startGateway(generation);
    } catch (error) {
      if (generation !== this.lifecycleGeneration) return;
      console.warn('[remote] failed to start the remote gateway', error);
      this.started = false;
      this.channelEnabled = false;
      this.setStatus(EMPTY_REMOTE_STATUS);
      // Startup is transactional; a retry must not accumulate listeners.
      for (const dispose of this.disposers.splice(0)) dispose();
    } finally {
      if (generation === this.lifecycleGeneration) this.startupInFlight = false;
    }
  }

  /** ensureRunning → enable → full-snapshot publish (startup + re-enable). */
  private async startGateway(generation: number): Promise<void> {
    const { sidecarsDir, appDataDir } = await this.options.paths();
    await this.options.manager.ensureRunning({ sidecarsDir, appDataDir });
    const status = await this.options.port.enable(this.enableParams());
    this.channelEnabled = true;
    if (this.disposed || generation !== this.lifecycleGeneration) {
      await this.options.port.disable().catch(() => {});
      this.channelEnabled = false;
      return;
    }
    this.setStatus(status);
    this.needsReenable = false;
    this.publishSnapshot();
  }

  private async reenable(generation: number): Promise<void> {
    try {
      await this.startGateway(generation);
    } catch (error) {
      this.channelEnabled = false;
      this.needsReenable = true;
      this.setStatus(EMPTY_REMOTE_STATUS);
      console.warn('[remote] failed to re-enable after service host restart', error);
    }
  }

  private async shutdown(stopManager: boolean): Promise<void> {
    if (this.channelEnabled) await this.options.port.disable().catch(() => {});
    this.started = false;
    this.channelEnabled = false;
    this.startupInFlight = false;
    this.needsReenable = false;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.pendingWorkApprovals.clear();
    this.lastPublishedState = '';
    this.lastPublishedPermissionKey = '';
    this.setStatus(EMPTY_REMOTE_STATUS);
    if (stopManager) await this.options.manager.stop().catch(() => {});
  }

  /** Supervisor subscription keeps binding state + Code approvals flowing;
   *  after a restart it re-projects from scratch. */
  private watchSupervisor(): void {
    this.disposers.push(
      this.options.supervisor.subscribe(() => {
        const view = this.options.supervisor.getViewState(this.options.projectKey(), this.options.conversationId());
        const binding = projectBindingState(view, this.lastPublishedState);
        if (binding) {
          this.lastPublishedState = binding.state;
          this.publish(binding);
        }
        this.publishPermissions();
      }),
    );
  }

  private enableParams(): RemoteEnableParams {
    const remote = (this.options.settings() as { remote?: RemoteSettingsLike }).remote ?? {};
    // The renderer cannot see os.hostname(); the sidecar defaults it.
    return {
      port: remote.port,
      workspaceName: this.options.currentWorkspace()?.name ?? 'Trylo Code',
      deviceName: '',
      tunnelMode: remote.tunnelMode,
      publicUrl: remote.publicUrl,
      cloudflaredPath: remote.cloudflaredPath,
    };
  }

  /** Full-snapshot reproject: after enable, host-ready re-enable, and after a
   *  project/session selection changed (§8.2: 重启后先发全量快照再增量). */
  private publishSnapshot(): void {
    const o = this.options;
    const snapshot = buildFullSnapshot({
      view: o.supervisor.getViewState(o.projectKey(), o.conversationId()),
      history: o.history(),
      kind: o.conversationKind(),
      index: o.workspaceIndex(),
      currentWorkspace: o.currentWorkspace(),
      code: o.codePermissions(),
      work: this.mergeWorkApprovals(),
      now: Date.now,
    });
    for (const event of asEvents(snapshot)) this.publish(event);
  }

  private publishPermissions(): void {
    const event = asPermissionEvent(
      projectApprovals({ code: this.options.codePermissions(), work: this.mergeWorkApprovals(), now: Date.now }),
    );
    const key = event.requests.map((request) => String(request.requestId ?? '')).join(',');
    if (key === this.lastPublishedPermissionKey) return;
    this.lastPublishedPermissionKey = key;
    this.publish(event);
  }

  private publishAgentState(state: string, detail = ''): void {
    if (state === this.lastPublishedState) return;
    this.lastPublishedState = state;
    this.publish({ type: 'agentState', state, detail, level: 'info', meta: {} });
  }

  private publish(event: RemoteGatewayEvent): void {
    void this.options.port.publish(event).catch(() => {});
  }

  /** Injected getter (App's list) merged with what onWorkItem tracked. */
  private mergeWorkApprovals(): PetPermissionRequest[] {
    const out = new Map<string, PetPermissionRequest>();
    for (const request of [...this.options.workApprovals(), ...this.pendingWorkApprovals.values()]) out.set(request.requestId, request);
    return [...out.values()];
  }

  private setStatus(next: RemoteStatusResult): void {
    if (JSON.stringify(next) === JSON.stringify(this.remoteStatusValue)) return;
    this.remoteStatusValue = next;
    for (const listener of [...this.statusListeners]) listener(next);
  }

  private respond(
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: { readonly code: string; readonly message: string; readonly statusCode?: number },
  ): Promise<unknown> {
    return this.options.port.respond({ requestId, ok, ...(result !== undefined ? { result } : {}), ...(error !== undefined ? { error } : {}) });
  }
}
