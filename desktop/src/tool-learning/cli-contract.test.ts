import { afterEach, describe, expect, it, vi } from 'vitest'
import { approveToolContract, readToolContract } from './cli-contract'
import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from './cli-status'

vi.mock('../host-adapter/cli-command', () => ({ runCliCommand: vi.fn() }))
afterEach(() => {
  vi.resetAllMocks()
})

describe('tool contract exact-review transport', () => {
  it('authorizes the exact read reviewId and rejects an unconfirmed revision without activating the candidate', async () => {
    const id = 'tool-contract-proposal_v1_' + 'a'.repeat(64)
    const runtime = { cwd: 'D:/reports', cliPath: 'cli.mjs', process: {} } as ToolLearningRuntime
    const signal = new AbortController().signal
    vi.mocked(runCliCommand).mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        proposalId: id,
        revisionId: 'revision-7',
        reviewId: 'review-read-7',
        approved: false,
        proposal: { parentVersionId: 'candidate-v1' },
        changes: [],
      }),
    } as never)
    const review = await readToolContract(runtime, id, signal)
    const frozen = structuredClone(review)
    vi.mocked(runCliCommand).mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({ ok: true, revisionId: 'revision-7' }),
    } as never)
    await approveToolContract(runtime, review, signal)

    expect(runCliCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ['tools', 'contract-approve', id, '--approve', 'review-read-7', '--json'],
        signal,
      }),
    )
    expect(review).toEqual(frozen)
    expect(vi.mocked(runCliCommand).mock.calls.flatMap(([input]) => input.args)).not.toContain(
      'production-activate',
    )
    vi.mocked(runCliCommand).mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify({ ok: true, revisionId: 'other-revision' }),
    } as never)
    await expect(approveToolContract(runtime, review, signal)).rejects.toThrow(
      'contract_approval_unconfirmed',
    )
  })
})
