import { acquisitionApprovalId, acquisitionJobId, type AcquisitionLoad, type ToolAcquisitionReview } from './acquisition-contract'
import { count, record, text, wireJson } from './wire'

export type ToolAcquisitionInquiryProposal = {
  readonly kind: 'model_strategy_proposal'
  readonly action: 'reuse' | 'refine' | 'defer' | 'research' | 'adapt' | 'revise_contract' | 'create' | 'improve' | 'compose' | 'acquire'
  readonly planningDecisionVersionId: string
  readonly rationale: string
  readonly existingInsufficiency: string
  readonly expectedBenefit: string
  readonly constructionCost: string
  readonly alternatives: readonly string[]
}
export type ToolAcquisitionInquiryReview = {
  readonly formatVersion: 1
  readonly workspaceId: string
  readonly jobId: string
  readonly approvalId: string
  readonly failureRef: string
  readonly inquiryJobId: string
  readonly state: 'not_started' | 'queued' | 'running' | 'waiting_approval' | 'waiting_evidence' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  readonly attempt: number
  readonly ready: boolean
  readonly reviewId?: string
  readonly code?: string
  readonly budget: { readonly grantId: string; readonly status: 'open' | 'closed' | 'not_funded'; readonly remaining?: { readonly calls: number; readonly tokens: number } }
  readonly outcome?: { readonly status: 'proposed' | 'waiting_evidence'; readonly code: string; readonly reviewJobId?: string; readonly approvalId?: string; readonly proposal?: ToolAcquisitionInquiryProposal }
  readonly recovery?: { readonly recoverable: boolean; readonly attempt: number; readonly expiresAt?: string; readonly reviewId?: string }
  readonly action: 'research_existing_task_without_acquisition'
  readonly next: 'confirm_inquiry' | 'review_new_decision' | 'inspect_or_wait'
}
const states = new Set(['not_started', 'queued', 'running', 'waiting_approval', 'waiting_evidence', 'succeeded', 'failed', 'cancelled', 'expired'])
const stableCode = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-z][a-z0-9_]{0,159}$/.test(raw)
export const acquisitionInquiryReviewId = (raw: unknown): raw is string => typeof raw === 'string' && /^acquisition-inquiry-review_v1_[a-f0-9]{64}$/.test(raw)
const inquiryJobId = (raw: unknown): raw is string => typeof raw === 'string' && /^tool-acquisition-inquiry_v1_[a-f0-9]{64}$/.test(raw)

/** Copy only the safe review projection, bound to this exact original decision
 * and failure. Provider diagnostics, snapshots and source text stay outside UI. */
export function parseToolAcquisitionInquiryReview(stdout: string, original: ToolAcquisitionReview): AcquisitionLoad<ToolAcquisitionInquiryReview> {
  const raw = wireJson(stdout)
  if (!record(raw) || raw['ok'] !== true || raw['formatVersion'] !== 1 || raw['workspaceId'] !== original.workspaceId
    || raw['jobId'] !== original.jobId || !acquisitionJobId(raw['jobId']) || raw['approvalId'] !== original.approvalId
    || !acquisitionApprovalId(raw['approvalId']) || raw['failureRef'] !== original.failure?.ref || !text(raw['failureRef'], 160)
    || !/^tool-acquisition-failure_v1_[a-f0-9]{64}$/.test(raw['failureRef']) || !inquiryJobId(raw['inquiryJobId'])
    || !text(raw['state'], 32) || !states.has(raw['state']) || !count(raw['attempt'], 3) || typeof raw['ready'] !== 'boolean'
    || (raw['state'] === 'not_started' && raw['attempt'] !== 0) || (raw['state'] === 'running' && raw['attempt'] === 0)
    || raw['action'] !== 'research_existing_task_without_acquisition' || !['confirm_inquiry', 'review_new_decision', 'inspect_or_wait'].includes(String(raw['next']))
    || (raw['reviewId'] !== undefined && !acquisitionInquiryReviewId(raw['reviewId'])) || (raw['code'] !== undefined && !stableCode(raw['code']))
    || !record(raw['budget']) || !text(raw['budget']['grantId'], 256) || !['open', 'closed', 'not_funded'].includes(String(raw['budget']['status']))) return invalid()
  const budget = raw['budget'], remaining = budget['remaining'], outcome = raw['outcome'], recovery = raw['recovery']
  const proposal = record(outcome) && outcome['proposal'] !== undefined ? copyProposal(outcome['proposal']) : undefined
  if (record(outcome) && outcome['proposal'] !== undefined && proposal === undefined) return invalid()
  if (remaining !== undefined && (!record(remaining) || !count(remaining['calls'], Number.MAX_SAFE_INTEGER) || !count(remaining['tokens'], Number.MAX_SAFE_INTEGER))) return invalid()
  if (raw['ready'] && (!acquisitionInquiryReviewId(raw['reviewId']) || raw['code'] !== undefined || raw['state'] === 'running'
    || raw['next'] !== 'confirm_inquiry' || budget['status'] !== 'open' || !record(remaining) || !Number(remaining['calls']) || !Number(remaining['tokens']))) return invalid()
  if (!raw['ready'] && ((raw['reviewId'] !== undefined && outcome === undefined) || raw['next'] === 'confirm_inquiry')) return invalid()
  if (outcome !== undefined && (!record(outcome) || !['proposed', 'waiting_evidence'].includes(String(outcome['status'])) || !stableCode(outcome['code'])
    || (outcome['reviewJobId'] !== undefined && !acquisitionJobId(outcome['reviewJobId']))
    || (outcome['approvalId'] !== undefined && !acquisitionApprovalId(outcome['approvalId']))
    || ((outcome['reviewJobId'] === undefined) !== (outcome['approvalId'] === undefined)))) return invalid()
  if (record(outcome) && outcome['status'] === 'proposed') {
    if (proposal === undefined || proposal.action === 'acquire') {
      if (!acquisitionJobId(outcome['reviewJobId']) || !acquisitionApprovalId(outcome['approvalId']) || raw['next'] !== 'review_new_decision') return invalid()
    } else if (outcome['reviewJobId'] !== undefined || outcome['approvalId'] !== undefined || raw['next'] !== 'inspect_or_wait') return invalid()
  }
  if (raw['next'] === 'review_new_decision' && (!record(outcome) || outcome['status'] !== 'proposed')) return invalid()
  if (outcome !== undefined && !acquisitionInquiryReviewId(raw['reviewId'])) return invalid()
  if (recovery !== undefined && (!record(recovery) || raw['state'] !== 'running' || typeof recovery['recoverable'] !== 'boolean'
    || recovery['attempt'] !== raw['attempt'] || (recovery['expiresAt'] !== undefined && (!text(recovery['expiresAt'], 64) || !Number.isFinite(Date.parse(recovery['expiresAt']))))
    || (recovery['reviewId'] !== undefined && !acquisitionInquiryReviewId(recovery['reviewId']))
    || (recovery['recoverable'] && (!acquisitionInquiryReviewId(recovery['reviewId']) || !text(recovery['expiresAt'], 64)))
    || (!recovery['recoverable'] && recovery['reviewId'] !== undefined))) return invalid()
  return { ok: true, value: { formatVersion: 1, workspaceId: original.workspaceId, jobId: original.jobId, approvalId: original.approvalId,
    failureRef: raw['failureRef'], inquiryJobId: raw['inquiryJobId'], state: raw['state'] as ToolAcquisitionInquiryReview['state'], attempt: raw['attempt'], ready: raw['ready'],
    ...(raw['reviewId'] === undefined ? {} : { reviewId: raw['reviewId'] }), ...(raw['code'] === undefined ? {} : { code: raw['code'] }),
    budget: { grantId: budget['grantId'] as string, status: budget['status'] as ToolAcquisitionInquiryReview['budget']['status'],
      ...(remaining === undefined ? {} : { remaining: { calls: (remaining as Record<string, number>)['calls']!, tokens: (remaining as Record<string, number>)['tokens']! } }) },
    ...(outcome === undefined ? {} : { outcome: { status: (outcome as Record<string, string>)['status'] as 'proposed' | 'waiting_evidence', code: (outcome as Record<string, string>)['code']!,
      ...(proposal === undefined ? {} : { proposal }),
      ...((outcome as Record<string, string>)['reviewJobId'] === undefined ? {} : { reviewJobId: (outcome as Record<string, string>)['reviewJobId']! }),
      ...((outcome as Record<string, string>)['approvalId'] === undefined ? {} : { approvalId: (outcome as Record<string, string>)['approvalId']! }) } }),
    ...(recovery === undefined ? {} : { recovery: { recoverable: (recovery as Record<string, unknown>)['recoverable'] as boolean, attempt: raw['attempt'],
      ...((recovery as Record<string, unknown>)['expiresAt'] === undefined ? {} : { expiresAt: (recovery as Record<string, string>)['expiresAt']! }),
      ...((recovery as Record<string, unknown>)['reviewId'] === undefined ? {} : { reviewId: (recovery as Record<string, string>)['reviewId']! }) } }),
    action: 'research_existing_task_without_acquisition', next: raw['next'] as ToolAcquisitionInquiryReview['next'] } }
}
function copyProposal(raw: unknown): ToolAcquisitionInquiryProposal | undefined {
  if (!record(raw) || raw['kind'] !== 'model_strategy_proposal' || !text(raw['action'], 32)
    || !['reuse', 'refine', 'defer', 'research', 'adapt', 'revise_contract', 'create', 'improve', 'compose', 'acquire'].includes(raw['action'])
    || !acquisitionApprovalId(raw['planningDecisionVersionId']) || !text(raw['rationale'], 2048) || !text(raw['existingInsufficiency'], 2048)
    || !text(raw['expectedBenefit'], 2048) || !text(raw['constructionCost'], 2048) || !Array.isArray(raw['alternatives'])
    || raw['alternatives'].length > 8 || !raw['alternatives'].every(value => text(value, 2048))) return undefined
  return { kind: 'model_strategy_proposal', action: raw['action'] as ToolAcquisitionInquiryProposal['action'],
    planningDecisionVersionId: raw['planningDecisionVersionId'], rationale: raw['rationale'], existingInsufficiency: raw['existingInsufficiency'],
    expectedBenefit: raw['expectedBenefit'], constructionCost: raw['constructionCost'], alternatives: [...raw['alternatives']] as string[] }
}
function invalid(): AcquisitionLoad<never> { return { ok: false, reason: 'invalid_acquisition_inquiry_review' } }
