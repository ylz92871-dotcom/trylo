import { inferDimension } from './conclusion';
import { newId } from './ids';
import { canonicalScope, fingerprintScopeV2, sameStableScope } from './scope';
import type {
  BehaviorCommitment,
  BehaviorDelta,
  EnforcementMode,
  EvidenceRecord,
  PersonalizationEligibilityDecision,
  UserModelRecord,
} from './types';

export type V02DecisionPoint = 'report.section_order' | 'artifact.structure_before_draft';

function decisionPoint(model: UserModelRecord): V02DecisionPoint | null {
  if (model.dimension === 'reporting_information_density') return 'report.section_order';
  if (model.dimension === 'work_artifact_workflow') return 'artifact.structure_before_draft';
  return null;
}

function deltaFor(point: V02DecisionPoint, evidence: readonly EvidenceRecord[]): BehaviorDelta {
  const text = evidence.map((item) => `${item.rawObservation.text} ${item.inference.claim}`).join(' ');
  if (point === 'report.section_order') {
    const adapted = /背景优先|先说背景/.test(text)
      ? '先给必要背景，再给结论与依据'
      : /依据展开|详细依据/.test(text)
        ? '先给结论，并默认展开关键依据'
        : '先给结论，再按需展开背景与依据';
    return {
      decisionPoint: point,
      baselineBehavior: '按通用模板组织报告章节',
      adaptedBehavior: adapted,
      expectedBenefit: '减少用户为了找到结论而重新要求调整结构的成本',
      rollbackBehavior: '恢复通用报告章节顺序',
    };
  }
  const structureFirst = /先(?:看|给|出)?结构|结构优先/.test(text);
  return {
    decisionPoint: point,
    baselineBehavior: '按通用流程直接生成交付稿',
    adaptedBehavior: structureFirst ? '先提交结构供确认，再展开完整文稿' : '先给可看的完整草稿，再迭代结构',
    expectedBenefit: '减少文稿方向不合适导致的大范围返工',
    rollbackBehavior: '恢复通用文稿生成流程',
  };
}

export function compileBehaviorCommitments(input: {
  readonly models: readonly UserModelRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly eligibility: readonly PersonalizationEligibilityDecision[];
  readonly existing: readonly BehaviorCommitment[];
  readonly mode: EnforcementMode;
  readonly now: number;
}): readonly BehaviorCommitment[] {
  let output = [...input.existing];
  const eligibleEvidenceIds = new Set(input.eligibility
    .filter((item) => item.classification === 'personalization_candidate')
    .flatMap((item) => item.sourceEvidenceIds));

  for (const model of input.models) {
    const point = decisionPoint(model);
    if (!point) continue;
    const sources = input.evidence.filter((item) => (
      eligibleEvidenceIds.has(item.id)
      && inferDimension(item.inference.claim) === model.dimension
      && sameStableScope(item.context, model.scope)
    ));
    if (sources.length === 0) continue;
    const stableKey = `${model.userId}::${point}::${fingerprintScopeV2(model.scope)}`;
    const prior = [...output].reverse().find((item) => item.stableKey === stableKey && item.state !== 'superseded');
    const explicit = sources.some((item) => (
      item.governance.level >= 3
      || item.durability === 'authoritative_long_term'
      || /以后|今后|每次|一直|默认|项目里|这个项目|长期/.test(item.rawObservation.text)
    ));
    const state: BehaviorCommitment['state'] = model.status === 'disputed'
      ? 'paused'
      : model.status === 'retired' || model.status === 'superseded'
        ? 'retracted'
        : explicit && input.mode !== 'off'
          ? 'shadow'
          : 'candidate';
    const commitment: BehaviorCommitment = {
      id: newId('bc', input.now),
      userModelId: model.id,
      scope: canonicalScope(model.scope),
      conditions: [model.scope.product ? `product=${model.scope.product}` : 'product=unknown'],
      decisionPoint: point,
      behaviorDelta: deltaFor(point, sources),
      state,
      provenanceEvidenceIds: sources.map((item) => item.id),
      activation: explicit ? 'explicit' : 'confirmed_inference',
      stableKey,
      version: (prior?.version ?? 0) + 1,
      supersedes: prior?.id,
      createdAt: input.now,
      updatedAt: input.now,
    };
    output = [
      ...output.map((item) => item.id === prior?.id ? { ...item, state: 'superseded' as const } : item),
      commitment,
    ];
  }
  return output;
}
