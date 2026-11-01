/** Additive CLI V1 delivery fact; a started round is not acceptance or verification. */
export interface MemberDelivery {
  readonly submissionId: string;
  readonly parentToolCallId: string;
  readonly round: number;
  readonly state: 'started' | 'answered';
}

export function isMemberDelivery(value: unknown): value is MemberDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.submissionId === 'string' && row.submissionId.length > 0 && row.submissionId.length <= 1024
    && typeof row.parentToolCallId === 'string' && row.parentToolCallId.length > 0 && row.parentToolCallId.length <= 1024
    && Number.isSafeInteger(row.round) && Number(row.round) > 0 && (row.state === 'started' || row.state === 'answered');
}
