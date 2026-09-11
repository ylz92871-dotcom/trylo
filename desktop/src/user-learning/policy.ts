import { applyImpactSuppression, evaluatePreferenceImpact } from './impact-check';
import { estimateTokens, newId, sourceHash } from './ids';
import { isGlobalScope } from './scope';
import { activeRecords } from './store';
import {
  MAX_ACTIVE_POLICIES,
  MAX_ACTIVE_POLICY_TOKENS,
  type ActivePolicyRule,
  type EnforcementMode,
  type PolicyBundle,
  type PolicyDecision,
  type PolicyDimension,
  type PolicyRule,
  type ProjectContextSnapshot,
  type SuppressedPolicyRule,
  type TaskContext,
  type UserLearningSnapshot,
  type UserModelRecord,
} from './types';

const SKILL_VERSION = 'engineering-translation@0.1.0';

const SAFETY_ACTIONS = new Set([
  'skip_verification',
  'skip_tests',
  'skip_backup',
  'weaken_security',
  'drop_migration_check',
]);

function eligible(model: UserModelRecord): boolean {
  if (model.status !== 'active') return false;
  if (model.confidence.band === 'low') return false;
  if (model.inference.distance === 'D2' && model.confidence.band !== 'high') return false;
  return true;
}

function strengthFor(model: UserModelRecord): PolicyRule['strength'] {
  if (model.inference.distance === 'D2') return 'advisory';
  if (model.confidence.band === 'high' && model.inference.distance === 'D0') return 'strong_default';
  if (model.confidence.band === 'high') return 'strong_default';
  return 'soft';
}

function translationDistance(model: UserModelRecord): PolicyRule['confidence']['translationDistance'] {
  return model.inference.distance === 'D0' ? 'T0' : 'T1';
}

function compileOne(
  model: UserModelRecord,
  project: ProjectContextSnapshot | null,
  bundleId: string,
  now: number,
  snapshot?: UserLearningSnapshot,
): readonly PolicyRule[] {
  const sourceEvidenceIds = snapshot
    ? [...new Set(
      snapshot.conclusions
        .filter((item) => model.derivedFrom.conclusionIds.includes(item.id))
        .flatMap((item) => [...item.evidence.supporting, ...item.evidence.counter]),
    )]
    : [];
  const base = {
    userId: model.userId,
    bundleId,
    granularity: project ? 'project' as const : 'global' as const,
    domain: model.dimension,
    sourceUserModelIds: [model.id],
    sourceConclusionIds: [...model.derivedFrom.conclusionIds],
    sourceEvidenceIds,
    governanceLevel: 2 as const,
    status: 'active' as const,
    version: 1,
    createdAt: now,
    confidence: {
      score: Math.min(model.confidence.score, model.inference.distance === 'D0' ? 0.95 : 0.85),
      band: model.confidence.band,
      userModelDistance: model.inference.distance,
      translationDistance: translationDistance(model),
    },
    strength: strengthFor(model),
  };

  if (model.dimension === 'verification_audit') {
    return [
      {
        ...base,
        id: newId('pol', now),
        kind: 'conditional_decision',
        scope: {
          product: 'code',
          projectId: project?.projectId,
          taskRisk: ['low', 'medium'],
          changeType: ['ui', 'isolated_feature', 'bugfix', 'implementation'],
          coreRuntimePath: false,
        },
        when: [{ field: 'task.corePath', op: 'eq', value: false }],
        effect: { mode: 'avoid', action: 'duplicate_review', parameters: { max_equivalent_reviews: 1 } },
        exceptions: ['core_runtime', 'persistent_state', 'security_boundary', 'high_rollback_cost'],
        instruction: '在低中风险且非核心路径的修改中，避免第二轮同目的 Review；保留一次有意义的最终结果检查。',
      },
      {
        ...base,
        id: newId('pol', now),
        kind: 'constraint',
        strength: 'hard',
        scope: { product: 'code', projectId: project?.projectId, coreRuntimePath: true },
        when: [{ field: 'task.corePath', op: 'eq', value: true }],
        effect: { mode: 'require', action: 'final_verification' },
        exceptions: [],
        instruction: '核心 Runtime / 持久化 / 高回滚成本路径必须保留独立最终验证，不得因减少重复审核而削弱。',
      },
      ...(project && !project.verification.unit ? [{
        ...base,
        id: newId('pol', now + 1),
        kind: 'constraint' as const,
        strength: 'hard' as const,
        scope: { projectId: project.projectId },
        when: [],
        effect: { mode: 'require' as const, action: 'final_verification' },
        exceptions: [] as const,
        instruction: '当前项目缺少自动测试，个性化不得取消最终验证。',
      }] : []),
    ];
  }

  if (model.dimension === 'planning_direct_execution') {
    return [
      {
        ...base,
        id: newId('pol', now),
        kind: 'conditional_decision',
        scope: { product: 'code', taskRisk: ['low', 'medium'], coreRuntimePath: false },
        when: [
          { field: 'task.reversible', op: 'eq', value: true },
          { field: 'task.corePath', op: 'eq', value: false },
        ],
        effect: { mode: 'prefer', action: 'direct_execution' },
        exceptions: ['core_runtime', 'persistent_state', 'high_rollback_cost'],
        instruction: '低风险且可回滚的局部任务优先直接实现，不要先写长篇计划。',
      },
      {
        ...base,
        id: newId('pol', now),
        kind: 'conditional_decision',
        scope: { product: 'code', taskRisk: ['medium', 'high'], coreRuntimePath: true },
        when: [{ field: 'task.corePath', op: 'eq', value: true }],
        effect: { mode: 'require', action: 'plan_first' },
        exceptions: [],
        instruction: '涉及核心架构、状态边界或高回滚成本时，先形成短计划与边界再执行。',
      },
    ];
  }

  if (model.dimension === 'reporting_information_density') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'prompt_directive',
      scope: {},
      when: [],
      effect: { mode: 'avoid', action: 'process_narration' },
      exceptions: [],
      instruction: '汇报只保留结论、产物、关键决策、阻塞和剩余风险，避免低信息密度过程叙述。',
    }];
  }

  if (model.dimension === 'architecture_refactor') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'weighted_heuristic',
      scope: { taskRisk: ['low', 'medium'], coreRuntimePath: false },
      when: [{ field: 'task.corePath', op: 'eq', value: false }],
      effect: { mode: 'avoid', action: 'speculative_abstraction' },
      exceptions: ['core_runtime', 'persistent_state'],
      instruction: '在局部、需求明确的可逆功能中，不为尚未出现的扩展新增抽象层。',
    }];
  }

  if (model.dimension === 'git_change_management') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'weighted_heuristic',
      scope: {},
      when: [],
      effect: { mode: 'prefer', action: 'semantic_checkpoint' },
      exceptions: ['high_rollback_cost'],
      instruction: '以可独立验证的工程单元作为提交边界；高风险修改前建立恢复点。',
    }];
  }

  if (model.dimension === 'security_data_integrity') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'constraint',
      strength: 'hard',
      scope: {},
      when: [],
      effect: { mode: 'forbid', action: 'weaken_security' },
      exceptions: [],
      instruction: '个性化不得降低安全、数据完整性或不可逆操作的工程底线。',
    }];
  }

  if (model.dimension === 'agent_autonomy' || model.dimension === 'interaction_interruption') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'weighted_heuristic',
      scope: { taskRisk: ['low', 'medium'], coreRuntimePath: false },
      when: [{ field: 'task.corePath', op: 'eq', value: false }],
      effect: { mode: 'avoid', action: 'duplicate_review' },
      exceptions: ['core_runtime', 'high_rollback_cost'],
      instruction: '低风险可逆任务减少无信息增量的打断；高风险或核心路径仍要在关键决策点确认。',
    }];
  }

  if (model.dimension === 'work_artifact_workflow') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'prompt_directive',
      scope: { product: 'work' },
      when: [],
      effect: { mode: 'prefer', action: 'deliverable_first' },
      exceptions: [],
      instruction: 'Work 交付优先出可看的一版再改；对外方案、合同或正式文档先给结构再展开。',
    }];
  }

  if (model.dimension === 'tool_workflow') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'conditional_decision',
      scope: { product: 'work', taskRisk: ['low', 'medium'] },
      when: [{ field: 'task.corePath', op: 'eq', value: false }],
      effect: { mode: 'prefer', action: 'direct_execution' },
      exceptions: ['account', 'payment', 'login'],
      instruction: '低风险电脑或浏览器操作自己做完；涉及账号、支付或登录必须先问。',
    }];
  }

  if (model.dimension === 'product_ux_acceptance') {
    return [{
      ...base,
      id: newId('pol', now),
      kind: 'prompt_directive',
      scope: { product: 'work' },
      when: [],
      effect: { mode: 'prefer', action: 'restrained_visual' },
      exceptions: [],
      instruction: 'Work 交付件保持克制、干净的观感，避免花哨或非正式版式。',
    }];
  }

  return [];
}

function modelEligibleForCompile(model: UserModelRecord, project: ProjectContextSnapshot | null): boolean {
  if (!eligible(model)) return false;
  if (!project) return true;
  return isGlobalScope(model.scope) || model.scope.projectId === project.projectId;
}

export function compilePolicies(
  snapshot: UserLearningSnapshot,
  project: ProjectContextSnapshot | null,
  now = Date.now(),
): { bundle: PolicyBundle; rules: readonly PolicyRule[] } {
  const models = activeRecords(snapshot.userModels).filter((model) => modelEligibleForCompile(model, project));
  const bundleId = newId('pb', now);
  const rules = models.flatMap((model) => compileOne(model, project, bundleId, now, snapshot));
  const checksum = sourceHash(rules.map((r) => r.id + r.instruction));
  const bundle: PolicyBundle = {
    id: bundleId,
    userId: snapshot.userId,
    projectId: project?.projectId ?? 'global',
    granularity: project ? 'project' : 'global',
    bundleVersion: (snapshot.policyBundles[snapshot.policyBundles.length - 1]?.bundleVersion ?? 0) + 1,
    schemaVersion: 1,
    skillVersion: SKILL_VERSION,
    userModelBundleVersion: models.length,
    projectContextHash: project?.hash ?? 'none',
    ruleIds: rules.map((r) => r.id),
    status: 'active',
    checksum,
    createdAt: now,
  };
  return { bundle, rules };
}

function matchCondition(condition: PolicyRule['when'][number], task: TaskContext): boolean {
  const value = condition.field === 'task.corePath' ? task.corePath
    : condition.field === 'task.reversible' ? task.reversible
      : condition.field === 'task.risk' ? task.risk
        : condition.field === 'task.changeType' ? task.changeType
          : undefined;
  if (condition.op === 'eq') return value === condition.value;
  if (condition.op === 'neq') return value !== condition.value;
  if (condition.op === 'in') return Array.isArray(condition.value) && condition.value.includes(value);
  if (condition.op === 'not_in') return Array.isArray(condition.value) && !condition.value.includes(value);
  if (condition.op === 'lte' || condition.op === 'gte') {
    const rank = { low: 1, medium: 2, high: 3 } as Record<string, number>;
    const left = typeof value === 'number' ? value : rank[String(value)] ?? 0;
    const right = typeof condition.value === 'number' ? condition.value : rank[String(condition.value)] ?? 0;
    return condition.op === 'lte' ? left <= right : left >= right;
  }
  return true;
}

function inScope(rule: PolicyRule, task: TaskContext, projectId: string): boolean {
  if (rule.scope.product && rule.scope.product !== task.product) return false;
  if (rule.scope.projectId && rule.scope.projectId !== projectId && rule.scope.projectId !== 'global') {
    return false;
  }
  if (rule.scope.coreRuntimePath === true && !task.corePath) return false;
  if (rule.scope.coreRuntimePath === false && task.corePath) return false;
  if (rule.scope.taskRisk && !rule.scope.taskRisk.includes(task.risk)) return false;
  if (rule.scope.changeType && rule.scope.changeType.length > 0 && !rule.scope.changeType.includes(task.changeType)) {
    return false;
  }
  return rule.when.every((c) => matchCondition(c, task));
}

function exceptionHits(rule: PolicyRule, task: TaskContext): boolean {
  if (task.corePath && rule.exceptions.includes('core_runtime')) return true;
  if (!task.reversible && rule.exceptions.includes('high_rollback_cost')) return true;
  if (task.changeType === 'migration' && rule.exceptions.includes('persistent_state')) return true;
  if (task.risk === 'high' && rule.exceptions.includes('security_boundary')) return true;
  return false;
}

function riskFloorBlocks(rule: PolicyRule, task: TaskContext): boolean {
  if (SAFETY_ACTIONS.has(rule.effect.action)) return true;
  if (task.corePath && rule.effect.mode === 'avoid' && /verif|test|backup|review/.test(rule.effect.action) && rule.effect.action !== 'duplicate_review') {
    return true;
  }
  if (task.risk === 'high' && rule.effect.action === 'direct_execution') return true;
  if (task.corePath && rule.effect.action === 'direct_execution') return true;
  return false;
}

function explicitInstructionOverrides(task: TaskContext, rule: PolicyRule): boolean {
  const text = task.explicitInstruction || task.prompt;
  if (!text) return false;
  if (/先(给我)?plan|先规划|先讲清/i.test(text) && rule.effect.action === 'direct_execution') return true;
  if (/直接(干|做|执行)/i.test(text) && rule.effect.action === 'plan_first' && !task.corePath && task.risk !== 'high') {
    return true;
  }
  return false;
}

const PRECEDENCE: Record<PolicyRule['strength'], number> = {
  hard: 100,
  strong_default: 70,
  soft: 40,
  advisory: 10,
};

export function currentBundleFor(
  snapshot: UserLearningSnapshot,
  projectId: string,
): PolicyBundle | undefined {
  const pointed = snapshot.currentProjectBundleIds?.[projectId]
    ?? snapshot.currentBaseBundleId;
  if (pointed) {
    const found = snapshot.policyBundles.find((bundle) => bundle.id === pointed);
    if (found) return found;
  }
  const exact = [...snapshot.policyBundles].reverse().find((bundle) => (
    bundle.projectId === projectId && bundle.status === 'active'
  ));
  if (exact) return exact;
  return [...snapshot.policyBundles].reverse().find((bundle) => (
    bundle.granularity === 'global' && bundle.status === 'active'
  ));
}

function rulesForCurrentBundle(snapshot: UserLearningSnapshot, projectId: string): readonly PolicyRule[] {
  const bundle = currentBundleFor(snapshot, projectId);
  if (bundle) {
    const ids = new Set(bundle.ruleIds);
    return snapshot.policyRules.filter((rule) => ids.has(rule.id));
  }
  return activeRecords(snapshot.policyRules);
}

export function resolvePolicies(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly task: TaskContext;
  readonly projectId: string;
  readonly mode: EnforcementMode;
  readonly now?: number;
  readonly recentlyAsked?: boolean;
  readonly dimensionMode?: Readonly<Partial<Record<PolicyDimension, EnforcementMode>>>;
}): PolicyDecision {
  const started = input.now ?? Date.now();
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const bundle = currentBundleFor(input.snapshot, input.projectId);
  const rules = rulesForCurrentBundle(input.snapshot, input.projectId);
  const matched: PolicyRule[] = [];
  const suppressed: PolicyRule[] = [];
  const conflicts: string[] = [];

  for (const rule of rules) {
    if (!inScope(rule, input.task, input.projectId)) continue;
    if (exceptionHits(rule, input.task) || riskFloorBlocks(rule, input.task) || explicitInstructionOverrides(input.task, rule)) {
      suppressed.push(rule);
      continue;
    }
    matched.push(rule);
  }

  matched.sort((a, b) => PRECEDENCE[b.strength] - PRECEDENCE[a.strength]);
  const byAction = new Map<string, PolicyRule>();
  for (const rule of matched) {
    const prev = byAction.get(rule.effect.action);
    if (!prev) {
      byAction.set(rule.effect.action, rule);
      continue;
    }
    conflicts.push(`${prev.id} vs ${rule.id} on ${rule.effect.action}`);
    if (PRECEDENCE[rule.strength] > PRECEDENCE[prev.strength]) {
      byAction.set(rule.effect.action, rule);
    }
  }

  const chosen = [...byAction.values()].slice(0, MAX_ACTIVE_POLICIES);
  const dimensionMode = input.dimensionMode ?? {};
  const enforced: ActivePolicyRule[] = [];
  const shadow: ActivePolicyRule[] = [];
  const off: ActivePolicyRule[] = [];
  const suppressedRows: SuppressedPolicyRule[] = suppressed.map((rule) => ({
    policyId: rule.id,
    domain: rule.domain,
    instruction: rule.instruction,
    reason: 'exception_or_safety_floor',
  }));
  for (const rule of chosen) {
    const row: ActivePolicyRule = {
      policyId: rule.id,
      domain: rule.domain,
      mode: rule.effect.mode,
      instruction: rule.instruction,
      applicationScore: rule.confidence.score,
      reason: `scope match; ${rule.kind}; ${rule.strength}`,
    };
    const dimMode = dimensionMode[rule.domain] ?? input.mode;
    if (dimMode === 'off') {
      off.push(row);
      suppressedRows.push({
        policyId: rule.id,
        domain: rule.domain,
        instruction: rule.instruction,
        reason: 'dimension_off',
      });
    } else if (dimMode === 'shadow') {
      shadow.push(row);
    } else {
      enforced.push(row);
    }
  }
  const active = [...enforced, ...shadow];
  let injectionText = renderInjection(enforced);
  while (estimateTokens(injectionText) > MAX_ACTIVE_POLICY_TOKENS && enforced.length > 1) {
    const removed = enforced.pop();
    if (removed) shadow.push(removed);
    injectionText = renderInjection(enforced);
  }

  const latency = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  const draft: PolicyDecision = {
    id: newId('pd', started),
    userId: input.snapshot.userId,
    projectId: input.projectId,
    taskId: sourceHash([input.task.prompt, input.task.risk, String(input.task.corePath)]),
    bundleVersion: bundle?.bundleVersion ?? input.snapshot.policyBundles.at(-1)?.bundleVersion ?? 0,
    contextHash: sourceHash([input.task.prompt, input.projectId, input.task.risk]),
    currentBundleId: bundle?.id,
    matchedRuleIds: chosen.map((r) => r.id),
    suppressedRuleIds: suppressedRows.map((r) => r.policyId),
    resolvedActions: chosen.map((r) => `${r.effect.mode}:${r.effect.action}`),
    active,
    enforced: [...enforced],
    shadow,
    off,
    suppressed: suppressedRows,
    injectionText,
    tokenCountEstimate: estimateTokens(injectionText),
    clarificationRequired: false,
    conflicts,
    mode: input.mode,
    injected: enforced.length > 0,
    resolveLatencyMs: Math.max(0, latency),
    createdAt: started,
  };
  const impact = evaluatePreferenceImpact({
    task: input.task,
    decision: draft,
    recentlyAsked: input.recentlyAsked,
  });
  const gated = applyImpactSuppression(draft, impact);
  const interrupt = impact.interruptUser === true;
  const enforcedRules = interrupt ? [] : gated.enforced;
  const injection = renderInjection(enforcedRules);
  return {
    ...gated,
    enforced: enforcedRules,
    injectionText: injection,
    tokenCountEstimate: estimateTokens(injection),
    injected: enforcedRules.length > 0,
    impactCheck: impact,
  };
}

export function renderInjection(active: readonly ActivePolicyRule[]): string {
  if (active.length === 0) return '';
  const lines = active.map((rule, i) => `${i + 1}. ${rule.instruction}`);
  return [
    '<trylo_active_engineering_policy>',
    'These are scoped engineering personalization rules.',
    'They do not override system/product constraints or valid explicit current-task instructions.',
    ...lines,
    '</trylo_active_engineering_policy>',
  ].join('\n');
}

export function enforcementFor(
  settingsMode: EnforcementMode,
  dimension: PolicyDimension,
  dimensionMode: Readonly<Partial<Record<PolicyDimension, EnforcementMode>>>,
): EnforcementMode {
  return dimensionMode[dimension] ?? settingsMode;
}

export function effectiveMode(
  settingsMode: EnforcementMode,
  active: readonly ActivePolicyRule[],
  dimensionMode: Readonly<Partial<Record<PolicyDimension, EnforcementMode>>>,
): EnforcementMode {
  if (settingsMode === 'off') return 'off';
  if (active.length === 0) return settingsMode;
  const modes = active.map((rule) => dimensionMode[rule.domain] ?? settingsMode);
  if (modes.every((m) => m === 'enforced')) return 'enforced';
  if (modes.every((m) => m === 'off')) return 'off';
  return modes.includes('enforced') && !modes.includes('shadow') ? 'enforced' : settingsMode === 'enforced' && modes.includes('shadow') ? 'shadow' : settingsMode;
}
