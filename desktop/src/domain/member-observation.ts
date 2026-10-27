/** Additive wire contract shared by team and ordinary member conversations. */
export interface MemberObservation {
  readonly id: string;
  readonly round: number;
  readonly kind: 'text' | 'thinking' | 'tool' | 'result' | 'report';
  readonly text?: string;
  readonly tool?: string;
  readonly input?: Record<string, unknown>;
  readonly ok?: boolean;
  readonly reportState?: 'progress' | 'blocked' | 'ready';
}
export interface RecordedMemberObservation extends MemberObservation {
  readonly at: number;
  readonly completedAt?: number;
}
export function normalizeMemberObservations(value: unknown): readonly RecordedMemberObservation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is RecordedMemberObservation => isMemberObservation(item)
    && 'at' in item && typeof item.at === 'number' && Number.isFinite(item.at) && item.at >= 0
    && (!('completedAt' in item) || item.completedAt === undefined || typeof item.completedAt === 'number' && Number.isFinite(item.completedAt) && item.completedAt >= 0));
  return entries.length ? entries.slice(-256) : undefined;
}
export function isMemberObservation(value: unknown): value is MemberObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0 && typeof row.round === 'number' && Number.isInteger(row.round) && row.round > 0
    && ['text', 'thinking', 'tool', 'result', 'report'].includes(String(row.kind))
    && (row.text === undefined || typeof row.text === 'string' && row.text.length <= 24000)
    && (row.tool === undefined || typeof row.tool === 'string')
    && (row.input === undefined || row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input))
    && (row.ok === undefined || typeof row.ok === 'boolean')
    && (row.kind !== 'report' || typeof row.text === 'string' && ['progress', 'blocked', 'ready'].includes(String(row.reportState)));
}
export function recordMemberObservation(previous: readonly RecordedMemberObservation[] = [], event: MemberObservation, at: number): readonly RecordedMemberObservation[] {
  const family = (kind: MemberObservation['kind']): string => kind === 'result' ? 'tool' : kind;
  const index = previous.findIndex(item => item.id === event.id && item.round === event.round && family(item.kind) === family(event.kind));
  const existing = previous[index];
  const next = { ...existing, ...event, at: existing?.at ?? at, ...(event.kind === 'result' ? { completedAt: at } : {}) };
  const entries = [...previous];
  if (index < 0) entries.push(next); else entries[index] = next;
  return entries.slice(-256);
}
