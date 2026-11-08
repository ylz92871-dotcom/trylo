/** Navigation receipt only. The original pending-detail/apply owners retain all
 * approval authority; tool output can never apply the requested version. */
export interface SkillPendingReviewRequest {
  readonly schemaVersion: 1
  readonly kind: 'skill_pending_review_request'
  readonly requestRef: string
  readonly scope: string
  readonly pendingId: string
  readonly expectedHash: string
  readonly name: string
  readonly action: string
  readonly reason: string
  readonly status: 'awaiting_user_approval'
  readonly sourceRefs: readonly string[]
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export function isSkillPendingReviewRequest(value: unknown): value is SkillPendingReviewRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return (
    r.schemaVersion === 1 &&
    r.kind === 'skill_pending_review_request' &&
    r.status === 'awaiting_user_approval' &&
    nonempty(r.requestRef) &&
    nonempty(r.scope) &&
    nonempty(r.pendingId) &&
    typeof r.expectedHash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(r.expectedHash) &&
    nonempty(r.name) &&
    nonempty(r.action) &&
    nonempty(r.reason) &&
    Array.isArray(r.sourceRefs) &&
    r.sourceRefs.every(nonempty)
  )
}

export function readSkillPendingReview(
  output: string | undefined,
): SkillPendingReviewRequest | undefined {
  if (!output || output.length > 65536) return undefined
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return undefined /* Non-JSON tool output is not actionable. */
  }
  return isSkillPendingReviewRequest(value) ? value : undefined
}

/** Scope is already canonical at the CLI boundary. Normalize only OS spelling,
 * never resolve paths or infer that a different workspace owns the receipt. */
export function sameLearningScope(a: string | undefined, b: string | undefined): boolean {
  const normalized = (value: string) => {
    const path = value.replace(/\\/g, '/').replace(/\/$/, '')
    return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path
  }
  return !!a && !!b && normalized(a) === normalized(b)
}

export const SKILL_PENDING_REVIEW_EVENT = 'trylo:review-skill-pending'
export function openSkillPendingReview(request: SkillPendingReviewRequest): void {
  window.dispatchEvent(new CustomEvent(SKILL_PENDING_REVIEW_EVENT, { detail: request }))
}
