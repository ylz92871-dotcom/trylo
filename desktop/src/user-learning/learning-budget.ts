import { newId } from './ids';
import type {
  LearningCallLedgerEntry,
  LearningInferenceSettings,
  LearningSkillName,
  UserLearningSnapshot,
} from './types';

export interface LearningCallPermit {
  readonly ledgerId: string;
  readonly traceId?: string;
  readonly skill: LearningSkillName;
  readonly deletionEpoch: number;
}

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * HOUR_MS;
const MAX_LEDGER = 500;

function compactLedger(items: readonly LearningCallLedgerEntry[], now: number): readonly LearningCallLedgerEntry[] {
  return items.filter((item) => item.reservedAt >= now - RETENTION_MS).slice(-MAX_LEDGER);
}

export function reserveLearningCall(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly settings: LearningInferenceSettings;
  readonly skill: LearningSkillName;
  readonly traceId?: string;
  readonly provider?: 'openai' | 'anthropic';
  readonly model?: string;
  readonly now: number;
}): { snapshot: UserLearningSnapshot; permit: LearningCallPermit | null } {
  const recent = input.snapshot.learningCallLedger.filter((item) => item.reservedAt >= input.now - HOUR_MS);
  if (recent.length >= input.settings.maxCallsPerHour) {
    return { snapshot: input.snapshot, permit: null };
  }
  if (
    input.traceId
    && input.snapshot.learningCallLedger.filter((item) => item.traceId === input.traceId).length
      >= input.settings.maxCallsPerTrace
  ) {
    return { snapshot: input.snapshot, permit: null };
  }
  const entry: LearningCallLedgerEntry = {
    id: newId('llm_call', input.now),
    traceId: input.traceId,
    skill: input.skill,
    provider: input.provider,
    model: input.model,
    status: 'reserved',
    reservedAt: input.now,
    deletionEpoch: input.snapshot.deletionEpoch,
  };
  return {
    snapshot: {
      ...input.snapshot,
      learningCallLedger: compactLedger([...input.snapshot.learningCallLedger, entry], input.now),
    },
    permit: {
      ledgerId: entry.id,
      traceId: entry.traceId,
      skill: entry.skill,
      deletionEpoch: entry.deletionEpoch,
    },
  };
}

export function finishLearningCall(
  snapshot: UserLearningSnapshot,
  permit: LearningCallPermit,
  status: 'completed' | 'failed' | 'rejected',
  now: number,
): UserLearningSnapshot {
  if (snapshot.deletionEpoch !== permit.deletionEpoch) return snapshot;
  return {
    ...snapshot,
    learningCallLedger: compactLedger(snapshot.learningCallLedger.map((item) => (
      item.id === permit.ledgerId && item.status === 'reserved'
        ? { ...item, status, finishedAt: now }
        : item
    )), now),
  };
}
