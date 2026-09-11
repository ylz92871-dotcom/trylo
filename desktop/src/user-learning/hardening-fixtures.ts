import { createUserLearningRuntime } from './runtime';
import { createUserLearningStore } from './store';
import type {
  EvidenceRecord,
  PolicyDecision,
  UserDecisionTrace,
  UserLearningSettings,
  UserModelRecord,
} from './types';

export function memoryRuntime(settings?: Partial<UserLearningSettings>) {
  return createUserLearningRuntime({
    store: createUserLearningStore({ memoryOnly: true }),
    settings: {
      enabled: true,
      defaultMode: 'shadow',
      dimensionMode: {},
      cognitionEnabled: true,
      ...settings,
    },
  });
}

export function userEvent(
  text: string,
  overrides: Partial<UserDecisionTrace['userEvents'][number]> = {},
): UserDecisionTrace['userEvents'][number] {
  return {
    id: overrides.id ?? 'ue_1',
    at: overrides.at ?? 1,
    actor: overrides.actor ?? 'user',
    type: overrides.type ?? 'user_message',
    stage: overrides.stage ?? 'task_context',
    text,
    ...overrides,
  };
}

export function evidence(partial: Partial<EvidenceRecord> & Pick<EvidenceRecord, 'id' | 'inference'>): EvidenceRecord {
  return {
    userId: 'local-user',
    source: {
      sessionId: 's',
      taskId: 't',
      turnIds: ['turn'],
      actionIds: [],
      sourceHash: `hash:${partial.id}`,
      traceId: 'tr_1',
    },
    origin: {
      channel: 'interaction',
      eventType: 'explicit_statement',
      stage: 'task_context',
    },
    rawObservation: { text: partial.inference.claim },
    context: {
      workspaceId: 'ws',
      projectId: 'p',
      scopeTags: ['code'],
      product: 'code',
    },
    strength: { contextInformedness: 'task_context', band: 'medium' },
    governance: { level: 2, userLocked: false },
    createdAt: 1,
    ...partial,
  };
}

export function model(partial: Partial<UserModelRecord> = {}): UserModelRecord {
  return {
    id: 'um_1',
    userId: 'local-user',
    statement: '在中低风险 Coding 任务中，用户对重复、同质 Review 的容忍度较低；但这一倾向不应解释为降低核心状态链路的最终可靠性验证。',
    dimension: 'verification_audit',
    scope: { workspaceId: 'ws', projectId: 'proj-a', scopeTags: ['code'], product: 'code' },
    confidence: { score: 0.87, band: 'high' },
    inference: { distance: 'D0', alternativeExplanations: ['赶时间'], rationaleSummary: 'restatement' },
    derivedFrom: { conclusionIds: ['con_1'] },
    profileDependencies: [],
    counterevidence: [],
    status: 'active',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

export function ruleIds(decision: PolicyDecision): readonly string[] {
  return [
    ...decision.matchedRuleIds,
    ...decision.active.map((rule) => rule.policyId),
    ...decision.suppressedRuleIds,
  ];
}

export function partition(decision: PolicyDecision): {
  enforced: readonly { policyId: string; domain: string; instruction: string }[];
  shadow: readonly { policyId: string; domain: string; instruction: string }[];
  off: readonly { policyId: string; domain: string; instruction: string }[];
} {
  const extended = decision as PolicyDecision & {
    enforced?: readonly { policyId: string; domain: string; instruction: string }[];
    shadow?: readonly { policyId: string; domain: string; instruction: string }[];
    off?: readonly { policyId: string; domain: string; instruction: string }[];
  };
  return {
    enforced: extended.enforced ?? [],
    shadow: extended.shadow ?? [],
    off: extended.off ?? [],
  };
}
