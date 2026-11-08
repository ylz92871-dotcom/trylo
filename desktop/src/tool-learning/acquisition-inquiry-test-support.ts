import type { ToolAcquisitionReview } from './acquisition-contract'
import type { ToolAcquisitionInquiryReview } from './acquisition-inquiry-contract'
import { failedAcquisitionFixture } from './acquisition-test-support'

/** TEST ONLY safe projections; no Board, model result, receipt or grant. */
export function acquisitionInquiryFixture(original: ToolAcquisitionReview = failedAcquisitionFixture(),
  overrides: Partial<ToolAcquisitionInquiryReview> = {}): ToolAcquisitionInquiryReview {
  return { formatVersion: 1, workspaceId: original.workspaceId, jobId: original.jobId, approvalId: original.approvalId,
    failureRef: original.failure!.ref, inquiryJobId: `tool-acquisition-inquiry_v1_${'1'.repeat(64)}`,
    state: 'not_started', attempt: 0, ready: true, reviewId: `acquisition-inquiry-review_v1_${'2'.repeat(64)}`,
    budget: { grantId: 'TEST_ONLY_original_grant', status: 'open', remaining: { calls: 2, tokens: 12000 } },
    action: 'research_existing_task_without_acquisition', next: 'confirm_inquiry', ...overrides }
}
export function committedAcquisitionInquiryFixture(original: ToolAcquisitionReview = failedAcquisitionFixture()): ToolAcquisitionInquiryReview {
  return acquisitionInquiryFixture(original, { state: 'waiting_approval', attempt: 1, ready: false, code: 'inquiry_outcome_committed', next: 'review_new_decision',
    outcome: { status: 'proposed', code: 'acquisition_alternative_proposed', reviewJobId: `tool-learning_v1_${'3'.repeat(64)}`, approvalId: `tool-decision_v1_${'4'.repeat(64)}`,
      proposal: { kind: 'model_strategy_proposal', action: 'acquire', planningDecisionVersionId: `tool-decision_v1_${'5'.repeat(64)}`,
        rationale: 'TEST ONLY · 另一候选可能避开已记录的获取约束。', existingInsufficiency: 'TEST ONLY · 原选择不能按当前获取合同解析。',
        expectedBenefit: 'TEST ONLY · 尚未验证的可获取性与接口匹配假设。', constructionCost: 'TEST ONLY · 新选择仍需单独获取审阅与适配检查。', alternatives: ['TEST ONLY · 保留原方案并等待独立证据。'] } } })
}
export function strategyAcquisitionInquiryFixture(original: ToolAcquisitionReview = failedAcquisitionFixture()): ToolAcquisitionInquiryReview {
  const committed = committedAcquisitionInquiryFixture(original)
  return { ...committed, next: 'inspect_or_wait', outcome: { status: 'proposed', code: 'inquiry_proposal_pending_review',
    proposal: { ...committed.outcome!.proposal!, action: 'refine' } } }
}
