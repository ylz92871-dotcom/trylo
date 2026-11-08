import { expect, it } from 'vitest'
import { latestUserTurnId, resultMatchesTurn, workReviewForTurn } from './result-review-state'
import type { ChatMessage } from '../components/chat/types'
import type { StoredWorkResult } from '../results/conversation-result-types'

it('uses the same recorded turn identity for both result models', () => {
  const code = { runId: 'code-run', turnId: 'current-turn' }
  const work = { runId: 'work-run', turnId: 'current-turn' }
  for (const run of [code, work]) {
    expect(resultMatchesTurn(run, { turnId: 'current-turn' })).toBe(true)
    expect(resultMatchesTurn(run, { turnId: 'next-turn' })).toBe(false)
  }
  expect(resultMatchesTurn(undefined, { turnId: 'current-turn' })).toBe(false)
  expect(resultMatchesTurn({ runId: 'legacy-run' }, { turnId: 'current-turn' })).toBe(false)
  expect(resultMatchesTurn({ runId: 'legacy-run' }, { runId: 'legacy-run' })).toBe(true)
})

it('takes the latest user turn, ignoring later model and tool messages', () => {
  const messages: ChatMessage[] = [
    { id: 'older', kind: 'text', role: 'user', text: 'first', turnId: 'turn-a', createdAt: 1 },
    { id: 'newer', kind: 'text', role: 'user', text: 'next', turnId: 'turn-b', createdAt: 2 },
    { id: 'reply', kind: 'text', role: 'assistant', text: 'answer', createdAt: 3 },
  ]
  expect(latestUserTurnId(messages)).toBe('turn-b')
  expect(latestUserTurnId([{ ...messages[0]!, turnId: undefined }])).toBe('older')
  expect(latestUserTurnId([])).toBeUndefined()
})

it('keeps historical files accessible without reusing their prior delivery badges', () => {
  const result: StoredWorkResult = {
    latestRun: { runId: 'run', turnId: 'older-turn', startedAt: 1, status: 'completed',
      createdIds: ['report.md'], updatedIds: [], discoveredIds: [] },
    artifacts: [{ id: 'report.md', target: { kind: 'file', relativePath: 'report.md' },
      displayName: 'report.md', artifactKind: 'document', version: 2, firstSeenAt: 1, updatedAt: 2,
      firstRunId: 'run', lastRunId: 'run', lastTurnId: 'older-turn', lastChange: 'created', sources: ['scan'] }],
    artifactCountTotal: 1, truncated: false,
  }
  const historical = workReviewForTurn(result, 'current-turn')
  expect(historical.latestRun).toBeUndefined()
  expect(historical.artifacts).toBe(result.artifacts)
  expect(historical.artifactCountTotal).toBe(1)
  expect(result.latestRun?.createdIds).toEqual(['report.md'])
  expect(workReviewForTurn(result, 'older-turn')).toBe(result)
})
