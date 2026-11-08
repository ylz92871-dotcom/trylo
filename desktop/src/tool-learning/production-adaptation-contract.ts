import { record, text, digest } from './wire'

export type ProductionAdaptation = {
  readonly adapterContentHash: string | null
  readonly patchedFiles: readonly { readonly path: string; readonly upstreamSha256: string; readonly replacementContentHash: string }[]
  readonly parent: null | { readonly parentVersionId: string; readonly parentContentHash: string; readonly requestId: string; readonly adaptation: string }
}
export function productionAdaptation(raw: unknown): raw is ProductionAdaptation {
  if (!record(raw) || (raw['adapterContentHash'] !== null && !digest(raw['adapterContentHash']))
    || !Array.isArray(raw['patchedFiles']) || raw['patchedFiles'].length > 16
    || !raw['patchedFiles'].every(row => record(row) && text(row['path'], 2048) && digest(row['upstreamSha256']) && digest(row['replacementContentHash']))) return false
  const parent = raw['parent']
  return parent === null || (record(parent) && typeof parent['parentVersionId'] === 'string'
    && /^tool-(?:production_v1|evolution_v1|evolution)_[a-f0-9]{64}$/.test(parent['parentVersionId']) && digest(parent['parentContentHash'])
    && text(parent['requestId'], 160) && text(parent['adaptation'], 4096))
}
