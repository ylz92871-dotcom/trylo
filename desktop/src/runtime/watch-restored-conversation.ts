import type { ConversationOutputRecovery } from './recovered-team-output'
import type { PersistedRecoveryRun } from './recovery-output-selection'

export interface RestoredConversationRuntime {
  subscribe(listener: () => void): () => void
  hasLocalOwner(projectKey: string, conversationId: string): boolean
  hasRecoveredOwner(projectKey: string, conversationId: string): boolean
  hasRecoveredConversationOwner(projectKey: string, conversationId: string): boolean
  recoverConversationOutput(
    projectKey: string,
    conversationId: string,
    turnIds: readonly string[],
    expectedRun?: PersistedRecoveryRun,
  ): Promise<ConversationOutputRecovery | null>
  inspectRestoredOwner(
    projectKey: string,
    conversationId: string,
  ): Promise<'owned' | 'absent' | 'detached'>
}
export interface WatchRestoredConversationInput {
  readonly projectKey: string
  readonly conversationId: string
  readonly runtime: RestoredConversationRuntime
  readonly turnIds: () => readonly string[]
  readonly expectedRun?: () => PersistedRecoveryRun | undefined
  readonly onRecovered: (receipt: ConversationOutputRecovery) => void | Promise<void>
  readonly onError: (error: unknown) => void
  readonly onReady?: () => void
}

const observers = new Map<string, () => void>()

/** Release renderer observers only; native roots keep their execution owner. */
export function disposeRestoredConversationObservers(): void {
  for (const dispose of observers.values()) dispose()
}
if (import.meta.hot) import.meta.hot.dispose(disposeRestoredConversationObservers)

/** Observe native output only: no prompt replay, cancellation, or learned authority. */
export function watchRestoredConversation(input: WatchRestoredConversationInput): () => void {
  if (!input.conversationId) return () => {}
  const key = JSON.stringify([input.projectKey, input.conversationId])
  observers.get(key)?.()
  let disposed = false
  let detached = false
  let reading = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastError: string | undefined
  let localOwner = input.runtime.hasLocalOwner(input.projectKey, input.conversationId)
  let unsubscribe: () => void = () => {}
  const dispose = (): void => {
    disposed = true
    clearTimeout(timer)
    unsubscribe()
    if (observers.get(key) === dispose) observers.delete(key)
  }
  const hasOwner = () =>
    input.runtime.hasRecoveredConversationOwner(input.projectKey, input.conversationId)
  const schedule = (delay: number): void => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, delay)
  }
  const refresh = async (): Promise<void> => {
    if (disposed || reading) return
    if (input.runtime.hasLocalOwner(input.projectKey, input.conversationId)) return
    if (input.runtime.hasRecoveredOwner(input.projectKey, input.conversationId) && !hasOwner())
      return
    reading = true
    let retry = false
    try {
      const receipt = await input.runtime.recoverConversationOutput(
        input.projectKey,
        input.conversationId,
        input.turnIds(),
        input.expectedRun?.(),
      )
      if (disposed) return
      if (input.runtime.hasLocalOwner(input.projectKey, input.conversationId)) return
      if (receipt) {
        if (!input.turnIds().includes(receipt.process.identity.turnId))
          throw new Error('原执行对应的提问尚未载入，输出已保留，正在等待会话历史恢复。')
        await input.onRecovered(receipt)
        if (disposed) return
        receipt.acknowledge()
        retry = receipt.live
      } else {
        retry =
          (await input.runtime.inspectRestoredOwner(input.projectKey, input.conversationId)) ===
          'detached'
      }
      lastError = undefined
      input.onReady?.()
    } catch (error) {
      if (disposed) return
      retry = true
      // A failed retained read is not evidence of exit. Keep the existing
      // process guard as the single owner of the uncertain native fact.
      try {
        await input.runtime.inspectRestoredOwner(input.projectKey, input.conversationId)
      } catch {
        /* The native ownership owner retains the typed failure. */
      }
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) {
        lastError = message
        try {
          input.onError(error)
        } catch {
          /* Native ownership remains retained even if its view callback fails. */
        }
      }
    } finally {
      reading = false
      if (!disposed && (retry || hasOwner())) schedule(1000)
      else if (detached) dispose()
    }
  }
  unsubscribe = input.runtime.subscribe(() => {
    const hadLocalOwner = localOwner
    localOwner = input.runtime.hasLocalOwner(input.projectKey, input.conversationId)
    // Global controller activity cannot reconnect an unrelated idle chat.
    // A local owner releasing this scope still wakes its retained-output reader.
    if (!reading && !localOwner && (hadLocalOwner || hasOwner())) schedule(0)
  })
  observers.set(key, dispose)
  void refresh()
  return () => {
    // Navigation can remove the visible panel while this scoped sink still
    // owns a live recovered root. A later observer replaces it by exact key.
    detached = true
    if (!disposed && !reading && !hasOwner()) dispose()
  }
}
