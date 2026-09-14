import { describe, expect, it } from 'vitest';
import {
  consumeLearningDirectiveForProduct,
  setLearningDirectiveForProduct,
  type LearningDirectiveByProduct,
} from './learning-directive-state';

const noLearn = {
  applyExistingPreferences: true,
  collectNewLearning: false,
  retention: 'normal' as const,
};
const incognito = {
  applyExistingPreferences: false,
  collectNewLearning: false,
  retention: 'session_only' as const,
};

describe('one-shot LearningDirective state', () => {
  it('keeps Code and Work selections isolated', () => {
    let state: LearningDirectiveByProduct = {};
    state = setLearningDirectiveForProduct(state, 'code', noLearn);
    state = setLearningDirectiveForProduct(state, 'work', incognito);
    expect(state.code).toEqual(noLearn);
    expect(state.work).toEqual(incognito);
  });

  it('consumes only the accepted product and leaves the other selection armed', () => {
    const state = setLearningDirectiveForProduct(
      setLearningDirectiveForProduct({}, 'code', noLearn),
      'work',
      incognito,
    );
    const consumed = consumeLearningDirectiveForProduct(state, 'code');
    expect(consumed.directive).toEqual(noLearn);
    expect(consumed.remaining.code).toBeUndefined();
    expect(consumed.remaining.work).toEqual(incognito);
    // Caller-owned and returned objects do not share the directive object.
    expect(consumed.directive).not.toBe(state.code);
  });

  it('does not mutate state when there is nothing to consume', () => {
    const state: LearningDirectiveByProduct = { work: incognito };
    const consumed = consumeLearningDirectiveForProduct(state, 'code');
    expect(consumed.directive).toBeUndefined();
    expect(consumed.remaining).toBe(state);
  });
});
