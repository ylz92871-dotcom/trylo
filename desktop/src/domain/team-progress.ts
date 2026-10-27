/** Durable UI facts projected from the team's own runtime events. */
export interface TeamProgressReport {
  readonly id: string;
  readonly seatId: string;
  readonly memberId?: string;
  readonly round?: number;
  readonly at?: number;
  readonly kind: 'assignment' | 'report' | 'error' | 'progress' | 'blocked' | 'ready';
  readonly text: string;
  readonly streaming?: boolean;
}

export interface TeamHandoffRecord {
  readonly id: string;
  /** Absent means the parent Personal Agent, not the read-only person seat. */
  readonly fromSeatId?: string;
  readonly fromMemberId?: string;
  readonly toSeatId: string;
  readonly toMemberId?: string;
  readonly message: string;
  readonly at: number;
  readonly settledAt?: number;
  readonly status: 'sending' | 'sent' | 'queued' | 'continued' | 'restarted' | 'failed';
  readonly error?: string;
}
