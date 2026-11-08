import { restoreTeamHistory, type RestoreTeamHistoryInput } from './restored-team-history'
import type { TeamRun } from '../surfaces/team/team-types'
import { isTeamRunOpen } from '../domain/team-run-lifecycle'

export interface WatchRestoredTeamHistoryInput extends RestoreTeamHistoryInput {
  readonly onRestored: (run: TeamRun | null) => void
  readonly onError: (error: unknown) => void
}
const backgroundObservers = new Map<string, () => void>()

/** Renderer teardown releases observers, never the supervised native roots. */
export function disposeRestoredTeamHistoryObservers(): void {
  for (const dispose of backgroundObservers.values()) dispose()
}
if (import.meta.hot) import.meta.hot.dispose(disposeRestoredTeamHistoryObservers)

/** Only disconnected/unknown ownership needs polling; live controllers own their events. */
export function watchRestoredTeamHistory(input: WatchRestoredTeamHistoryInput): () => void {
  let stopped = false
  let background = false
  let disposed = false
  let reading = false
  let firstCheck = true
  let lastPublished: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const key = JSON.stringify([input.workspaceRoot, input.workspaceId, input.conversationId])
  backgroundObservers.get(key)?.()
  const hasOwner = () =>
    input.runtime.hasRecoveredOwner?.(
      input.projectKey ?? input.workspaceRoot,
      input.conversationId,
    ) ?? false
  const current = () => !disposed && (background || (!stopped && (input.isCurrent?.() ?? true)))
  const dispose = () => {
    disposed = true
    clearTimeout(timer)
    if (backgroundObservers.get(key) === dispose) backgroundObservers.delete(key)
  }
  const retainBackground = () => {
    background = true
    backgroundObservers.set(key, dispose)
  }
  const refresh = async (): Promise<void> => {
    if (disposed) return
    reading = true
    let retry = false
    const onChecking = firstCheck ? input.onChecking : undefined
    firstCheck = false
    try {
      const run = await restoreTeamHistory({ ...input, onChecking, isCurrent: current })
      // A pending native read may acquire ownership just after navigation.
      // Its uncommitted output remains queued and is read on the next poll.
      if (!current()) {
        if (stopped && !disposed && hasOwner()) retainBackground()
        else {
          dispose()
          return
        }
      }
      const snapshot = JSON.stringify(run)
      if (!stopped && snapshot !== lastPublished) {
        input.onRestored(run)
        lastPublished = snapshot
      }
      retry =
        run?.recovery?.kind === 'detached' ||
        run?.recovery?.kind === 'unavailable' ||
        hasOwner() ||
        Boolean(
          run &&
          isTeamRunOpen(run) &&
          !input.runtime.hasLocalOwner(
            input.projectKey ?? input.workspaceRoot,
            input.conversationId,
          ),
        )
    } catch (error) {
      if (!current()) {
        dispose()
        return
      }
      input.onError(error)
      retry = true
    } finally {
      reading = false
    }
    // A completed read owns the next timer; slow IPC never accumulates polls.
    if (retry && current())
      timer = setTimeout(() => {
        timer = undefined
        void refresh()
      }, 1000)
    else if (background) dispose()
  }
  backgroundObservers.set(key, dispose)
  void refresh()
  return () => {
    stopped = true
    // Reconnected execution is supervised independently of visible selection.
    // Only its cache/chat sink survives; it cannot replace the new visible team.
    if (!disposed && hasOwner()) retainBackground()
    else if (reading) clearTimeout(timer)
    else dispose()
  }
}
