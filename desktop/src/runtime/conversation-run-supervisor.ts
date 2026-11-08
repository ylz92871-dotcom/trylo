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
import { useSyncExternalStore } from 'react'
import {
  collaborationLearningSettings,
  type CollaborationLearningSettings,
} from '../settings/collaboration-learning'
import { agentLearningForRun, type AgentLearningSettings } from '../settings/agent-learning'
import { checkLearningForRun, type CheckLearningSettings } from '../settings/check-learning'
import { contextPreference, resolveContextPreference } from '../settings/context-window'
import { modelReasoningEffort, type ModelReasoningPreferences } from '../settings/model-reasoning'
import { CodeRunController, type CodeRunRequest } from './code-run-controller'
import type { ActiveCodeRun, CodeRunViewState, SettingsForCodeRun } from './runtime-types'
import { IDLE_CODE_VIEW_STATE } from './runtime-types'
import {
  CodePermissionRegistry,
  type CodePermissionAuditEntry,
  type CodePermissionRequest,
  type CodePermissionScope,
} from './code-permission-registry'
import type { CliCommandControlPort, CliCommandRecoveryPort } from '../host-adapter/cli-command'
import type { ProcessHandle } from '../host-adapter/process-service'
import type { FilePath } from '../host-adapter/types'
import type { PermissionLevel } from '../permission/permission-policy'
import { getCliRuntimeResolution } from './cli-runtime-resolution'
import type { ResolvedToolRuntime, ToolRuntimeResolver, ToolRuntimeResolveOptions, ToolSurface } from '../tooling/types'
import type { ToolLeaseGrant, ToolRiskRouter } from '../tooling/tool-risk-classifier'
// Round-3 P0-5: see ./steer-delivery.ts — `steerCode` answers WHY, not whether.
import { STEER_NOT_RUNNING, type SteerDelivery } from './steer-delivery'
import { RecoveredConversationStop } from './recovered-conversation-stop'
import { hostAdapter } from '../host-adapter/index'
import type { CliSessionStore } from './cli-session-store'
import { RecoveredTeamOutput, type TeamOutputRecovery } from './recovered-team-output'
import { CodeInputRegistry } from './code-input-registry'
import { cancelSubagent } from '../host-adapter/trylo-v1-subagent-control'
import { buildUserPrompt } from '../host-adapter/control-protocol'
import type { PersistedRecoveryRun } from './recovery-output-selection'
function controllerKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`
}
function ownedProcessIds(controllers: readonly CodeRunController[]): ReadonlySet<string> {
  return new Set(
    controllers
      .flatMap((controller) => [controller.getViewState().activeProcessId])
      .filter((id): id is string => id !== null),
  )
}
export interface ConversationSendPreparation {
  readonly signal: AbortSignal
  isCurrent(): boolean
  finish(): void
  cancel(): void
}
interface PendingSend extends ActiveCodeRun {
  readonly preparation: ConversationSendPreparation
}
/** Dependencies owned by the conversation supervisor. */
export interface ConversationSupervisorOptions {
  readonly sessionStore?: CliSessionStore | null
  readonly now?: () => number
  readonly resolveHermesStorageRoot?: () => Promise<string | undefined>

  readonly resolveToolRuntime?: ToolRuntimeResolver | null
  /**
   * PR-2 (tool-extension spec §6): the host risk classifier consulted
   * before a control_request is projected. Auto-allow/deny decisions are
   * answered on the CLI's stdin directly; prompt decisions surface as
   * approval cards exactly like today. Null (default) keeps the pure
   * human-approval behaviour — wiring the classifier is additive.
   */
  readonly riskClassifier?: ToolRiskRouter | null
  /**
   * PR-3 (§6.5): records a lease granted by an explicit user approval
   * (browser first-visit navigation). Must be the SAME store the
   * classifier instance consults, so the grant unlocks later in-origin
   * navigations until expiry.
   */
  readonly onLeaseGrant?: (grant: ToolLeaseGrant) => void
}
/** The context a Tool Profile resolver needs (spec §4.2). */
export interface ToolRuntimeRequestContext {
  readonly surface: ToolSurface
  readonly requestedProfileId?: string
  readonly computerUse?: boolean
  readonly projectKey: string
  readonly projectRoot: string
  readonly conversationId: string
  readonly permissionLevel: PermissionLevel
}
export class ConversationRunSupervisor {
  async controlGoal(
    projectKey: string,
    conversationId: string,
    action: 'pause' | 'cancel',
  ): Promise<void> {
    const processId =
      this.controllers.get(controllerKey(projectKey, conversationId))?.getViewState()
        .activeProcessId ?? this.recoveredOutput.activeProcess(projectKey, conversationId)
    if (!processId) throw new Error('目标当前未在运行，请从当前聊天继续或取消。')
    await hostAdapter.process.send(
      processId,
      `${JSON.stringify({ type: 'goal_control', action })}\n`,
    )
  }
  private readonly recoveredInputs = new CodeInputRegistry((id, line) =>
    hostAdapter.process.send(id, line),
  )
  private readonly recoveredOutput = new RecoveredTeamOutput(
    () => hostAdapter.process,
    (frame, processId, projectKey, conversationId) => {
      if (
        this.recoveredInputs.handle(frame, processId, (events) =>
          this.recoveredOutput.enqueue(processId, events),
        )
      )
        return
      // Restored requests keep human approval: today's settings cannot grant
      // yesterday's run new automatic authority.
      this.permissions.handleControlFrame(frame, { processId, projectKey, conversationId })
    },
    (processId) => {
      this.permissions.clearProcess(processId)
      this.recoveredInputs.clearProcess(processId)
    },
    () => this.bump(),
  )
  private readonly recoveredStops = new RecoveredConversationStop(
    async () => hostAdapter.process,
    () => this.bump(),
  )
  private readonly controllers = new Map<string, CodeRunController>()
  private readonly pendingSends = new Map<string, PendingSend>()
  private readonly recoveryReadFailures = new Set<string>()
  private sendSequence = 0
  private readonly listeners = new Set<() => void>()
  private version = 0
  private readonly now: () => number
  /** §6.4: pending can_use_tool requests across every Code CLI. One
   *  shared registry (entries carry their scope), bumping the same
   *  version counter as run-state changes. */
  private readonly permissions: CodePermissionRegistry
  private librarySequence = 0
  private readonly libraryCommands = new Map<
    string,
    {
      binding:
        | {
            readonly kind: 'pending'
          }
        | {
            readonly kind: 'process'
            readonly handle: ProcessHandle
          }
      scope: Pick<CodePermissionScope, 'projectKey' | 'conversationId' | 'projectRoot'>
      state: 'running' | 'stopping' | 'stop_unconfirmed'
      error?: string
      stop: () => Promise<void>
      confirmExit?: () => Promise<boolean>
    }
  >()
  private readonly resolveHermesStorageRoot: (() => Promise<string | undefined>) | undefined

  private readonly resolveToolRuntime: ToolRuntimeResolver | null
  private readonly sessionStore: CliSessionStore | null
  constructor(options: ConversationSupervisorOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.permissions = new CodePermissionRegistry({
      onChange: () => this.bump(),
      ...(options.riskClassifier ? { riskClassifier: options.riskClassifier } : {}),
      ...(options.onLeaseGrant ? { onLeaseGrant: options.onLeaseGrant } : {}),
    })
    this.resolveHermesStorageRoot = options.resolveHermesStorageRoot
    this.resolveToolRuntime = options.resolveToolRuntime ?? null
    this.sessionStore = options.sessionStore ?? null
  }

  async resolveRuntimeFor(context: ToolRuntimeRequestContext, options?: ToolRuntimeResolveOptions): Promise<ResolvedToolRuntime | null> {
    if (!this.resolveToolRuntime) return null
    const runtime = await this.resolveToolRuntime(context, options)
    if (!runtime) throw new Error('工具配置尚未就绪，请重新发送以重试。')
    return runtime
  }
  /** Get-or-create a controller for a conversation. */
  controller(projectKey: string, conversationId: string): CodeRunController {
    const key = controllerKey(projectKey, conversationId)
    let existing = this.controllers.get(key)
    if (!existing) {
      existing = new CodeRunController({
        projectKey,
        conversationId,
        onChange: () => this.bump(),
        permissions: this.permissions,
        sessionStore: this.sessionStore,
      })
      this.controllers.set(key, existing)
    }
    return existing
  }
  /** Publish send feedback before any tool/service work. Ownership also lets
   * Stop invalidate a send that has not acquired a CLI controller yet. */
  beginSend(
    projectKey: string,
    conversationId: string,
    turnId?: string,
  ): ConversationSendPreparation | null {
    const key = controllerKey(projectKey, conversationId)
    if (
      this.pendingSends.has(key) ||
      this.recoveredStops.isHeld(projectKey, conversationId) ||
      this.recoveredOutput.view(projectKey, conversationId)
    )
      return null
    const abort = new AbortController()
    const preparation: ConversationSendPreparation = {
      signal: abort.signal,
      isCurrent: () => this.pendingSends.get(key)?.preparation === preparation,
      finish: () => {
        if (!preparation.isCurrent()) return
        this.pendingSends.delete(key)
        this.bump()
      },
      cancel: () => {
        abort.abort()
        preparation.finish()
      },
    }
    this.pendingSends.set(key, {
      projectKey,
      conversationId,
      preparation,
      runId: turnId ?? `preparing-${++this.sendSequence}`,
      startedAt: this.now(),
      bindingState: 'spawning',
    })
    this.bump()
    return preparation
  }
  /** Read-only preflight before the composer freezes or replaces team history. */
  inspectTeamOwner(projectKey: string, conversationId: string): Promise<void> {
    return this.recoveredStops.assertAvailable(
      projectKey,
      conversationId,
      ownedProcessIds([...this.controllers.values()]),
    )
  }
  hasLocalOwner(projectKey: string, conversationId: string): boolean {
    const key = controllerKey(projectKey, conversationId)
    const view = this.controllers.get(key)?.getViewState()
    return this.pendingSends.has(key) || view?.running === true || Boolean(view?.activeProcessId)
  }
  hasRecoveredOwner(projectKey: string, conversationId: string): boolean {
    return this.recoveredOutput.view(projectKey, conversationId) !== null
  }
  hasRecoveredConversationOwner(projectKey: string, conversationId: string): boolean {
    return this.recoveredOutput.hasConversationOwner(projectKey, conversationId)
  }
  recoverTeamOutput(projectKey: string, conversationId: string, teamRunId: string) {
    return this.recoveredOutput.read(projectKey, conversationId, teamRunId)
  }

  async recoverConversationOutput(
    projectKey: string,
    conversationId: string,
    turnIds: readonly string[] = [],
    expectedRun?: PersistedRecoveryRun,
  ) {
    if (this.hasLocalOwner(projectKey, conversationId)) return null
    const key = controllerKey(projectKey, conversationId)
    try {
      const receipt = await this.recoveredOutput.readConversation(
        projectKey,
        conversationId,
        turnIds,
        expectedRun,
      )
      if (this.recoveryReadFailures.delete(key)) this.bump()
      // An independently confirmed exit also retires an earlier detached lookup.
      if (receipt && !receipt.live) await this.inspectRestoredOwner(projectKey, conversationId)
      return receipt
    } catch (error) {
      this.recoveryReadFailures.add(key)
      this.bump()
      throw error
    }
  }
  async inspectRestoredOwner(
    projectKey: string,
    conversationId: string,
  ): Promise<'owned' | 'absent' | 'detached'> {
    if (this.hasLocalOwner(projectKey, conversationId)) return 'owned'
    const result = await this.recoveredStops.inspect(
      projectKey,
      conversationId,
      ownedProcessIds([...this.controllers.values()]),
    )
    return this.hasLocalOwner(projectKey, conversationId) ? 'owned' : result
  }
  /** Drive one Code user turn on a conversation. Background-safe:
   *  the controller keeps writing to its own conversation even if
   *  the user navigated away. */
  async runCode(
    projectKey: string,
    conversationId: string,
    request: Omit<CodeRunRequest, 'projectKey' | 'conversationId'> & {
      readonly sendPreparation?: ConversationSendPreparation
    },
  ): Promise<void> {
    const { sendPreparation, ...runRequest } = request
    const preparation =
      sendPreparation ?? this.beginSend(projectKey, conversationId, request.turnId)
    if (!preparation) throw new Error('This conversation is already preparing a send.')
    if (
      this.pendingSends.get(controllerKey(projectKey, conversationId))?.preparation !== preparation
    )
      return
    try {
      // Native roots survive renderer/controller reconstruction in ordinary v1 chats too.
      {
        try {
          await this.inspectTeamOwner(projectKey, conversationId)
        } catch (error) {
          // Stop invalidates an inspection before any prompt was delivered.
          if (!preparation.isCurrent()) return
          throw error
        }
        if (!preparation.isCurrent()) return
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
      let toolRuntime: ResolvedToolRuntime | null | undefined = request.toolRuntime
      if (toolRuntime === undefined && this.resolveToolRuntime) {
        try {
          toolRuntime = await this.resolveRuntimeFor({
            surface: request.surface ?? 'code',
            ...(request.requestedProfileId ? { requestedProfileId: request.requestedProfileId } : {}),
            ...(request.computerUse !== undefined ? { computerUse: request.computerUse } : {}),
            projectKey,
            projectRoot: request.settings.cwd,
            conversationId,
            permissionLevel: request.permissionLevel,
          }, { signal: preparation.signal })
        } catch (error) {
          if (!preparation.isCurrent()) return
          throw error
        }
        if (!preparation.isCurrent()) return
      }
      let hermesStorageRoot: string | undefined
      if (this.resolveHermesStorageRoot) {
        try {
          hermesStorageRoot = (await this.resolveHermesStorageRoot()) ?? ''
        } catch {
          hermesStorageRoot = ''
        } // An unavailable skill home must not select a different library.
        if (!preparation.isCurrent()) return
      }
      await this.controller(projectKey, conversationId).run({
        ...runRequest,
        ...(hermesStorageRoot === undefined
          ? {}
          : { settings: { ...runRequest.settings, hermesStorageRoot } }),
        toolRuntime: toolRuntime ?? null,
      })
    } finally {
      preparation.finish()
    }
  }
  /** Manual compaction stays bound to the controller that owns the journal. */
  canCompactCode(projectKey: string, conversationId: string): boolean {
    return this.controllers.get(controllerKey(projectKey, conversationId))?.canCompact() ?? false
  }
  compactCode(projectKey: string, conversationId: string): Promise<boolean> {
    return (
      this.controllers.get(controllerKey(projectKey, conversationId))?.compact() ??
      Promise.resolve(false)
    )
  }
  /** Redirect an in-flight turn without replacing its runId or process. */
  steerCode(projectKey: string, conversationId: string, prompt: string): Promise<SteerDelivery> {
    const recovered = this.recoveredOutput.activeProcess(projectKey, conversationId)
    if (recovered)
      return hostAdapter.process.send(recovered, buildUserPrompt(prompt)).then(
        () => ({ kind: 'delivered' as const }),
        () => ({ kind: 'write-failed' as const }),
      )
    const controller = this.controllers.get(controllerKey(projectKey, conversationId))
    // Round-3 P0-5: "no controller" means no live run to inject into — which is
    // its own answer, not a generic failure the user should retry blindly.
    return controller ? controller.steer(prompt) : Promise.resolve(STEER_NOT_RUNNING)
  }
  /** Stop one Team seat / CLI task on a live conversation process. */
  stopTask(projectKey: string, conversationId: string, taskId: string): Promise<boolean> {
    const recovered = this.recoveredOutput.activeProcess(projectKey, conversationId)
    if (recovered)
      return cancelSubagent(recovered, taskId).then(
        () => true,
        () => false,
      )
    const controller = this.controllers.get(controllerKey(projectKey, conversationId))
    return controller ? controller.stopTask(taskId) : Promise.resolve(false)
  }
  /** Stop only the current run of ONE conversation. */
  async stopConversation(
    projectKey: string,
    conversationId: string,
    onRecovered?: (receipt: TeamOutputRecovery) => void | Promise<void>,
  ): Promise<void> {
    this.permissions.revokeScope(projectKey, conversationId)
    this.recoveredOutput.requestStop(projectKey, conversationId)
    this.pendingSends.get(controllerKey(projectKey, conversationId))?.preparation.cancel()
    const c = this.controllers.get(controllerKey(projectKey, conversationId))
    const owner = c?.getViewState().activeProcessId
    if (owner) this.permissions.revokeProcess(owner)
    await c?.stop()
    if (owner === null || owner === undefined)
      await this.recoveredStops.stop(projectKey, conversationId)
    const receipts = await this.recoveredOutput.confirmStopped(projectKey, conversationId)
    for (const receipt of receipts) await onRecovered?.(receipt)
  }
  /** Stop every live run currently in flight (app exit path). */
  async stopAll(): Promise<void> {
    this.permissions.revokeScope()
    this.recoveredOutput.requestStop()
    for (const send of this.pendingSends.values()) send.preparation.cancel()
    const controllers = [...this.controllers.values()]
    const excluded = ownedProcessIds(controllers)
    await Promise.all([
      ...controllers.map((c) => c.stop()),
      this.recoveredStops.stopAll(excluded),
      ...[...this.libraryCommands.keys()].map((id) => this.retryLibraryStop(id)),
    ])
    await this.recoveredOutput.confirmStopped()
  }
  /** Stop every run owned by one project/workspace (close-project
   *  path), THEN drop the project's controllers so no orphan handle
   *  lingers (P1-1). Navigation between workspaces does NOT call
   *  this — both runs keep going in the background. */
  async stopWorkspace(projectKey: string): Promise<void> {
    this.permissions.revokeScope(projectKey)
    this.recoveredOutput.requestStop(projectKey)
    for (const send of this.pendingSends.values()) {
      if (send.projectKey === projectKey) send.preparation.cancel()
    }
    const targets = [...this.controllers.entries()]
      .filter(([key]) => key.startsWith(`${projectKey}::`))
      .map(([, controller]) => controller)
    const excluded = ownedProcessIds(targets)
    await Promise.all([
      ...targets.map((c) => c.stop()),
      this.recoveredStops.stopWorkspace(projectKey, excluded),
      ...[...this.libraryCommands]
        .filter(([, command]) => command.scope.projectKey === projectKey)
        .map(([id]) => this.retryLibraryStop(id)),
    ])
    await this.recoveredOutput.confirmStopped(projectKey)
    for (const controller of targets) {
      this.controllers.delete(controller.key)
    }
  }
  /** Permanently remove a conversation: stop+drops its controller.
   *  Used on delete — a deleted conversation's run must end (P0-1)
   *  and its controller must not linger (P1-1). No-op when the
   *  conversation has no controller. */
  async removeConversation(projectKey: string, conversationId: string): Promise<void> {
    this.pendingSends.get(controllerKey(projectKey, conversationId))?.preparation.cancel()
    const controller = this.controllers.get(controllerKey(projectKey, conversationId))
    await this.stopConversation(projectKey, conversationId)
    this.recoveryReadFailures.delete(controllerKey(projectKey, conversationId))
    if (!controller) return
    controller.dispose()
    if (this.controllers.get(controller.key) === controller) this.controllers.delete(controller.key)
  }
  /** ViewState for ONE visible conversation (idle default). */
  getViewState(projectKey: string, conversationId: string | null): CodeRunViewState {
    if (!conversationId) return IDLE_CODE_VIEW_STATE
    const recovered =
      this.recoveredOutput.view(projectKey, conversationId) ??
      this.recoveredStops.view(projectKey, conversationId)
    if (recovered)
      return this.recoveryReadFailures.has(controllerKey(projectKey, conversationId))
        ? { ...recovered, error: true, recoveryState: { kind: 'unavailable' } }
        : recovered
    const pending = this.pendingSends.get(controllerKey(projectKey, conversationId))
    if (pending)
      return {
        ...IDLE_CODE_VIEW_STATE,
        running: true,
        sendable: false,
        bindingState: 'spawning',
        runId: pending.runId,
      }
    return (
      this.controllers.get(controllerKey(projectKey, conversationId))?.getViewState() ??
      IDLE_CODE_VIEW_STATE
    )
  }
  /** Runs in flight across all conversations (Activity Center). */
  activeCodeRuns(): readonly ActiveCodeRun[] {
    const runs: ActiveCodeRun[] = []
    for (const c of this.controllers.values()) {
      const active = c.getActiveRun()
      if (active && !this.pendingSends.has(controllerKey(active.projectKey, active.conversationId)))
        runs.push(active)
    }
    for (const send of this.pendingSends.values())
      runs.push({
        projectKey: send.projectKey,
        conversationId: send.conversationId,
        runId: send.runId,
        startedAt: send.startedAt,
        bindingState: send.bindingState,
      })
    return runs
  }
  /** §6.4: pending CLI permission requests across ALL workspaces. */
  pendingCodePermissions(): readonly CodePermissionRequest[] {
    return this.permissions.list()
  }
  /** Library processes use this same registry; actual process ownership comes from ProcessService. */
  libraryApprovalPort(
    scope: Pick<CodePermissionScope, 'projectKey' | 'conversationId' | 'projectRoot'>,
  ): CliCommandControlPort {
    const current = (id: string) => {
      const command = this.libraryCommands.get(id)
      return command?.scope.projectKey === scope.projectKey &&
        command.scope.conversationId === scope.conversationId
        ? command
        : undefined
    }
    return {
      receive: (frame, processId) =>
        this.permissions.handleControlFrame(frame, { ...scope, processId }),
      respondToUserAction: async (frame, processId) => {
        if (current(processId)?.state !== 'running') return false
        this.permissions.handleControlFrame(frame, { ...scope, processId })
        const pending = this.permissions
          .list()
          .find((request) => request.requestId === frame.requestId)
        if (
          pending?.processId !== processId ||
          pending.input !== frame.input ||
          pending.toolName !== frame.toolName
        )
          return false
        return this.permissions.respond(frame.requestId, true)
      },
      clearProcess: (processId) => this.permissions.clearProcess(processId),
      starting: (stop) => {
        const reservationId = `library-start:${++this.librarySequence}`
        this.libraryCommands.set(reservationId, {
          binding: { kind: 'pending' },
          scope,
          state: 'running',
          stop,
        })
        this.bump()
        return reservationId
      },
      acquired: (handle, stop, reservationId, confirmExit) => {
        const pending = reservationId === undefined ? undefined : current(reservationId)
        if (pending?.binding.kind === 'pending') {
          pending.binding = { kind: 'process', handle }
          pending.stop = stop
          pending.confirmExit = confirmExit
          this.libraryCommands.delete(reservationId!)
          this.libraryCommands.set(handle.id, pending)
          this.bump()
        } else if (!this.libraryCommands.has(handle.id)) {
          this.libraryCommands.set(handle.id, {
            binding: { kind: 'process', handle },
            scope,
            state: 'running',
            stop,
            confirmExit,
          })
          this.bump()
        }
      },
      spawnRejected: (reservationId) => {
        if (current(reservationId)?.binding.kind === 'pending') {
          this.libraryCommands.delete(reservationId)
          this.bump()
        }
      },
      stopping: (id) => {
        const command = current(id)
        if (command) {
          command.state = 'stopping'
          command.error = undefined
          this.bump()
        }
      },
      stopUnconfirmed: (id, reason) => {
        const command = current(id)
        if (command) {
          command.state = 'stop_unconfirmed'
          command.error = reason
          this.bump()
        }
      },
      exited: (id, reservationId) => {
        if (current(id)) {
          this.libraryCommands.delete(id)
          this.permissions.clearProcess(id)
          this.bump()
        }
        if (reservationId !== undefined && current(reservationId)?.binding.kind === 'pending') {
          this.libraryCommands.delete(reservationId)
          this.bump()
        }
      },
      canStart: () =>
        ![...this.libraryCommands.values()].some(
          (command) =>
            command.scope.projectKey === scope.projectKey &&
            (command.binding.kind === 'pending' || command.state !== 'running'),
        ),
      startState: () => {
        const commands = [...this.libraryCommands.values()].filter(
          (command) => command.scope.projectKey === scope.projectKey,
        )
        if (commands.some((command) => command.state === 'stop_unconfirmed'))
          return 'stop_unconfirmed'
        if (commands.some((command) => command.state === 'stopping')) return 'stopping'
        return commands.some((command) => command.binding.kind === 'pending') ? 'binding' : 'ready'
      },
      subscribe: this.subscribe,
      reconcile: async () => {
        // The transport owns each exact child and its exit witness. Do not clear
        // a pending spawn or any running/other-workspace process to admit a read.
        const retained = [...this.libraryCommands.values()].filter(
          (command) =>
            command.scope.projectKey === scope.projectKey &&
            command.state !== 'running' &&
            command.binding.kind === 'process',
        )
        await Promise.all(retained.map((command) => command.confirmExit?.()))
      },
    }
  }
  /** Actual handles remain here until exit; UI retry calls the same owned stop function. */
  libraryRecoveryPort(): CliCommandRecoveryPort {
    return {
      subscribe: this.subscribe,
      getVersion: this.getVersion,
      statuses: () =>
        [...this.libraryCommands.entries()].flatMap(([processId, command]) =>
          command.state === 'running'
            ? []
            : [
                {
                  processId,
                  workspaceRoot: command.scope.projectRoot ?? command.scope.projectKey,
                  state: command.state,
                  ...(command.error === undefined ? {} : { error: command.error }),
                },
              ],
        ),
      retry: (id) => this.retryLibraryStop(id),
    }
  }
  private async retryLibraryStop(id: string): Promise<void> {
    const command = this.libraryCommands.get(id)
    if (!command) return
    command.state = 'stopping'
    command.error = undefined
    this.bump()
    try {
      await command.stop()
    } catch (error) {
      if ([...this.libraryCommands.values()].includes(command)) {
        command.state = 'stop_unconfirmed'
        command.error = error instanceof Error ? error.message : 'process_stop_unconfirmed'
        this.bump()
      }
      throw error
    }
  }
  /** §6.4: answer one pending CLI permission by requestId. Resolves
   *  false for unknown/expired ids (caller records diagnostics). */
  respondCodePermission(requestId: string, allow: boolean): Promise<boolean> {
    return this.permissions.respond(requestId, allow)
  }
  respondInputRequest(
    requestId: string,
    status: 'submitted' | 'dismissed',
    answers?: Record<string, import('../host-adapter/input-request').InputRequestAnswer>,
  ): Promise<boolean> {
    if (this.recoveredInputs.has(requestId))
      return this.recoveredInputs.respond(requestId, status, answers)
    for (const controller of this.controllers.values()) {
      if (controller.inputRequests.has(requestId))
        return controller.inputRequests.respond(requestId, status, answers)
    }
    return Promise.resolve(false)
  }
  /** PR-2: recent host-classifier decisions across every CLI (bounded,
   *  redacted — see SafeAudit). Diagnostics surface. */
  toolRiskAudits(): readonly CodePermissionAuditEntry[] {
    return this.permissions.recentAudits()
  }
  /** Versioned snapshot for useSyncExternalStore. */
  getVersion = (): number => this.version
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private bump(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
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
  useSyncExternalStore(supervisor.subscribe, supervisor.getVersion)
  return supervisor.getViewState(projectKey, conversationId)
}
/** Replay retains the surviving execution and privacy settings through the same owner. */
export function settingsForCodeReplay(
  settings: Parameters<typeof settingsForCodeRun>[0],
  cwd: FilePath,
  directive?: Parameters<typeof settingsForCodeRun>[2],
): SettingsForCodeRun {
  return settingsForCodeRun(settings, cwd, directive)
}
/** Build the SettingsForCodeRun App hands each controller, mapped
 *  from its resolved TryloSettings + the workspace cwd. Kept here
 *  so App doesn't need to navigate the settings shape. */
export function settingsForCodeRun(
  settings: {
    apiKey?: string
    apiHost?: string
    apiModel?: string
    reasoningEffort?: SettingsForCodeRun['reasoningEffort']
    modelContextPreferences?: import('../settings/context-window').ModelContextPreferences
    modelReasoningPreferences?: ModelReasoningPreferences
    /** v-modelsel: built-in pool override; wins over apiModel. */
    poolModel?: string
    apiFormat?: 'anthropic' | 'openai'
    apiKeyHeader?: string
    apiKeyPrefix?: string
    extraHeadersText?: string
    systemPrompt?: string
    /** P08 §3.4: new-CLI provider selection (no credential). */
    providerId?: string
    /**
     * WP-CL / B: the user-learning switch the person actually turned on.
     * Only `enabled` matters here — this mapping never invents a value the
     * settings do not hold.
     */
    userLearning?: {
      readonly enabled?: boolean
    }
    agentLearning?: AgentLearningSettings
    workflowLearning?: import('../settings/workflow-learning').WorkflowLearningSettings
    checkLearning?: CheckLearningSettings
    collaborationLearning?: CollaborationLearningSettings
  },
  cwd: FilePath,
  directive?: {
    readonly applyExistingPreferences?: boolean
    readonly collectNewLearning: boolean
    readonly retention: 'normal' | 'session_only'
  },
): SettingsForCodeRun {
  // Effective model = pool override || user's own model. The pool never
  // overwrites apiModel, so switching pool↔own always round-trips.
  const model = settings.poolModel?.trim() ? settings.poolModel : settings.apiModel || undefined
  // The native resolver owns the only supported CLI entry.
  const resolution = getCliRuntimeResolution()
  const cliPath = resolution?.cliScript ?? ''
  const context = resolveContextPreference(contextPreference(settings))
  const reasoningEffort = modelReasoningEffort(settings)
  return {
    cliPath: cliPath as FilePath,
    cwd,
    ...{
      contextTokenLimit: context.requested,
      modelContextWindow: context.capacity,
    },
    apiKey: settings.poolModel?.trim() ? undefined : settings.apiKey || undefined,
    apiHost: settings.poolModel?.trim() ? undefined : settings.apiHost || undefined,
    apiModel: model,
    ...(settings.poolModel?.trim() ? { platformModel: settings.poolModel.trim() } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    apiFormat: settings.poolModel?.trim() ? 'openai' : settings.apiFormat,
    apiKeyHeader: settings.poolModel?.trim() ? undefined : settings.apiKeyHeader || undefined,
    apiKeyPrefix: settings.poolModel?.trim() ? undefined : settings.apiKeyPrefix || undefined,
    extraHeadersText: settings.poolModel?.trim()
      ? undefined
      : settings.extraHeadersText || undefined,
    systemPrompt: settings.systemPrompt || undefined,
    // P08 §3.4: provider selection travels with the run; the credential
    // never does (the new CLI reads its own ledger).
    providerId: settings.poolModel?.trim() ? 'openai-compatible' : settings.providerId || undefined,
    ...checkLearningForRun(settings.checkLearning, directive),
    ...agentLearningForRun(
      settings.agentLearning,
      settings.userLearning?.enabled === true,
      directive,
    ),
    ...(settings.workflowLearning?.enabled === true &&
    directive?.collectNewLearning !== false &&
    directive?.retention !== 'session_only'
      ? { workflowLearning: { ...settings.workflowLearning } }
      : {}),
    ...(directive?.collectNewLearning === false || directive?.retention === 'session_only'
      ? // Removing this turn's allowance cannot stop an already-running scope owner.
        { workflowCollection: 'disabled' as const, centralRuntimePolicy: 'pause' as const }
      : {}),
    ...{
      collaborationLearning: {
        ...collaborationLearningSettings(settings.collaborationLearning),
        enabled:
          directive?.collectNewLearning === false || directive?.retention === 'session_only'
            ? false
            : collaborationLearningSettings(settings.collaborationLearning).enabled,
      },
    },
    // P08 §WP6 (audit P1): the pinned Node travels WITH the script — the
    // two come from one resolution and must not be separated, or a
    // machine without Node on PATH fails despite the bundle carrying one.
    ...(true && resolution?.nodeProgram ? { cliNodeProgram: resolution.nodeProgram } : {}),
  }
}
