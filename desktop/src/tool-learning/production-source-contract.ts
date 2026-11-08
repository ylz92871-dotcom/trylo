import { record, text, digest } from './wire'

export type ProductionNpmSourceIdentity =
  | { readonly kind: 'legacy_github_revision'; readonly provenance: 'caller_reviewed_pointer' }
  | { readonly kind: 'registry_archive'; readonly archiveUrl: string; readonly integrity: string;
      readonly claims?: { readonly kind: 'publisher_claimed'; readonly repository?: string; readonly revision?: string } }
export type ProductionSource = { readonly name: string; readonly version: string; readonly license: string } & (
  | { readonly origin: 'generated_candidate'; readonly sourceVersionId: string; readonly contentHash: string }
  | { readonly origin: 'reviewed_npm_archive'; readonly location: string; readonly upstreamUrl?: string; readonly sourceRevision?: string;
      readonly sourceIdentity?: ProductionNpmSourceIdentity; readonly archiveSha256: string;
      readonly licenses: readonly { readonly path: string; readonly sha256: string }[] }
)
function registryIdentity(raw: unknown, name: string, version: string): boolean {
  if (!record(raw) || raw['kind'] !== 'registry_archive' || raw['archiveUrl'] !== `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`
    || typeof raw['integrity'] !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(raw['integrity'])) return false
  const claims = raw['claims']
  return claims === undefined || (record(claims) && claims['kind'] === 'publisher_claimed'
    && (claims['repository'] === undefined || text(claims['repository'], 2048))
    && (claims['revision'] === undefined || typeof claims['revision'] === 'string' && /^[a-f0-9]{40}$/.test(claims['revision'])))
}
export function productionSource(raw: unknown): raw is ProductionSource {
  if (!record(raw) || !text(raw['name'], 200) || !text(raw['version'], 100) || !text(raw['license'], 80)) return false
  if (raw['origin'] === 'generated_candidate') return text(raw['sourceVersionId'], 160) && digest(raw['contentHash'])
  const identity = raw['sourceIdentity']
  const legacy = text(raw['upstreamUrl'], 2048) && typeof raw['sourceRevision'] === 'string' && /^[a-f0-9]{40}$/.test(raw['sourceRevision'])
    && (identity === undefined || record(identity) && identity['kind'] === 'legacy_github_revision' && identity['provenance'] === 'caller_reviewed_pointer')
  return raw['origin'] === 'reviewed_npm_archive' && text(raw['location'], 2048) && digest(raw['archiveSha256'])
    && (legacy || registryIdentity(identity, raw['name'], raw['version']))
    && Array.isArray(raw['licenses']) && raw['licenses'].length > 0 && raw['licenses'].length <= 16
    && raw['licenses'].every(row => record(row) && text(row['path'], 1024) && digest(row['sha256']))
}
