export interface GeneratedMediaArtifact { readonly path: string; readonly mimeType: string; readonly size: number; readonly sha256: string }
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'])
export function readGeneratedMedia(value: unknown): readonly GeneratedMediaArtifact[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const artifacts: GeneratedMediaArtifact[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path || !TYPES.has(item.mimeType)
      || !Number.isSafeInteger(item.size) || item.size <= 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return undefined
    artifacts.push({ path: item.path, mimeType: item.mimeType, size: item.size, sha256: item.sha256 })
  }
  return artifacts
}
