import { record, text, count, digest, productionVersion, wireJson } from './wire'

export type ProductionSummary = {
  readonly versionId: string
  readonly identity: string
  readonly description: string
  readonly lifecycle: string
  readonly profile: 'confined_json_function_v1' | 'confined_npm_cli_v1' | 'confined_npm_mcp_v1'
  readonly packageName: string
  readonly packageVersion: string
  readonly license: string
  readonly dependencyCount: number
  readonly checkState?: string
  readonly checkJobId?: string
  readonly current?: {
    readonly versionId: string
    readonly pointer: string
    readonly generation: number
    readonly previousVersionId?: string
  }
  readonly uses: {
    readonly total: number
    readonly returned: number
    readonly quality: 'unverified'
  }
}
export type ProductionSource = {
  readonly name: string
  readonly version: string
  readonly license: string
} & (
  | {
      readonly origin: 'generated_candidate'
      readonly sourceVersionId: string
      readonly contentHash: string
    }
  | {
      readonly origin: 'reviewed_npm_archive'
      readonly location: string
      readonly upstreamUrl: string
      readonly sourceRevision: string
      readonly archiveSha256: string
      readonly licenses: readonly { readonly path: string; readonly sha256: string }[]
    }
)
export type ProductionDetail = ProductionSummary & {
  readonly formatVersion: 1
  readonly workspaceId: string
  readonly boardSequence: number
  readonly capability: string
  readonly mastery: {
    readonly whenToUse: readonly string[]
    readonly preconditions: readonly string[]
    readonly pitfalls: readonly string[]
  }
  readonly source: readonly ProductionSource[]
  readonly permissions: readonly never[]
  readonly timeoutMs: number
  readonly review:
    | { readonly status: 'available'; readonly reviewId: string; readonly receiptId: string }
    | { readonly status: 'unavailable'; readonly code: string }
  readonly report: null | {
    readonly jobId: string
    readonly verdict: 'pass' | 'fail'
    readonly stages: readonly {
      readonly stage: string
      readonly passed: boolean
      readonly detail: string
    }[]
  }
}
export type ProductionList = {
  readonly formatVersion: 1
  readonly workspaceId: string
  readonly boardSequence: number
  readonly items: readonly ProductionSummary[]
  readonly total: number
  readonly truncated: boolean
}
export type ProductionLoad<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
export const STAGES = [
  'source_license_provenance',
  'archive_path_manifest_schema',
  'static_secret_malware_api',
  'type_build_unit',
  'sandbox_smoke',
  'permission_malicious_bounds',
  'cancel_timeout_crash',
  'idempotency_side_effects',
  'baseline_regression',
  'independent_verdict',
]
const lifecycles = new Set([
  'draft',
  'quarantined',
  'evaluating',
  'shadow',
  'awaiting_approval',
  'validated',
  'active',
  'rejected',
  'suspended',
  'rolled_back',
  'retired',
])
const pointers = new Set(['active', 'shadow', 'suspended', 'rolled_back', 'retired'])
const profiles = new Set([
  'confined_json_function_v1',
  'confined_npm_cli_v1',
  'confined_npm_mcp_v1',
])
const jobStates = new Set([
  'queued',
  'running',
  'waiting_approval',
  'waiting_evidence',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
])
const strings = (raw: unknown) =>
  Array.isArray(raw) && raw.length <= 32 && raw.every((item) => text(item, 2048))
export const reviewId = (raw: unknown): raw is string =>
  typeof raw === 'string' && /^production-review_v1_[a-f0-9]{64}$/.test(raw)

function summary(raw: unknown): raw is ProductionSummary & Record<string, unknown> {
  if (
    !record(raw) ||
    !productionVersion(raw['versionId']) ||
    !text(raw['identity'], 128) ||
    !text(raw['description'], 4096) ||
    !text(raw['lifecycle'], 32) ||
    !lifecycles.has(raw['lifecycle']) ||
    !text(raw['profile'], 48) ||
    !profiles.has(raw['profile']) ||
    !text(raw['packageName'], 200) ||
    !text(raw['packageVersion'], 100) ||
    !text(raw['license'], 80) ||
    !count(raw['dependencyCount'], 127) ||
    !record(raw['uses']) ||
    !count(raw['uses']['total'], 4096) ||
    !count(raw['uses']['returned'], raw['uses']['total']) ||
    raw['uses']['quality'] !== 'unverified' ||
    (raw['checkState'] !== undefined &&
      (!text(raw['checkState'], 32) ||
        !jobStates.has(raw['checkState']) ||
        !text(raw['checkJobId'], 256)))
  )
    return false
  const current = raw['current']
  return (
    current === undefined ||
    (record(current) &&
      productionVersion(current['versionId']) &&
      count(current['generation'], Number.MAX_SAFE_INTEGER) &&
      text(current['pointer'], 32) &&
      pointers.has(current['pointer']) &&
      (current['previousVersionId'] === undefined ||
        productionVersion(current['previousVersionId'])))
  )
}
function source(raw: unknown): raw is ProductionSource {
  if (
    !record(raw) ||
    !text(raw['name'], 200) ||
    !text(raw['version'], 100) ||
    !text(raw['license'], 80)
  )
    return false
  if (raw['origin'] === 'generated_candidate')
    return text(raw['sourceVersionId'], 160) && digest(raw['contentHash'])
  return (
    raw['origin'] === 'reviewed_npm_archive' &&
    text(raw['location'], 2048) &&
    text(raw['upstreamUrl'], 2048) &&
    typeof raw['sourceRevision'] === 'string' &&
    /^[a-f0-9]{40}$/.test(raw['sourceRevision']) &&
    digest(raw['archiveSha256']) &&
    Array.isArray(raw['licenses']) &&
    raw['licenses'].length > 0 &&
    raw['licenses'].length <= 16 &&
    raw['licenses'].every(
      (item) => record(item) && text(item['path'], 1024) && digest(item['sha256']),
    )
  )
}
function report(raw: unknown): boolean {
  if (raw === null) return true
  if (
    !record(raw) ||
    !text(raw['jobId'], 256) ||
    !['pass', 'fail'].includes(String(raw['verdict'])) ||
    !Array.isArray(raw['stages']) ||
    raw['stages'].length !== 10
  )
    return false
  const stages = raw['stages']
  return (
    stages.every(
      (item, index) =>
        record(item) &&
        item['stage'] === STAGES[index] &&
        typeof item['passed'] === 'boolean' &&
        text(item['detail'], 4096),
    ) &&
    (raw['verdict'] === 'pass') === stages.every((item) => record(item) && item['passed'] === true)
  )
}
function envelope(raw: Record<string, unknown>): boolean {
  return (
    raw['formatVersion'] === 1 &&
    text(raw['workspaceId'], 512) &&
    count(raw['boardSequence'], Number.MAX_SAFE_INTEGER)
  )
}
export function parseProductionList(stdout: string): ProductionLoad<ProductionList> {
  const raw = wireJson(stdout)
  if (
    !record(raw) ||
    raw['ok'] !== true ||
    !envelope(raw) ||
    !Array.isArray(raw['items']) ||
    raw['items'].length > 50 ||
    !raw['items'].every(summary) ||
    !count(raw['total'], Number.MAX_SAFE_INTEGER) ||
    raw['total'] < raw['items'].length ||
    raw['truncated'] !== raw['total'] > raw['items'].length ||
    new Set(raw['items'].map((item) => item.versionId)).size !== raw['items'].length
  )
    return { ok: false, reason: 'unsupported_production_list' }
  return { ok: true, value: raw as ProductionList }
}
export function parseProductionDetail(
  stdout: string,
  expectedVersion: string,
  expectedWorkspace: string,
): ProductionLoad<ProductionDetail> {
  const body = wireJson(stdout),
    raw = record(body) && body['ok'] === true ? body['desktopView'] : undefined
  if (
    !record(raw) ||
    !envelope(raw) ||
    !summary(raw) ||
    raw.versionId !== expectedVersion ||
    raw['workspaceId'] !== expectedWorkspace ||
    !text(raw['capability'], 4096) ||
    !record(raw['mastery']) ||
    !strings(raw['mastery']['whenToUse']) ||
    !strings(raw['mastery']['preconditions']) ||
    !strings(raw['mastery']['pitfalls']) ||
    !Array.isArray(raw['permissions']) ||
    raw['permissions'].length !== 0 ||
    !count(raw['timeoutMs'], 15000) ||
    raw['timeoutMs'] < 1 ||
    !Array.isArray(raw['source']) ||
    raw['source'].length !== raw.dependencyCount + 1 ||
    !raw['source'].every(source) ||
    !report(raw['report']) ||
    !record(raw['review'])
  )
    return { ok: false, reason: 'unsupported_production_detail' }
  const review = raw['review']
  if (
    !(review['status'] === 'available'
      ? reviewId(review['reviewId']) && text(review['receiptId'], 200)
      : review['status'] === 'unavailable' && text(review['code'], 160))
  )
    return { ok: false, reason: 'invalid_production_review' }
  return { ok: true, value: raw as ProductionDetail }
}
