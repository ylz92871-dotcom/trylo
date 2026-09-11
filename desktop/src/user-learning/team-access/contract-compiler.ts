// EngineeringContract deterministic compiler (PR-2).
//
// Spec §8.5. `fallbackContract` is 0-LLM: explicit comes only from the
// user's own sentences, baseline from `engineeringBaseline()` plus the
// always-present security floor. `compileEngineeringContract` layers
// inferred clauses from active User Models on top; it must never paste
// a UM statement into explicit. Compile failures throw only where the
// caller can fall back; every path keeps baseline non-empty.
import { engineeringBaseline } from '../impact-check';
import { newId, sourceHash } from '../ids';
import type {
  TaskContext,
  UserLearningSnapshot,
} from '../types';
import {
  MAX_CLAUSE_CHARS,
  MAX_CONTRACT_TOKENS,
  MAX_EXPLICIT_CLAUSES,
  MAX_INFERRED_CLAUSES,
  type ContractAuthority,
  type ContractClause,
  type ContractClauseField,
  type EngineeringContract,
  type InferredClause,
} from './contract-types';
import { serializeContract } from './contract-serialize';

const EXPLICIT_KEEP =
  /必须|不要|别(?!人)|禁止|不得|一定要|验收|交付给我|先计划|先 plan|不要问|别再/;

const SECURITY_FLOOR_TEXT =
  '个性化不得降低安全、数据完整性或不可逆操作的工程底线。';

const CODE_BASELINE_TEXTS: Readonly<Record<string, string>> = {
  'require:plan_first': '核心或高回滚路径必须先形成短计划再改。',
  'require:final_verification':
    '必须保留有意义的最终验证（测试、typecheck 或等价检查），用户偏好不得取消。',
};

// Spec §8.5 rule 2: `prefer:direct_execution` / `avoid:duplicate_review`
// are personalized leanings, NOT baseline clauses — they are intentionally
// absent here so `baselineClauses` skips them. The Work .trylo/out +
// OfficeCLI-validate baseline content is carried by `WORK_ALWAYS` below.
const WORK_BASELINE_TEXTS: Readonly<Record<string, string>> = {
  'require:plan_first': '核心或高回滚路径必须先形成短计划再改。',
  'require:final_verification':
    '必须保留有意义的最终验证（OfficeCLI validate 或等价检查），用户偏好不得取消。',
};

// Spec §16 (Plane J): Work-only baseline clauses. These must never enter a
// Code contract, so `baselineClauses` pushes them only when product==='work'.
const WORK_ALWAYS: readonly { readonly field: ContractClauseField; readonly text: string }[] = [
  { field: 'prohibited', text: '产物写在 .trylo/out/，不得写入源码树。' },
  { field: 'review', text: 'Office 文件用 OfficeCLI；不得自造 Office 栈。' },
  { field: 'review', text: '不得把用户 approval 当 validate 通过。' },
];

function fieldForExplicit(sentence: string): ContractClauseField {
  if (/禁止|不得写|不要写|别写进/.test(sentence)) return 'prohibited';
  if (/验收|怎么验|验收标准/.test(sentence)) return 'acceptance';
  if (/安全|密钥|权限/.test(sentence)) return 'security';
  if (/不要太复杂|别搞复杂|最小|抽象/.test(sentence)) return 'architecture';
  return 'goal';
}

function clampClauseText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CLAUSE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_CLAUSE_CHARS - 1)}…`;
}

function clause(
  authority: Exclude<ContractAuthority, 'inferred'>,
  text: string,
  field: ContractClauseField,
): ContractClause {
  return {
    id: newId('cl'),
    authority,
    text: clampClauseText(text),
    field,
  };
}

/** Split into sentences; each kept clause must be a verbatim substring. */
function splitSentences(prompt: string): readonly string[] {
  return prompt
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function explicitFromPrompt(prompt: string): readonly ContractClause[] {
  const kept: ContractClause[] = [];
  for (const sentence of splitSentences(prompt)) {
    if (!EXPLICIT_KEEP.test(sentence)) continue;
    if (!prompt.includes(sentence)) continue;
    kept.push(clause('explicit', sentence, fieldForExplicit(sentence)));
    if (kept.length >= MAX_EXPLICIT_CLAUSES) break;
  }
  return kept;
}

function baselineClauses(task: TaskContext): readonly ContractClause[] {
  const texts = task.product === 'work' ? WORK_BASELINE_TEXTS : CODE_BASELINE_TEXTS;
  const out: ContractClause[] = [];
  for (const token of engineeringBaseline(task)) {
    const text = texts[token];
    if (!text) continue; // personalized-leaning tokens are not baseline clauses
    const field: ContractClauseField = token.endsWith('plan_first')
      ? 'autonomy'
      : 'review';
    out.push(clause('baseline', text, field));
  }
  if (task.product === 'work') {
    for (const item of WORK_ALWAYS) {
      out.push(clause('baseline', item.text, item.field));
    }
  }
  // The security floor is always present and guarantees ≥ 1 baseline clause.
  out.push(clause('baseline', SECURITY_FLOOR_TEXT, 'security'));
  return out;
}

function recommendationFromTask(task: TaskContext): readonly ContractClause[] {
  // v0: single deterministic recommendation; seats may rebut with evidence.
  if (task.product === 'work') {
    return [clause('recommendation', '交付前向 Person 代表汇报产物清单。', 'acceptance')];
  }
  return [];
}

function titleFromPrompt(prompt: string): string {
  const first = splitSentences(prompt)[0] ?? 'Team 任务';
  if (first.length <= 24) return first;
  return `${first.slice(0, 23)}…`;
}

function oneLinerFromPrompt(prompt: string): string {
  const first = splitSentences(prompt)[0] ?? 'Team 任务';
  if (first.length <= 80) return first;
  return `${first.slice(0, 79)}…`;
}

/**
 * Deterministic fallback: 0 LLM, inferred empty, explicit only from the
 * user's own sentences, baseline from engineeringBaseline + security
 * floor. This is the mandatory degradation path (spec §0 rule 12).
 */
export function fallbackContract(input: {
  readonly prompt: string;
  readonly task: TaskContext;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly personConversationId: string;
  readonly now?: number;
}): EngineeringContract {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: 1,
    contractId: newId('ec', now),
    version: 1,
    product: input.task.product,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    personConversationId: input.personConversationId,
    task: {
      title: titleFromPrompt(input.prompt),
      goal: input.task.explicitInstruction || input.task.prompt || input.prompt,
      oneLiner: oneLinerFromPrompt(input.prompt),
    },
    authority: {
      explicit: explicitFromPrompt(input.prompt),
      inferred: [],
      baseline: baselineClauses(input.task),
      recommendation: recommendationFromTask(input.task),
    },
    provenance: {
      compiledAt: now,
      compiler: 'deterministic_fallback',
      userModelIds: [],
      preferenceStubUsed: false,
      sourceHash: sourceHash([input.prompt, input.task.product]),
    },
  };
}

interface CandidateInferred {
  readonly text: string;
  readonly confidence: number;
  readonly uncertainty: 'low' | 'medium' | 'high';
  readonly field: ContractClauseField;
  readonly sourceUserModelIds: readonly string[];
}

/**
 * Known-dimension templates (spec §9.3 catalog). Any UM whose dimension
 * has no template here emits nothing — deferred, not invented.
 */
function inferredFromSnapshot(
  snapshot: UserLearningSnapshot,
  task: TaskContext,
): readonly CandidateInferred[] {
  const out: CandidateInferred[] = [];
  for (const um of snapshot.userModels) {
    if (um.status !== 'active') continue;
    if (um.confidence.score < 0.5) continue; // below medium
    if (um.dimension !== 'verification_audit' && um.dimension !== 'domain_capability_feedback_reliability') {
      continue; // v0 catalog: only these two dimensions compile
    }
    if (um.dimension === 'verification_audit' && task.product === 'code') {
      out.push({
        text: `用户即时 frontend code approval 不是强验证信号 (${um.confidence.band})`,
        confidence: um.confidence.score,
        uncertainty: um.confidence.band,
        field: 'review',
        sourceUserModelIds: [um.id],
      });
    }
    if (um.dimension === 'domain_capability_feedback_reliability') {
      out.push({
        text: `用户在 ${um.statement.slice(0, 24)} 相关领域能力有限，按 baseline 兜底 (${um.confidence.band})`,
        confidence: um.confidence.score,
        uncertainty: um.confidence.band,
        field: 'risk',
        sourceUserModelIds: [um.id],
      });
    }
    if (out.length >= MAX_INFERRED_CLAUSES) break;
  }
  return out;
}

/**
 * Fallback contract plus inferred/recommendation filled from the User
 * Model. Never copies a UM statement verbatim into explicit.
 */
export function compileEngineeringContract(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly task: TaskContext;
  readonly workspaceRoot: string;
  readonly personConversationId: string;
  readonly now?: number;
}): EngineeringContract {
  const base = fallbackContract({
    prompt: input.task.prompt,
    task: input.task,
    workspaceId: input.workspaceRoot,
    projectId: input.snapshot.projectContexts[0]?.projectId ?? 'proj:unknown',
    personConversationId: input.personConversationId,
    now: input.now,
  });
  const candidates = inferredFromSnapshot(input.snapshot, input.task);
  const inferred: InferredClause[] = candidates.map((c) => ({
    id: newId('cl', input.now),
    authority: 'inferred',
    text: clampClauseText(c.text),
    field: c.field,
    confidence: c.confidence,
    uncertainty: c.uncertainty,
    sourceUserModelIds: c.sourceUserModelIds,
  }));
  const withInferred: EngineeringContract = {
    ...base,
    authority: { ...base.authority, inferred },
    provenance: {
      ...base.provenance,
      compiler: 'template',
      userModelIds: inferred.flatMap((c) => [...c.sourceUserModelIds]),
    },
  };
  return trimContractToTokenBudget(withInferred);
}

/**
 * Drop clauses when the serialized contract exceeds the token budget:
 * recommendation first, then inferred (lowest confidence first). Never
 * drops explicit or baseline (spec §8.5 rule 5).
 */
export function trimContractToTokenBudget(c: EngineeringContract): EngineeringContract {
  if (estimateContractTokens(c) <= MAX_CONTRACT_TOKENS) return c;
  let next = c;
  if (next.authority.recommendation.length > 0) {
    next = { ...next, authority: { ...next.authority, recommendation: [] } };
  }
  if (estimateContractTokens(next) <= MAX_CONTRACT_TOKENS) return next;
  const inferred = [...next.authority.inferred].sort((a, b) => a.confidence - b.confidence);
  while (inferred.length > 0 && estimateContractTokens({ ...next, authority: { ...next.authority, inferred } }) > MAX_CONTRACT_TOKENS) {
    inferred.shift();
  }
  return { ...next, authority: { ...next.authority, inferred } };
}

export function estimateContractTokens(c: EngineeringContract): number {
  return Math.max(1, Math.ceil(serializeContract(c).length / 4));
}

/**
 * Revision after Cognition answers or user steer: version +1, supersedes
 * points at the previous id, new explicit clauses are appended, and
 * resolved items are removed from inferred. Baseline is never touched.
 */
export function reviseContract(
  previous: EngineeringContract,
  patch: {
    readonly newExplicit?: readonly ContractClause[];
    readonly resolvedUnknown?: readonly string[];
    readonly now: number;
  },
): EngineeringContract {
  const resolved = new Set(patch.resolvedUnknown ?? []);
  const inferred = previous.authority.inferred.filter(
    (c) => ![...resolved].some((r) => c.text.includes(r)),
  );
  const newExplicit = (patch.newExplicit ?? []).map((c) => ({
    ...c,
    id: newId('cl', patch.now),
    authority: 'explicit' as const,
    text: clampClauseText(c.text),
  }));
  return {
    ...previous,
    contractId: newId('ec', patch.now),
    version: previous.version + 1,
    supersedes: previous.contractId,
    authority: {
      ...previous.authority,
      explicit: [...previous.authority.explicit, ...newExplicit],
      inferred,
    },
    provenance: {
      ...previous.provenance,
      compiledAt: patch.now,
    },
  };
}
