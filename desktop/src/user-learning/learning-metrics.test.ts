import { describe, expect, it } from 'vitest';
import { calculateLearningMetrics } from './learning-metrics';
import { emptySnapshot } from './store';
import type { OutcomeObservation } from './types';

function outcome(index: number, signal: OutcomeObservation['signal']): OutcomeObservation {
  return {
    id: `outcome-${index}-${signal}`,
    commitmentId: 'commitment-1',
    policyDecisionId: `decision-${index}`,
    traceId: `trace-${index}`,
    opportunityKey: 'report.section_order::code::project::report::unknown::unknown',
    signal,
    attribution: signal === 'task_completed' ? 'unknown' : 'direct',
    createdAt: index,
  };
}

describe('learning metrics', () => {
  it('withholds rates before five comparable opportunities', () => {
    const snapshot = {
      ...emptySnapshot(),
      outcomeObservations: [outcome(1, 'task_completed'), outcome(2, 'repeated_correction')],
    };
    expect(calculateLearningMetrics(snapshot)).toEqual(expect.objectContaining({
      comparableOpportunities: 1,
      repeatedExplanations: 1,
      repeatedExplanationRate: null,
      materialReworkRate: null,
      overrideRate: null,
    }));
  });

  it('calculates local rates once the sample floor is met', () => {
    const snapshot = {
      ...emptySnapshot(),
      outcomeObservations: [
        ...[1, 2, 3, 4, 5].map((index) => outcome(index, 'task_completed')),
        outcome(6, 'repeated_correction'),
        outcome(7, 'material_rework'),
        outcome(8, 'explicit_unhelpful'),
      ],
    };
    expect(calculateLearningMetrics(snapshot)).toEqual(expect.objectContaining({
      comparableOpportunities: 5,
      repeatedExplanations: 1,
      repeatedExplanationRate: 0.2,
      materialReworkRate: 0.2,
      overrideRate: 0.2,
    }));
  });
});
