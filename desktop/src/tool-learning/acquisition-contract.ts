import { count, productionVersion, record, text, wireJson } from './wire'
import type { ToolJobState } from './cli-status'
import { acquisitionFailure, copyAcquisitionFailure, type ToolAcquisitionFailureView } from './acquisition-failure'

export type ToolAcquisitionContinuation = {
  readonly jobId: string
  readonly state: ToolJobState
  readonly attempt: number
  readonly code?: string
  readonly versionId?: string
  readonly recovery?: 'committed_candidate'
}
export type ToolAcquisitionProgress = {
  readonly approvalId: string
  readonly installationId?: string
  readonly installed?: boolean
  readonly continuation?: ToolAcquisitionContinuation
  readonly failure?: ToolAcquisitionFailureView
}
export type ToolAcquisitionReview = {
  readonly formatVersion: 1
  readonly workspaceId: string
  readonly jobId: string
  readonly approvalId: string
  readonly capability: string
  readonly candidate: {
    readonly platform: string
    readonly id: string
    readonly version: string
    readonly sourceUrl: string
    readonly licenseSpdx: string
  }
  readonly rationale: string
  readonly existingInsufficiency: string
  readonly expectedBenefit: string
  readonly constructionCost: string
  readonly alternatives: readonly string[]
  readonly adaptation: string
  readonly installation?: {
    readonly installationId: string
    readonly packageCount: number
    readonly installed?: boolean
  }
  readonly continuation?: ToolAcquisitionContinuation
  readonly failure?: ToolAcquisitionFailureView
  readonly action: 'resolve_download_install_and_prepare_immutable_adaptation'
  readonly next: 'authorize_or_resume_acquisition' | 'production_verify_then_explicit_activation'
}
export type AcquisitionLoad<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
const states = new Set(['queued', 'running', 'waiting_approval', 'waiting_evidence', 'succeeded', 'failed', 'cancelled', 'expired'])
const identity = (raw: unknown, prefix: string): raw is string => typeof raw === 'string' && new RegExp(`^${prefix}_v1_[a-f0-9]{64}$`).test(raw)
export const acquisitionJobId = (raw: unknown): raw is string => identity(raw, 'tool-learning')
export const acquisitionApprovalId = (raw: unknown): raw is string => identity(raw, 'tool-decision')
export const acquisitionInstallationId = (raw: unknown): raw is string => identity(raw, 'npm-install')

export function acquisitionContinuation(raw: unknown): raw is ToolAcquisitionContinuation {
  return record(raw) && identity(raw['jobId'], 'tool-adaptation') && text(raw['state'], 32) && states.has(raw['state'])
    && count(raw['attempt'], 3) && (raw['attempt'] > 0 || raw['state'] === 'queued')
    && (raw['code'] === undefined || text(raw['code'], 160))
    && (raw['versionId'] === undefined || productionVersion(raw['versionId']))
    && (raw['recovery'] === undefined || (raw['recovery'] === 'committed_candidate' && raw['state'] === 'running' && productionVersion(raw['versionId'])))
}
export function acquisitionProgress(raw: unknown): raw is ToolAcquisitionProgress {
  return record(raw) && acquisitionApprovalId(raw['approvalId'])
    && (raw['installationId'] === undefined || acquisitionInstallationId(raw['installationId']))
    && (raw['installed'] === undefined || (typeof raw['installed'] === 'boolean' && acquisitionInstallationId(raw['installationId'])))
    && (raw['continuation'] === undefined || (acquisitionInstallationId(raw['installationId']) && acquisitionContinuation(raw['continuation'])))
    && (raw['failure'] === undefined || acquisitionFailure(raw['failure']))
}
export function copyAcquisitionProgress(raw: ToolAcquisitionProgress): ToolAcquisitionProgress {
  return { approvalId: raw.approvalId, ...(raw.installationId === undefined ? {} : { installationId: raw.installationId }),
    ...(raw.installed === undefined ? {} : { installed: raw.installed }), ...(raw.continuation === undefined ? {} : { continuation: raw.continuation }),
    ...(raw.failure === undefined ? {} : { failure: copyAcquisitionFailure(raw.failure) }) }
}

export function parseToolAcquisitionReview(stdout: string, jobId: string, workspaceId: string): AcquisitionLoad<ToolAcquisitionReview> {
  const raw = wireJson(stdout)
  if (!record(raw) || raw['ok'] !== true || raw['formatVersion'] !== 1 || raw['jobId'] !== jobId || !acquisitionJobId(raw['jobId'])
    || raw['workspaceId'] !== workspaceId || !text(raw['workspaceId'], 512) || !acquisitionApprovalId(raw['approvalId'])
    || !text(raw['capability'], 2048) || !record(raw['candidate'])
    || !text(raw['candidate']['platform'], 64) || !text(raw['candidate']['id'], 256) || !text(raw['candidate']['version'], 256)
    || !text(raw['candidate']['sourceUrl'], 2048) || !text(raw['candidate']['licenseSpdx'], 128)
    || !text(raw['rationale'], 2048) || !text(raw['existingInsufficiency'], 2048) || !text(raw['expectedBenefit'], 2048)
    || !text(raw['constructionCost'], 2048) || !text(raw['adaptation'], 4096)
    || !Array.isArray(raw['alternatives']) || raw['alternatives'].length > 8 || !raw['alternatives'].every(value => text(value, 2048))
    || raw['action'] !== 'resolve_download_install_and_prepare_immutable_adaptation'
    || !['authorize_or_resume_acquisition', 'production_verify_then_explicit_activation'].includes(String(raw['next']))
    || (raw['installation'] !== undefined && (!record(raw['installation']) || !acquisitionInstallationId(raw['installation']['installationId'])
      || !count(raw['installation']['packageCount'], 4096) || raw['installation']['packageCount'] < 1
      || (raw['installation']['installed'] !== undefined && typeof raw['installation']['installed'] !== 'boolean')))
    || (raw['continuation'] !== undefined && (raw['installation'] === undefined || !acquisitionContinuation(raw['continuation'])))) {
    return { ok: false, reason: 'invalid_acquisition_review' }
  }
  if (raw['failure'] !== undefined && !acquisitionFailure(raw['failure'])) return { ok: false, reason: 'invalid_acquisition_failure' }
  if ((raw['next'] === 'production_verify_then_explicit_activation') !== (raw['continuation']?.versionId !== undefined)) {
    return { ok: false, reason: 'invalid_acquisition_progress' }
  }
  // Copy only the review projection, so additional CLI diagnostics/source dumps never enter UI state.
  const candidate = raw['candidate']
  return { ok: true, value: {
    formatVersion: 1, workspaceId, jobId, approvalId: raw['approvalId'], capability: raw['capability'],
    candidate: { platform: candidate['platform'] as string, id: candidate['id'] as string, version: candidate['version'] as string,
      sourceUrl: candidate['sourceUrl'] as string, licenseSpdx: candidate['licenseSpdx'] as string },
    rationale: raw['rationale'], existingInsufficiency: raw['existingInsufficiency'], expectedBenefit: raw['expectedBenefit'],
    constructionCost: raw['constructionCost'], alternatives: raw['alternatives'] as string[], adaptation: raw['adaptation'],
    ...(raw['failure'] === undefined ? {} : { failure: copyAcquisitionFailure(raw['failure']) }),
    ...(raw['installation'] === undefined ? {} : { installation: { installationId: raw['installation']['installationId'] as string,
      packageCount: raw['installation']['packageCount'] as number, ...(raw['installation']['installed'] === undefined ? {} : { installed: raw['installation']['installed'] as boolean }) } }),
    ...(raw['continuation'] === undefined ? {} : { continuation: { jobId: raw['continuation'].jobId, state: raw['continuation'].state,
      attempt: raw['continuation'].attempt, ...(raw['continuation'].code === undefined ? {} : { code: raw['continuation'].code }),
      ...(raw['continuation'].versionId === undefined ? {} : { versionId: raw['continuation'].versionId }),
      ...(raw['continuation'].recovery === undefined ? {} : { recovery: raw['continuation'].recovery }) } }),
    action: 'resolve_download_install_and_prepare_immutable_adaptation', next: raw['next'] as ToolAcquisitionReview['next'],
  } }
}
