import { newId } from './ids';
import { sameStableScope, userModelStableKey } from './scope';
import { activeRecords } from './store';
import type {
  ConclusionRecord,
  InferenceDistance,
  ProfessionalProfileFact,
  UserModelDerivation,
  UserModelRecord,
  UserLearningSnapshot,
} from './types';

const D3_RE = /懒|笨|差|讨厌|没有耐心|人格|性格|心理/i;
const FOOD_RE = /吃|牛肉|食物|电影|音乐/;

const DISTANCE_CAP: Record<Exclude<InferenceDistance, 'D3'>, number> = {
  D0: 0.95,
  D1: 0.88,
  D2: 0.72,
};

export function classifyInferenceDistance(statement: string, conclusion: string): InferenceDistance {
  if (D3_RE.test(statement)) return 'D3';
  if (statement.includes(conclusion.slice(0, 24)) || similar(statement, conclusion)) return 'D0';
  if (/信号|可靠性|不应|不适合作为|验收/.test(statement)) return 'D1';
  return 'D2';
}

function similar(a: string, b: string): boolean {
  return a.slice(0, 40) === b.slice(0, 40) || b.includes(a.slice(0, 18));
}

function productRelevant(statement: string): boolean {
  return !FOOD_RE.test(statement);
}

function engineeringStatement(conclusion: ConclusionRecord): string {
  if (conclusion.dimension === 'verification_audit') {
    return '在中低风险 Coding 任务中，用户对重复、同质 Review 的容忍度较低；但这一倾向不应解释为降低核心状态链路的最终可靠性验证。';
  }
  if (conclusion.dimension === 'planning_direct_execution') {
    return '对低风险、局部、可回滚任务，用户偏好 Agent 直接执行；当任务涉及核心架构、状态边界或高回滚成本时，用户更重视先建立明确方案与边界。';
  }
  if (conclusion.dimension === 'reporting_information_density') {
    return '在执行类任务中，用户对低信息密度的过程性叙述接受度较低；高价值交流应集中于需要用户判断的决策、任务状态、产物与无法自行消解的风险。';
  }
  if (conclusion.dimension === 'architecture_refactor') {
    return '对普通、可逆功能，用户倾向控制抽象层级并延后不确定扩展；在核心 Runtime、持久化与高回滚成本路径中，该偏好明显弱化。';
  }
  if (conclusion.dimension === 'git_change_management') {
    return '用户更倾向在一组修改达到可独立验证的稳定状态后形成 Git checkpoint，而不是按短时间间隔频繁提交；高风险或大范围变更是该习惯的重要例外。';
  }
  if (conclusion.dimension === 'work_artifact_workflow') {
    return '普通报告或幻灯片，用户倾向先出一版再改；对外方案、合同或正式文档则要求先看结构再展开。';
  }
  if (conclusion.dimension === 'tool_workflow') {
    return '低风险电脑或浏览器操作上，用户倾向 Agent 自己做完；涉及账号、支付或登录时必须先确认。';
  }
  if (conclusion.dimension === 'product_ux_acceptance') {
    return '用户对 Work 交付件的观感要求偏克制、干净，不接受花哨或非正式的版式。';
  }
  return conclusion.statement;
}

function alternatives(conclusion: ConclusionRecord): readonly string[] {
  const out: string[] = [];
  if (conclusion.evidence.counter.length > 0) {
    out.push('反证表明该模式可能只适用于特定任务类型或风险等级');
  }
  if (conclusion.temporal.state === 'disputed' || conclusion.temporal.state === 'drifting') {
    out.push('该结论仍在漂移，可能是项目局部习惯而不是长期工程偏好');
  }
  if (/approve|approval|快速/.test(conclusion.statement)) {
    out.push('用户当前没有时间审核', '审核 UI 成本过高', '用户认为该任务风险低');
  }
  if (out.length === 0) {
    return ['该模式只是当前项目局部习惯', '该模式只适用于单一任务类型'];
  }
  return [...new Set(out)].slice(0, 4);
}

function preferredStatement(
  conclusion: ConclusionRecord,
  profile: readonly ProfessionalProfileFact[],
): string {
  const raw = conclusion.statement.trim();
  const scoped = raw.length >= 24 && /不应|不适合|低风险|核心|作用域|可回滚/.test(raw)
    ? raw
    : engineeringStatement(conclusion);
  const role = profile.find((item) => item.category === 'role_identity' && !FOOD_RE.test(item.statement));
  if (!role || scoped.includes(role.statement.slice(0, 8))) return scoped;
  return `${scoped}（协作语境：${role.statement.slice(0, 48)}）`;
}

export function reasonUserModels(
  snapshot: UserLearningSnapshot,
  conclusions: readonly ConclusionRecord[],
  now = Date.now(),
): { models: readonly UserModelRecord[]; derivations: readonly UserModelDerivation[] } {
  const models: UserModelRecord[] = [];
  const derivations: UserModelDerivation[] = [];
  const profile = activeRecords(snapshot.profileFacts);
  for (const conclusion of conclusions) {
    if (conclusion.status !== 'active') continue;
    if (!productRelevant(conclusion.statement)) {
      derivations.push(reject(conclusion, 'product_relevance', now));
      continue;
    }
    const statement = preferredStatement(conclusion, profile);
    const distance = classifyInferenceDistance(statement, conclusion.statement);
    if (distance === 'D3') {
      derivations.push(reject(conclusion, 'd3_forbidden', now));
      continue;
    }
    if (conclusion.strength.band === 'low' && distance === 'D2') {
      derivations.push(reject(conclusion, 'weak_conclusion', now));
      continue;
    }
    const cap = DISTANCE_CAP[distance];
    const score = Math.min(cap, conclusion.strength.score);
    const existing = activeRecords(snapshot.userModels)
      .find((m) => m.dimension === conclusion.dimension && m.userId === conclusion.userId && sameStableScope(m.scope, conclusion.scope));
    const model: UserModelRecord = {
      id: newId('um', now),
      userId: conclusion.userId,
      statement,
      dimension: conclusion.dimension,
      scope: conclusion.scope,
      confidence: {
        score,
        band: score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low',
      },
      inference: {
        distance,
        alternativeExplanations: alternatives(conclusion),
        rationaleSummary: `Derived from conclusion ${conclusion.id} at ${distance}.`,
      },
      derivedFrom: { conclusionIds: [conclusion.id] },
      profileDependencies: profile
        .filter((item) => !FOOD_RE.test(item.statement) && statement.includes(item.statement.slice(0, 8)))
        .map((item) => item.id),
      counterevidence: conclusion.evidence.counter,
      status: 'active',
      version: existing ? existing.version + 1 : 1,
      supersedes: existing?.id,
      stableKey: userModelStableKey(conclusion.userId, conclusion.dimension, conclusion.scope),
      createdAt: now,
      updatedAt: now,
    };
    models.push(model);
    derivations.push({
      id: newId('umd', now),
      userId: conclusion.userId,
      userModelId: model.id,
      conclusionIds: [conclusion.id],
      profileIds: model.profileDependencies,
      inferenceDistance: distance,
      rejected: false,
      createdAt: now,
    });
  }
  return { models, derivations };
}

function reject(conclusion: ConclusionRecord, reason: string, now: number): UserModelDerivation {
  return {
    id: newId('umd', now),
    userId: conclusion.userId,
    userModelId: '',
    conclusionIds: [conclusion.id],
    profileIds: [],
    inferenceDistance: 'D0',
    rejected: true,
    rejectReason: reason,
    createdAt: now,
  };
}

export function ingestProfileFact(input: {
  readonly userId: string;
  readonly category: ProfessionalProfileFact['category'];
  readonly statement: string;
  readonly evidenceRefs?: readonly string[];
  readonly now?: number;
}): ProfessionalProfileFact | null {
  if (FOOD_RE.test(input.statement) || D3_RE.test(input.statement)) return null;
  const now = input.now ?? Date.now();
  return {
    id: newId('pf', now),
    userId: input.userId,
    category: input.category,
    statement: input.statement,
    evidenceRefs: input.evidenceRefs ?? [],
    confidence: { score: 0.8, band: 'high' },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}
