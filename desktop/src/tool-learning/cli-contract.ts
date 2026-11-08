import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from './cli-status'
import { record, text } from './wire'

export type ToolContractReview = {
  readonly proposalId: string
  readonly revisionId: string
  readonly reviewId: string
  readonly approved: boolean
  readonly proposal: Record<string, unknown>
  readonly changes: readonly Record<string, unknown>[]
  readonly raw: Record<string, unknown>
}
const proposalId = (value: string) => /^tool-contract-proposal_v1_[a-f0-9]{64}$/.test(value)
export async function readToolContract(
  runtime: ToolLearningRuntime,
  id: string,
  signal: AbortSignal,
): Promise<ToolContractReview> {
  if (!proposalId(id)) throw new Error('invalid_contract_proposal')
  const result = await runCliCommand({
    ...runtime,
    args: ['tools', 'contract-show', id, '--json'],
    signal,
  })
  if (!result.ok) throw new Error(result.reason)
  const raw: unknown = JSON.parse(result.stdout)
  if (
    !record(raw) ||
    raw['ok'] !== true ||
    raw['proposalId'] !== id ||
    !text(raw['revisionId'], 512) ||
    !text(raw['reviewId'], 512) ||
    typeof raw['approved'] !== 'boolean' ||
    !record(raw['proposal']) ||
    !Array.isArray(raw['changes']) ||
    !raw['changes'].every(record)
  )
    throw new Error('invalid_contract_review')
  return {
    proposalId: id,
    revisionId: raw['revisionId'],
    reviewId: raw['reviewId'],
    approved: raw['approved'],
    proposal: raw['proposal'],
    changes: raw['changes'],
    raw,
  }
}
/** Called only by the exact-version review button. The CLI owns authorization and continuation. */
export async function approveToolContract(
  runtime: ToolLearningRuntime,
  review: ToolContractReview,
  signal: AbortSignal,
): Promise<void> {
  if (!proposalId(review.proposalId) || !review.reviewId.trim())
    throw new Error('invalid_contract_review')
  const result = await runCliCommand({
    ...runtime,
    args: ['tools', 'contract-approve', review.proposalId, '--approve', review.reviewId, '--json'],
    signal,
    timeoutMs: 30000,
  })
  if (!result.ok) throw new Error(result.reason)
  const raw: unknown = JSON.parse(result.stdout)
  if (!record(raw) || raw['ok'] !== true || raw['revisionId'] !== review.revisionId)
    throw new Error('contract_approval_unconfirmed')
}
