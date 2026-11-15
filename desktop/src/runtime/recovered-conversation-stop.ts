import type { LiveProcessInfo, ProcessService } from '../host-adapter/process-service'
import type { CodeRunViewState } from './runtime-types'
import { requestCliInterrupt } from '../host-adapter/trylo-v1-interrupt'
import { registeredProcessIds } from '../host-adapter/process-snapshot'

type Scope = { readonly projectKey: string; readonly conversationId: string }
type Selection =
  | { readonly kind: 'conversation'; readonly scope: Scope }
  | { readonly kind: 'workspace'; readonly projectKey: string }
  | { readonly kind: 'all' }
type ProcessPort = Pick<ProcessService, 'list' | 'stop' | 'hasTeamOwner'> &
  Partial<Pick<ProcessService, 'send'>>
type ConfirmedState = { readonly kind: 'failed' | 'detached'; readonly error: Error }
type Entry = {
  readonly selection: Selection
  targets: readonly LiveProcessInfo[]
  readonly interruptRequested: Set<string>
  state:
    | {
        readonly kind: 'inspecting'
        readonly completion: Promise<void>
        readonly previous?: ConfirmedState
      }
    | { readonly kind: 'stopping'; readonly completion: Promise<void> }
    | ConfirmedState
}
function visibleState(
  entry: Entry,
): Exclude<Entry['state'], { readonly kind: 'inspecting' }> | undefined {
  return entry.state.kind === 'inspecting' ? entry.state.previous : entry.state
}
function visibleFacts(entry: Entry | undefined): string {
  const state = entry && visibleState(entry)
  if (!entry || !state) return ''
  return JSON.stringify([
    state.kind,
    'error' in state ? state.error.message : null,
    entry.targets.map(({ id, pid, metadata }) => [
      id, pid, metadata.projectKey, metadata.conversationId, metadata.runId,
    ]),
  ])
}
const ROOT_LABELS = new Set(['trylo-cli', 'trylo-cli-v1', 'trylo-cli-prewarm'])
const NATIVE_WAIT_MS = 5_000
const key = (selection: Selection): string => JSON.stringify(selection)
function includes(selection: Selection, scope: Scope): boolean {
  if (selection.kind === 'all') return true
  if (selection.kind === 'workspace') return selection.projectKey === scope.projectKey
  return (
    selection.scope.projectKey === scope.projectKey &&
    selection.scope.conversationId === scope.conversationId
  )
}
function matchesRoot(
  process: LiveProcessInfo,
  scope: Scope,
  excluded: ReadonlySet<string>,
): boolean {
  return (
    ROOT_LABELS.has(process.label) &&
    !excluded.has(process.id) &&
    process.metadata.projectKey === scope.projectKey &&
    process.metadata.conversationId === scope.conversationId
  )
}
class DetachedConversationError extends Error {}

function observationCancelled(): Error {
  return new Error('Detached exit observation cancelled.')
}

function pauseObservation(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(observationCancelled())
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(observationCancelled())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, 50)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Every child failure is already retained by its conversation owner. */
class RecoveredChildrenStopError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(
      errors,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; '),
    )
  }
}

/** Native registrations outlive a rebuilt JS supervisor. This owner retains
 * failed cleanup until an explicit retry confirms the original targets exited. */
export class RecoveredConversationStop {
  private readonly entries = new Map<string, Entry>()
  constructor(
    private readonly processes: () => Promise<ProcessPort>,
    private readonly changed: () => void,
    private readonly pause: (signal?: AbortSignal) => Promise<void> = pauseObservation,
    private readonly now: () => number = () => performance.now(),
  ) {}

  private async nativeCall<T>(
    operation: () => Promise<T>,
    timeoutMs = NATIVE_WAIT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    // IPC has no cancellation receipt. A timeout releases the waiter only;
    // late replies cannot resume this operation or establish process exit.
    if (signal?.aborted) throw observationCancelled()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cancelled = signal
      ? new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(observationCancelled())
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
      : undefined
    try {
      return await Promise.race([
        signal
          ? Promise.resolve().then(() => {
              if (signal.aborted) throw observationCancelled()
              return operation()
            })
          : operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('等待原生进程控制超时，尚未确认旧执行退出，请重试停止。')),
            timeoutMs,
          )
        }),
        ...(cancelled ? [cancelled] : []),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  isHeld(projectKey: string, conversationId: string): boolean {
    return [...this.entries.values()].some((entry) =>
      includes(entry.selection, { projectKey, conversationId }),
    )
  }

  view(projectKey: string, conversationId: string): CodeRunViewState | null {
    const scope = { projectKey, conversationId }
    const exact = this.entries.get(key({ kind: 'conversation', scope }))
    const entry = exact && visibleState(exact)
      ? exact
      : [...this.entries.values()].find(
          (value) => includes(value.selection, scope) && visibleState(value),
        )
    if (!entry) return null
    const state = visibleState(entry)
    if (!state) return null
    const target = entry.targets.find(
      (process) =>
        process.metadata.projectKey === projectKey &&
        process.metadata.conversationId === conversationId,
    )
    return {
      running: true,
      sendable: false,
      error: state.kind === 'failed',
      bindingState: 'busy',
      activeProcessId: target?.id ?? null,
      pid: target?.pid ?? null,
      runId: target?.metadata.runId ?? null,
      recoveryState: { kind: state.kind === 'failed' ? 'unavailable' : 'reconnecting' },
    }
  }

  stop(
    projectKey: string,
    conversationId: string,
    excluded: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const scope = { projectKey, conversationId }
    return this.begin({ kind: 'conversation', scope }, (entry) =>
      this.execute(scope, entry, excluded),
    )
  }

  assertAvailable(
    projectKey: string,
    conversationId: string,
    excluded: ReadonlySet<string>,
  ): Promise<void> {
    const scope = { projectKey, conversationId }
    return this.begin(
      { kind: 'conversation', scope },
      async (entry) => {
        const processes = await this.nativeCall(() => this.processes())
        entry.targets = (await this.nativeCall(() => processes.list())).filter((process) =>
          matchesRoot(process, scope, excluded),
        )
        if (entry.targets.length)
          throw new DetachedConversationError(
            '旧执行仍在运行，正在恢复上一轮输出；恢复前不会启动重复任务。',
          )
        await this.assertNoExternalOwner(processes, scope, excluded)
      },
      'inspecting',
    )
  }

  async inspect(
    projectKey: string,
    conversationId: string,
    excluded: ReadonlySet<string>,
  ): Promise<'absent' | 'detached'> {
    try {
      await this.assertAvailable(projectKey, conversationId, excluded)
      return 'absent'
    } catch (error) {
      if (error instanceof DetachedConversationError) return 'detached'
      throw error
    }
  }

  private begin(
    selection: Selection,
    operation: (entry: Entry) => Promise<void>,
    activity: 'inspecting' | 'stopping' = 'stopping',
  ): Promise<void> {
    const scopeKey = key(selection)
    const previous = this.entries.get(scopeKey)
    if (previous?.state.kind === 'inspecting') {
      if (activity === 'inspecting') return previous.state.completion
      // A read-only inspection does not satisfy a user's subsequent Stop.
      return previous.state.completion.then(
        () => this.begin(selection, operation),
        () => this.begin(selection, operation),
      )
    }
    if (previous?.state.kind === 'stopping')
      return activity === 'inspecting'
        ? previous.state.completion.then(() => this.begin(selection, operation, activity))
        : previous.state.completion
    let resolve!: () => void
    let reject!: (error: Error) => void
    const completion = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    const entry: Entry = {
      selection,
      targets: previous?.targets ?? [],
      interruptRequested: previous?.interruptRequested ?? new Set(),
      state: activity === 'inspecting'
        ? { kind: activity, completion, previous: previous?.state }
        : { kind: activity, completion },
    }
    // A read-only lookup retains its send hold without inventing a visible run.
    // Rechecks keep the last confirmed state until ownership facts change.
    let published = visibleFacts(previous)
    const publish = (): void => {
      const next = visibleFacts(this.entries.get(scopeKey))
      if (next === published) return
      published = next
      this.changed()
    }
    this.entries.set(scopeKey, entry)
    publish()
    void operation(entry).then(
      () => {
        this.entries.delete(scopeKey)
        publish()
        resolve()
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        if (selection.kind !== 'conversation' && cause instanceof RecoveredChildrenStopError)
          this.entries.delete(scopeKey)
        else
          entry.state = {
            kind: cause instanceof DetachedConversationError ? 'detached' : 'failed',
            error,
          }
        publish()
        reject(error)
      },
    )
    return completion
  }

  stopWorkspace(projectKey: string, excluded: ReadonlySet<string>): Promise<void> {
    return this.begin({ kind: 'workspace', projectKey }, () =>
      this.stopMatching(excluded, projectKey),
    )
  }
  stopAll(excluded: ReadonlySet<string>): Promise<void> {
    return this.begin({ kind: 'all' }, () => this.stopMatching(excluded))
  }

  private async stopMatching(excluded: ReadonlySet<string>, projectKey?: string): Promise<void> {
    const processes = await this.nativeCall(() => this.processes())
    const scopes = new Map<string, Scope>()
    for (const entry of this.entries.values()) {
      if (entry.selection.kind !== 'conversation') continue
      const scope = entry.selection.scope
      if (projectKey === undefined || scope.projectKey === projectKey)
        scopes.set(key(entry.selection), scope)
    }
    for (const process of await this.nativeCall(() => processes.list())) {
      if (!ROOT_LABELS.has(process.label) || excluded.has(process.id)) continue
      const metadata = process.metadata
      if (projectKey !== undefined && metadata.projectKey !== projectKey) continue
      if (!metadata.projectKey || !metadata.conversationId)
        throw new Error('旧执行缺少工作区或会话归属，尚未确认全部停止。')
      const scope = { projectKey: metadata.projectKey, conversationId: metadata.conversationId }
      scopes.set(key({ kind: 'conversation', scope }), scope)
    }
    const settled = await Promise.allSettled(
      [...scopes.values()].map((scope) =>
        this.stop(scope.projectKey, scope.conversationId, excluded),
      ),
    )
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (errors.length) throw new RecoveredChildrenStopError(errors)
  }

  private async execute(scope: Scope, entry: Entry, excluded: ReadonlySet<string>): Promise<void> {
    const processes = await this.nativeCall(() => this.processes())
    entry.targets = (await this.nativeCall(() => processes.list())).filter((process) =>
      matchesRoot(process, scope, excluded),
    )
    this.changed()
    if (!entry.targets.length) return this.assertNoExternalOwner(processes, scope, excluded)
    const forceTargets = await this.interruptDetached(processes, entry.targets, entry.interruptRequested)
    const stopped = await Promise.allSettled(
      forceTargets.map((target) => this.nativeCall(() => processes.stop(target.id))),
    )
    const ids = new Set(entry.targets.map((target) => target.id))
    const deadline = this.now() + NATIVE_WAIT_MS
    for (let attempt = 0; attempt <= 100; attempt += 1) {
      if (attempt > 0 && this.now() >= deadline) break
      const remaining = (
        await this.nativeCall(() => processes.list(), Math.max(1, deadline - this.now()))
      ).filter((process) => ids.has(process.id))
      // Even a refused command can race a natural exit. The native reaper's
      // absence is the independent exit fact; a stop receipt alone is not.
      if (!remaining.length) return this.assertNoExternalOwner(processes, scope, excluded, deadline)
      entry.targets = remaining
      const failures = stopped.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failures.length)
        throw new Error(
          `尚未确认旧执行退出，请重试停止：${failures
            .map((result) =>
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            )
            .join('; ')}`,
        )
      if (this.now() >= deadline) break
      if (attempt < 100) await this.pauseBeforeRetry(deadline)
    }
    throw new Error('尚未确认旧执行进程退出，请重试停止。')
  }

  private async pauseBeforeRetry(deadline: number): Promise<void> {
    const observation = new AbortController()
    try {
      await this.nativeCall(
        () => this.pause(observation.signal),
        Math.max(1, deadline - this.now()),
        observation.signal,
      )
    } catch (error) {
      // At the shared deadline the caller reports its unconfirmed exit/lease,
      // rather than substituting a pause timeout for that ownership diagnosis.
      if (this.now() < deadline) throw error
    } finally {
      observation.abort()
    }
  }

  private async interruptDetached(
    processes: ProcessPort,
    targets: readonly LiveProcessInfo[],
    requested: Set<string>,
  ): Promise<readonly LiveProcessInfo[]> {
    // Older fixture/browser ports have no stdin. Current native roots use the
    // same graceful interrupt window as a controller-owned new CLI turn.
    if (!processes.send) return targets
    const outcomes = await Promise.all(
      targets.map(async (target) => {
        if (requested.has(target.id)) return false
        const observation = new AbortController()
        let delivered = false
        try {
          const exited = await requestCliInterrupt({
            processId: target.id,
            send: (id, frame) => processes.send!(id, frame),
            exited: this.observeOriginalExit(processes, target.id, observation.signal),
            onDelivered: () => { delivered = true; requested.add(target.id) },
          })
          if (!exited && delivered) throw new Error('已请求停止，原执行仍在收尾。可以等待；再次停止将强制结束原进程。')
          return exited
        } finally {
          observation.abort()
        }
      }),
    )
    return targets.filter((_target, index) => !outcomes[index])
  }

  private async observeOriginalExit(
    processes: ProcessPort,
    processId: string,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const ids = registeredProcessIds(
        await this.nativeCall(() => processes.list(), NATIVE_WAIT_MS, signal),
      )
      if (signal.aborted) break
      if (!ids.has(processId)) return
      await this.nativeCall(() => this.pause(signal), NATIVE_WAIT_MS, signal)
    }
    // Stopping this observer is not proof of child exit. Its raced promise is
    // still observed by the shared interrupt waiter after timeout or IO failure.
    throw new Error('Detached exit observation ended without an exit receipt.')
  }

  private async assertNoExternalOwner(
    processes: ProcessPort,
    scope: Scope,
    excluded: ReadonlySet<string>,
    exitDeadline?: number,
  ): Promise<void> {
    if (!processes.hasTeamOwner) return
    if (
      excluded.size > 0 &&
      (await this.nativeCall(() => processes.list())).some(
        (process) =>
          excluded.has(process.id) &&
          ROOT_LABELS.has(process.label) &&
          process.metadata.projectKey === scope.projectKey &&
          process.metadata.conversationId === scope.conversationId,
      )
    )
      return
    for (let attempt = 0; attempt <= 100; attempt += 1) {
      if (attempt > 0 && exitDeadline !== undefined && this.now() >= exitDeadline) break
      const owned = await this.nativeCall(
        () => processes.hasTeamOwner!(scope.projectKey, scope.conversationId),
        exitDeadline === undefined ? NATIVE_WAIT_MS : Math.max(1, exitDeadline - this.now()),
      )
      if (typeof owned !== 'boolean') throw new Error('原生团队归属检查失败，未确认空闲。')
      if (!owned) return
      if (exitDeadline === undefined)
        throw new DetachedConversationError(
          '此会话仍有原生团队执行占用，可能位于另一个 Trylo 窗口。请到原窗口停止或稍后重试。',
        )
      // The reaper removes an exited root before draining its last output and
      // dropping the scope lease. Only this Stop's observed original exit may
      // wait for that release, within its existing confirmation budget.
      if (this.now() >= exitDeadline || attempt === 100) break
      await this.pauseBeforeRetry(exitDeadline)
    }
    throw new Error('旧执行已退出，尚未确认原生会话占用释放，请稍后重试停止。')
  }
}
