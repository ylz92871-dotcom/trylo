import type { ChatMessage } from '../components/chat/types'
import type { StoredWorkResult } from '../results/conversation-result-types'

export function latestUserTurnId(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind === 'text' && message.role === 'user') return message.turnId ?? message.id
  }
  return undefined
}

/** Presentation attribution only; a background run keeps its original owner. */
export function resultMatchesTurn(
  run: { readonly runId: string; readonly turnId?: string } | undefined,
  expected: { readonly runId?: string; readonly turnId?: string } = {},
): boolean {
  if (!run) return false
  if (expected.runId) return run.runId === expected.runId
  return expected.turnId ? run.turnId === expected.turnId : true
}

/** History stays available in the rail without claiming a new turn produced it. */
export function workReviewForTurn(result: StoredWorkResult, turnId: string | undefined): StoredWorkResult {
  return turnId && resultMatchesTurn(result.latestRun, { turnId })
    ? result
    : { ...result, latestRun: undefined }
}
