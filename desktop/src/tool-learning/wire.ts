export const record = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
export const text = (raw: unknown, max: number): raw is string =>
  typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max
export const count = (raw: unknown, max: number): raw is number =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= max
export const digest = (raw: unknown): raw is string =>
  typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw)
export const productionVersion = (raw: unknown): raw is string =>
  typeof raw === 'string' && /^tool-production_v1_[a-f0-9]{64}$/.test(raw)
export function wireJson(stdout: string): unknown {
  if (stdout.length > 1_048_576) return undefined
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}
