import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from './cli-status'
import { acquisitionApprovalId, acquisitionJobId, parseToolAcquisitionReview, type AcquisitionLoad, type ToolAcquisitionReview } from './acquisition-contract'
import { productionVersion, record, text, wireJson } from './wire'

export { parseToolAcquisitionReview } from './acquisition-contract'
export type { ToolAcquisitionReview } from './acquisition-contract'

function failureCode(stdout: string | undefined, fallback: string): string {
  const raw = wireJson(stdout ?? '')
  const code = record(raw) && raw['ok'] === false && text(raw['code'], 160) ? raw['code'] : fallback.split(':', 1)[0]
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,159}$/.test(code) ? code : 'acquisition_cli_unavailable'
}
export async function loadToolAcquisitionReview(
  runtime: ToolLearningRuntime, jobId: string, workspaceId: string, signal: AbortSignal,
): Promise<AcquisitionLoad<ToolAcquisitionReview>> {
  if (!acquisitionJobId(jobId) || !text(workspaceId, 512)) return { ok: false, reason: 'invalid_acquisition_request' }
  const result = await runCliCommand({ ...runtime, args: ['tools', 'acquire-learning', jobId, '--json'], signal })
  return result.ok ? parseToolAcquisitionReview(result.stdout, jobId, workspaceId)
    : { ok: false, reason: failureCode(result.stdout, result.reason) }
}

/** One explicit gesture submits one frozen decision. A timeout is not a safe retry signal. */
export async function approveToolAcquisition(
  runtime: ToolLearningRuntime, review: ToolAcquisitionReview, signal: AbortSignal,
): Promise<AcquisitionLoad<{ readonly versionId: string }>> {
  if (!acquisitionJobId(review.jobId) || !acquisitionApprovalId(review.approvalId) || review.candidate.platform !== 'npm'
    || review.action !== 'resolve_download_install_and_prepare_immutable_adaptation') return { ok: false, reason: 'invalid_acquisition_approval' }
  if (runtime.lifecycle?.canStart === undefined || runtime.lifecycle.starting === undefined) return { ok: false, reason: 'acquisition_process_owner_required' }
  if (runtime.lifecycle.canStart?.() === false) return { ok: false, reason: 'stop_unconfirmed' }
  if (review.installation?.installed !== true && review.continuation === undefined && review.failure?.recovery !== undefined
    && review.failure.recovery !== 'retry_explicitly') return { ok: false, reason: review.failure.recovery === 'await_stop' ? 'stop_unconfirmed' : 'acquisition_requires_investigation' }
  const args = ['tools', 'acquire-learning', review.jobId, '--approve', review.approvalId, '--json']
  if (review.installation?.installed === true && review.continuation !== undefined) args.push('--resume-child', review.continuation.jobId)
  const result = await runCliCommand({ ...runtime, args, signal, timeoutMs: 300_000 })
  if (!result.ok) return { ok: false, reason: failureCode(result.stdout, result.reason) }
  const raw = wireJson(result.stdout)
  return record(raw) && raw['ok'] === true && productionVersion(raw['versionId'])
    ? { ok: true, value: { versionId: raw['versionId'] } }
    : { ok: false, reason: failureCode(result.stdout, 'acquisition_result_unconfirmed') }
}
