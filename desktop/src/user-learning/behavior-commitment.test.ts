import { describe, expect, it } from 'vitest';
import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';

function learn(
  runtime: ReturnType<typeof createUserLearningRuntime>,
  prompt: string,
  turnId = 't',
  product: 'code' | 'work' = 'code',
) {
  const trace = runtime.openTrace({
    sessionId: `s-${turnId}`,
    turnId,
    workspaceRoot: 'D:/project',
    product,
    prompt,
  });
  runtime.closeTrace(trace.id, 'completed', 'ok');
  return trace;
}

describe('BehaviorCommitment pipeline', () => {
  it('keeps an explicit reporting commitment in shadow until it is activated', () => {
    const store = createUserLearningStore({ memoryOnly: true });
    const runtime = createUserLearningRuntime({
      store,
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    learn(runtime, '以后汇报先说结论，再按需展开依据');

    const commitment = runtime.snapshot().behaviorCommitments.find((item) => item.decisionPoint === 'report.section_order');
    expect(commitment).toEqual(expect.objectContaining({ state: 'shadow', activation: 'explicit', version: 1 }));
    expect(commitment?.provenanceEvidenceIds.length).toBeGreaterThan(0);

    const shadow = runtime.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '汇报本次修改', baseSystemPrompt: '',
    });
    expect(shadow.decision.shadow.some((item) => item.domain === 'reporting_information_density')).toBe(true);
    expect(shadow.decision.enforced.some((item) => item.domain === 'reporting_information_density')).toBe(false);

    store.update((snapshot) => ({
      ...snapshot,
      behaviorCommitments: snapshot.behaviorCommitments.map((item) => (
        item.id === commitment?.id ? { ...item, state: 'active' as const } : item
      )),
      dirtyDimensions: ['reporting_information_density'],
    }));
    const active = runtime.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '汇报本次修改', baseSystemPrompt: '',
    });
    expect(active.decision.enforced.some((item) => item.domain === 'reporting_information_density')).toBe(true);
    expect(active.decision.injectionText).toContain('先给结论');
  });

  it('supersedes a prior commitment instead of mutating its version in place', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    learn(runtime, '以后汇报先说结论', 't1');
    learn(runtime, '以后汇报先说结论，再展开详细依据', 't2');
    const rows = runtime.snapshot().behaviorCommitments.filter((item) => item.decisionPoint === 'report.section_order');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe('superseded');
    expect(rows[1]).toEqual(expect.objectContaining({ version: 2, supersedes: rows[0]?.id }));
  });

  it('records safety eligibility but does not turn a quality floor into a user model', () => {
    const runtime = createUserLearningRuntime({ store: createUserLearningStore({ memoryOnly: true }) });
    learn(runtime, '不要编造引用，来源必须真实');
    expect(runtime.snapshot().eligibilityDecisions).toEqual([
      expect.objectContaining({ classification: 'safety_or_integrity_requirement' }),
    ]);
    expect(runtime.snapshot().userModels).toEqual([]);
    expect(runtime.snapshot().behaviorCommitments).toEqual([]);
  });

  it('compiles the Work structure-before-draft preference without leaking it into Code', () => {
    const runtime = createUserLearningRuntime({
      store: createUserLearningStore({ memoryOnly: true }),
      settings: { enabled: true, defaultMode: 'enforced', dimensionMode: {}, cognitionEnabled: false },
    });
    learn(runtime, '以后文稿先看结构，确认后再写完整草稿', 'work-turn', 'work');
    expect(runtime.snapshot().behaviorCommitments).toEqual([
      expect.objectContaining({ decisionPoint: 'artifact.structure_before_draft', state: 'shadow' }),
    ]);
    const work = runtime.preparePrompt({
      workspaceRoot: 'D:/project', product: 'work', prompt: '写一份项目提案', baseSystemPrompt: '',
    });
    const code = runtime.preparePrompt({
      workspaceRoot: 'D:/project', product: 'code', prompt: '修改一个函数', baseSystemPrompt: '',
    });
    expect(work.decision.shadow.some((item) => item.domain === 'work_artifact_workflow')).toBe(true);
    expect(code.decision.active.some((item) => item.domain === 'work_artifact_workflow')).toBe(false);
  });
});
