import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from './cli-status'
import { acquisitionApprovalId, acquisitionJobId, type AcquisitionLoad, type ToolAcquisitionReview } from './acquisition-contract'
import { parseToolAcquisitionInquiryReview, type ToolAcquisitionInquiryReview } from './acquisition-inquiry-contract'
import { record, text, wireJson } from './wire'

export async function loadToolAcquisitionInquiry(runtime: ToolLearningRuntime, original: ToolAcquisitionReview, signal: AbortSignal): Promise<AcquisitionLoad<ToolAcquisitionInquiryReview>> {
  if (!validOriginal(original)) return { ok: false, reason: 'invalid_acquisition_inquiry_request' }
  const result = await runCliCommand({ ...runtime, args: readArgs(original), signal })
  return result.ok ? parseToolAcquisitionInquiryReview(result.stdout, original) : { ok: false, reason: failure(result.stdout, result.reason) }
}

/** An explicit click confirms this exact read snapshot. It does not acquire,
 * execute source, grant shell access or approve the resulting new decision. */
export async function confirmToolAcquisitionInquiry(runtime: ToolLearningRuntime, original: ToolAcquisitionReview,
  review: ToolAcquisitionInquiryReview, signal: AbortSignal, mode: 'start' | 'recover' = 'start'): Promise<AcquisitionLoad<{ readonly requestFinished: true }>> {
  if (!validOriginal(original)) return { ok: false, reason: 'invalid_acquisition_inquiry_request' }
  const parsed = parseToolAcquisitionInquiryReview(JSON.stringify({ ok: true, ...review }), original)
  if (!parsed.ok) return parsed
  const exact = parsed.value
  const confirmation = mode === 'start' ? exact.ready || exact.outcome !== undefined ? exact.reviewId : undefined
    : exact.state === 'running' && exact.recovery?.recoverable ? exact.recovery.reviewId : undefined
  if (confirmation === undefined) return { ok: false, reason: 'acquisition_inquiry_not_ready' }
  if (runtime.lifecycle?.canStart === undefined || runtime.lifecycle.starting === undefined) return { ok: false, reason: 'acquisition_process_owner_required' }
  if (!runtime.lifecycle.canStart()) return { ok: false, reason: 'stop_unconfirmed' }
  const args = [...readArgs(original), '--approve', original.approvalId,
    mode === 'start' ? '--confirm-inquiry' : '--confirm-inquiry-recovery', confirmation]
  const result = await runCliCommand({ ...runtime, args, signal, timeoutMs: 300_000 })
  if (!result.ok) return { ok: false, reason: failure(result.stdout, result.reason) }
  const raw = wireJson(result.stdout)
  return record(raw) && raw['ok'] === true ? { ok: true, value: { requestFinished: true } }
    : { ok: false, reason: failure(result.stdout, 'acquisition_inquiry_result_unconfirmed') }
}
function validOriginal(review: ToolAcquisitionReview): boolean {
  return acquisitionJobId(review.jobId) && acquisitionApprovalId(review.approvalId) && text(review.workspaceId, 512)
    && typeof review.failure?.ref === 'string' && /^tool-acquisition-failure_v1_[a-f0-9]{64}$/.test(review.failure.ref)
}
function readArgs(review: ToolAcquisitionReview): string[] { return ['tools', 'acquire-learning', review.jobId, '--reinvestigate-failure', review.failure!.ref, '--json'] }
function failure(stdout: string | undefined, fallback: string): string {
  const raw = wireJson(stdout ?? ''), code = record(raw) && raw['ok'] === false && text(raw['code'], 160) ? raw['code'] : fallback.split(':', 1)[0]
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,159}$/.test(code) ? code : 'acquisition_inquiry_unavailable'
}
