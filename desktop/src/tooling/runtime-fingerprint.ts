// Pure non-cryptographic input identities and Windows-safe path canonicalization.

function fnv1a(input: string, offsetBasis: number, prime: number): number {
  let hash = offsetBasis >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i) & 0xff
    // Low byte only: charCodeAt can exceed 255 for non-Latin-1 prompts and
    // a JS bitwise op would silently truncate the value anyway.
    hash = Math.imul(hash, prime) >>> 0
  }
  return hash >>> 0
}

export function hashIdentity(parts: readonly string[]): string {
  const joined = parts.join('')
  const a = fnv1a(joined, 0x811c9dc5, 0x01000193)
  const b = fnv1a(joined, 0x9dc5811c, 0x85ebca6b)
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/** Best-effort Windows-safe canonicalisation with no filesystem access. */
export function canonicalizeCwd(cwd: string): string {
  let out = (cwd ?? '').trim().replace(/\\/g, '/')
  // Lowercase only the drive letter — paths are case-insensitive on Windows
  // but case-sensitive everywhere else.
  out = out.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
  if (out.length > 1) out = out.replace(/\/+$/, '')
  return out
}
