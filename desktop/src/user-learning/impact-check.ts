import type { PolicyDecision, TaskContext } from './types';

export interface ImpactCheck {
  readonly triggered: boolean;
  readonly interruptUser: boolean;
  readonly reason: string;
  readonly suppressedActions: readonly string[];
  readonly baselineActions: readonly string[];
}

const WEAKENING = new Set([
  'direct_execution',
  'skip_verification',
  'skip_tests',
  'weaken_security',
  'duplicate_review',
]);

export function engineeringBaseline(task: TaskContext): readonly string[] {
  if (task.corePath || task.risk === 'high' || !task.reversible) {
    return ['require:plan_first', 'require:final_verification'];
  }
  if (task.risk === 'low') {
    return ['prefer:direct_execution', 'avoid:duplicate_review'];
  }
  return ['prefer:direct_execution', 'require:final_verification'];
}

/**
 * Compare personalized actions against the engineering baseline.
 * Interrupt the user only when ALL of:
 *   high preference impact, high uncertainty, and the answer would
 *   change a real engineering decision. Low-risk reversible work never pops.
 */
export function evaluatePreferenceImpact(input: {
  readonly task: TaskContext;
  readonly decision: Pick<PolicyDecision, 'resolvedActions' | 'active'>;
  readonly recentlyAsked?: boolean;
}): ImpactCheck {
  const baseline = engineeringBaseline(input.task);
  const personalized = input.decision.resolvedActions;
  const dropped = baseline.filter((action) => !personalized.includes(action) && /verif|plan_first|backup|security/.test(action));
  const addedWeakening = personalized.filter((action) => {
    const name = action.split(':')[1] ?? action;
    return WEAKENING.has(name) && (input.task.corePath || input.task.risk === 'high');
  });
  const suppressedActions = [...new Set([...dropped, ...addedWeakening])];
  const highImpact = suppressedActions.length > 0 && (input.task.corePath || input.task.risk === 'high' || !input.task.reversible);
  const uncertain = input.decision.active.some((rule) => rule.applicationScore < 0.8);
  const wouldChangeDecision = highImpact;
  const interruptUser = highImpact && uncertain && wouldChangeDecision && input.recentlyAsked !== true
    && input.task.risk !== 'low';
  return {
    triggered: highImpact,
    interruptUser,
    reason: highImpact
      ? 'personalized policy would change a high-impact engineering control'
      : 'no material engineering delta vs baseline',
    suppressedActions,
    baselineActions: baseline,
  };
}

export function applyImpactSuppression(
  decision: PolicyDecision,
  check: ImpactCheck,
): PolicyDecision {
  if (!check.triggered || check.suppressedActions.length === 0) {
    return { ...decision, clarificationRequired: check.interruptUser };
  }
  const blocked = new Set(check.suppressedActions);
  const active = decision.active.filter((rule) => {
    const key = `${rule.mode}:${actionFromInstruction(rule.instruction)}`;
    return ![...blocked].some((item) => key.includes(item.split(':')[1] ?? item));
  });
  const resolvedActions = decision.resolvedActions.filter((action) => !blocked.has(action)
    && ![...blocked].some((item) => action === item));
  const droppedIds = new Set(decision.active.filter((rule) => !active.includes(rule)).map((rule) => rule.policyId));
  return {
    ...decision,
    active,
    enforced: (decision.enforced ?? active).filter((rule) => !droppedIds.has(rule.policyId)),
    resolvedActions,
    suppressedRuleIds: [
      ...decision.suppressedRuleIds,
      ...[...droppedIds],
    ],
    clarificationRequired: check.interruptUser,
    clarificationQuestion: check.interruptUser
      ? '这次任务涉及核心或高回滚成本路径。你说的减少审核是否仍要求保留最终验证？'
      : undefined,
  };
}

function actionFromInstruction(instruction: string): string {
  if (/最终验证|smoke|production/i.test(instruction)) return 'final_verification';
  if (/直接/i.test(instruction)) return 'direct_execution';
  if (/计划|plan/i.test(instruction)) return 'plan_first';
  if (/重复/i.test(instruction)) return 'duplicate_review';
  return '';
}
