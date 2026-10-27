import { DEFAULT_CONTEXT_WINDOW } from '../host-adapter/context-windows'

export interface ModelContextPreference {
  readonly window?: number
  /** User-declared model/endpoint capacity; never inferred from a model name. */
  readonly capacity?: number
}
export type ModelContextPreferences = Readonly<Record<string, ModelContextPreference>>
export interface ContextModelIdentity {
  readonly apiHost?: string
  readonly apiModel?: string
  readonly apiFormat?: string
  readonly poolModel?: string
}
export interface ContextSettings extends ContextModelIdentity {
  readonly modelContextPreferences?: ModelContextPreferences
}

export function validContextSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Preferences follow the model connection, not the authentication identity. */
export function contextModelKey(model: ContextModelIdentity): string {
  return model.poolModel?.trim()
    ? JSON.stringify(['pool', model.poolModel.trim()])
    : JSON.stringify([
        model.apiFormat ?? '',
        (model.apiHost ?? '').trim().replace(/\/+$/, ''),
        (model.apiModel ?? '').trim(),
      ])
}

export function contextPreference(settings: ContextSettings): ModelContextPreference {
  return settings.modelContextPreferences?.[contextModelKey(settings)] ?? {}
}

/** UI preview only. The CLI resolves and reports the actual execution budget. */
export function resolveContextPreference(
  preference: ModelContextPreference,
  serverCapacity?: number,
): {
  readonly requested: number
  readonly capacity: number | undefined
  readonly effective: number
} {
  const limits = [validContextSize(preference.capacity), validContextSize(serverCapacity)].filter(
    (n): n is number => n !== undefined,
  )
  const capacity = limits.length ? Math.min(...limits) : undefined
  const requested = validContextSize(preference.window) ?? DEFAULT_CONTEXT_WINDOW
  return { requested, capacity, effective: Math.min(requested, capacity ?? Infinity) }
}

export function withContextPreference(
  settings: ContextSettings,
  preference: ModelContextPreference,
): ModelContextPreferences {
  return { ...settings.modelContextPreferences, [contextModelKey(settings)]: preference }
}

export function parseModelContextPreferences(value: unknown): ModelContextPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const entries: [string, ModelContextPreference][] = []
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const window = validContextSize('window' in raw ? raw.window : undefined)
    const capacity = validContextSize('capacity' in raw ? raw.capacity : undefined)
    if (window !== undefined || capacity !== undefined)
      entries.push([
        key,
        {
          ...(window === undefined ? {} : { window }),
          ...(capacity === undefined ? {} : { capacity }),
        },
      ])
  }
  return Object.fromEntries(entries)
}

export function contextWindowOptions(
  preference: ModelContextPreference,
  serverCapacity?: number,
): readonly number[] {
  const { capacity, effective } = resolveContextPreference(preference, serverCapacity)
  const ceiling = capacity ?? Infinity
  return [
    ...new Set([
      64_000,
      128_000,
      200_000,
      256_000,
      400_000,
      600_000,
      800_000,
      1_000_000,
      effective,
      ...(capacity === undefined ? [] : [capacity]),
    ]),
  ]
    .filter((n) => n <= ceiling)
    .sort((a, b) => a - b)
}
