export interface MemberHandoff {
  readonly scope: string;
  readonly artifacts: readonly string[];
  readonly evidence: readonly string[];
  readonly pending: readonly string[];
  readonly blockers: readonly string[];
}

/** Mirrored CLI V1 context bounds; references never grant execution authority. */
export function isMemberHandoff(value: unknown): value is MemberHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const items = (input: unknown): boolean => Array.isArray(input) && input.length <= 16
    && input.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 1000);
  return Object.keys(row).length === 5 && typeof row.scope === 'string' && row.scope.trim().length > 0 && row.scope.length <= 4000
    && ['artifacts', 'evidence', 'pending', 'blockers'].every(key => items(row[key]))
    && new TextEncoder().encode(JSON.stringify(row)).length <= 16000;
}
