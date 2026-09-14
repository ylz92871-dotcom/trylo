import { describe, expect, it } from 'vitest';
import { finishLearningCall, reserveLearningCall } from './learning-budget';
import { emptySnapshot } from './store';
import type { LearningInferenceSettings } from './types';

const settings: LearningInferenceSettings = {
  enabled: true, mode: 'assisted', allowExecutionContext: false,
  maxCallsPerHour: 2, maxCallsPerTrace: 1,
};

describe('learning call budget', () => {
  it('counts failed and rejected attempts against trace and hourly limits', () => {
    const first = reserveLearningCall({ snapshot: emptySnapshot(1), settings, skill: 'evidence', traceId: 't1', now: 10 });
    const finished = finishLearningCall(first.snapshot, first.permit!, 'failed', 11);
    expect(reserveLearningCall({ snapshot: finished, settings, skill: 'evidence', traceId: 't1', now: 12 }).permit).toBeNull();
    expect(reserveLearningCall({ snapshot: finished, settings, skill: 'evidence', traceId: 't1', now: 3_700_000 }).permit).toBeNull();
    const second = reserveLearningCall({ snapshot: finished, settings, skill: 'evidence', traceId: 't2', now: 13 });
    expect(second.permit).not.toBeNull();
    expect(reserveLearningCall({ snapshot: second.snapshot, settings, skill: 'evidence', traceId: 't3', now: 14 }).permit).toBeNull();
  });

  it('does not finish a permit across a deletion epoch', () => {
    const reserved = reserveLearningCall({ snapshot: emptySnapshot(1), settings, skill: 'evidence', traceId: 't1', now: 10 });
    const deletedGeneration = { ...reserved.snapshot, deletionEpoch: 1, learningCallLedger: [] };
    expect(finishLearningCall(deletedGeneration, reserved.permit!, 'completed', 20)).toBe(deletedGeneration);
  });
});
