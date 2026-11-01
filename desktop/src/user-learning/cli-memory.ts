import type { ProcessService } from '../host-adapter/process-service';
import { runCliCommand as runMemoryCommand } from '../host-adapter/cli-command';
import type { FilePath } from '../host-adapter/types';
import type {
  ProfessionalProfileFact,
  ProfileCategory,
  UserLearningSnapshot,
} from './types';

/**
 * WP-CL / B：面板读的是 CLI 的正式用户账，不是自己那份 localStorage。
 *
 * 这条接线的全部意义在于"同一个 recordId"。面板若自己解析 `facts.ndjson`，
 * 就会成为第二个 schema 读者，两端的字段迟早漂移；所以这里**只跑命令、只解
 * JSON**，schema 归 CLI 所有。
 *
 * 只读：面板不改写。要改就走 CLI 的 `memory_import` / 对话里的 `memory_remember`，
 * 一次只有一个 writer。
 */

/** `trylo memory list --json` 的行形状（CLI 是唯一定义者）。 */
export type CliMemoryFact = {
  readonly id: string;
  readonly version: number;
  readonly status: 'active' | 'retracted';
  readonly factKind: 'identity_fact' | 'preference' | 'project_fact';
  readonly subject: string;
  readonly statement: string;
  readonly createdAt: number;
};

export type CliMemoryLoad =
  | { readonly ok: true; readonly facts: ReadonlyArray<CliMemoryFact> }
  | { readonly ok: false; readonly reason: string };

const FACT_KINDS = new Set(['identity_fact', 'preference', 'project_fact']);

function decodeFact(raw: unknown): CliMemoryFact | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const f = raw as Record<string, unknown>;
  if (typeof f['id'] !== 'string' || f['id'].length === 0) return undefined;
  if (typeof f['version'] !== 'number' || !Number.isInteger(f['version'])) return undefined;
  if (f['status'] !== 'active' && f['status'] !== 'retracted') return undefined;
  if (typeof f['factKind'] !== 'string' || !FACT_KINDS.has(f['factKind'])) return undefined;
  if (typeof f['subject'] !== 'string' || typeof f['statement'] !== 'string') return undefined;
  if (typeof f['createdAt'] !== 'number' || !Number.isFinite(f['createdAt'])) return undefined;
  return {
    id: f['id'], version: f['version'], status: f['status'], factKind: f['factKind'] as CliMemoryFact['factKind'],
    subject: f['subject'], statement: f['statement'], createdAt: f['createdAt'],
  };
}

/**
 * 解一行 JSON。**整份拒绝**，不部分接受：一个只解了一半的记忆列表比空列表更危险，
 * 它看起来像"只记得这么多"。
 */
export function parseMemoryListJson(stdout: string): CliMemoryLoad {
  const line = stdout.split('\n').map((item) => item.trim()).filter((item) => item.length > 0).at(-1);
  if (line === undefined) return { ok: false, reason: 'empty_output' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>)['facts'])) {
    return { ok: false, reason: 'missing_facts' };
  }
  const facts: CliMemoryFact[] = [];
  for (const raw of (parsed as Record<string, unknown>)['facts'] as unknown[]) {
    const fact = decodeFact(raw);
    if (fact === undefined) return { ok: false, reason: 'invalid_fact' };
    facts.push(fact);
  }
  return { ok: true, facts };
}

/**
 * 事实类别 → 面板既有的资料分类。
 *
 * 只是**展示分组**，不是二次语义：右侧那一列本来按"角色与身份 / 专业领域 /
 * 能力背景 / 长期工作场景"分区，正式账里的三类事实要有地方落。映射关系写在这里
 * 而不是散在组件里，改的时候只有一个地方。
 */
const CATEGORY_OF: Readonly<Record<CliMemoryFact['factKind'], ProfileCategory>> = {
  identity_fact: 'role_identity',
  preference: 'capability_background',
  project_fact: 'long_term_work_context',
};

export function toProfileFacts(
  facts: ReadonlyArray<CliMemoryFact>,
  userId: string,
): ReadonlyArray<ProfessionalProfileFact> {
  return facts.map((fact) => ({
    // The panel's id IS the CLI recordId: "the model saved it" and "the panel
    // shows it" must name the same record, not two records that look alike.
    id: fact.id,
    userId,
    category: CATEGORY_OF[fact.factKind],
    statement: fact.statement,
    evidenceRefs: [fact.id],
    // The user said it themselves, so it is not an inference: high confidence,
    // active status, and the ledger's own creation time.
    confidence: { score: 1, band: 'high' as const },
    status: fact.status === 'active' ? ('active' as const) : ('retired' as const),
    createdAt: fact.createdAt,
    updatedAt: fact.createdAt,
  }));
}

/**
 * 把 CLI 事实并进面板快照。
 *
 * CLI 记录优先：同一 id 在 localStorage 里也有一份时，以正式账为准（它才是权威）。
 * 只替换 `profileFacts` 一个字段，其余面板数据原样保留——这个包不迁移别的东西。
 */
export function withCliFacts(
  snapshot: UserLearningSnapshot,
  facts: ReadonlyArray<CliMemoryFact>,
  userId: string,
): UserLearningSnapshot {
  const local = snapshot.profileFacts.filter((fact) => !(fact.id.startsWith('fact-') && fact.evidenceRefs.includes(fact.id)));
  if (facts.length === 0 && local.length === snapshot.profileFacts.length) return snapshot;
  const fromCli = toProfileFacts(facts, userId);
  const cliIds = new Set(fromCli.map((fact) => fact.id));
  return {
    ...snapshot,
    profileFacts: [...local.filter((fact) => !cliIds.has(fact.id)), ...fromCli],
  };
}

export async function mutateCliMemory(input: {
  readonly process: Pick<ProcessService, 'spawn' | 'stop' | 'send' | 'closeInput'>;
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly action: 'correct' | 'retract';
  readonly recordId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly statement?: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const result = await runMemoryCommand({ ...input, args: ['memory', input.action === 'correct' ? 'update' : 'retract', '--json'],
    stdin: JSON.stringify({ recordId: input.recordId, expectedVersion: input.expectedVersion, commandId: input.commandId,
      ...(input.statement === undefined ? {} : { statement: input.statement }) }),
  });
  if (!result.ok) return result;
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value === 'object' && value !== null && 'result' in value
      && (value.result === 'saved' || value.result === 'already_saved')) return { ok: true };
  } catch { return { ok: false, reason: 'invalid_receipt' }; }
  return { ok: false, reason: 'memory_not_committed' };
}

export async function loadCliMemoryFacts(input: {
  readonly process: Pick<ProcessService, 'spawn' | 'stop'>;
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly timeoutMs?: number;
}): Promise<CliMemoryLoad> {
  const result = await runMemoryCommand({ ...input, args: ['memory', 'list', '--json'] });
  return result.ok ? parseMemoryListJson(result.stdout) : result;
}

/**
 * 删除本机的全部用户记忆（B20）。
 *
 * 面板的删除只能清它自己那份；正式账在 CLI 那边。两边不是一个动作，"删除全部"
 * 就是一句半真半假的话——所以面板必须先确认 CLI 真的删掉了，再清本地。
 */
export async function deleteCliUserMemory(input: {
  readonly process: Pick<ProcessService, 'spawn' | 'stop'>;
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly timeoutMs?: number;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const result = await runMemoryCommand({ ...input, args: ['memory', 'delete', '--all', '--yes', '--json'] });
  return result.ok ? { ok: true } : result;
}

/** The migration document `trylo memory import` consumes (B17, panel side). */
export type LegacyExportEntry = {
  readonly legacyId: string;
  readonly subject: string;
  readonly statement: string;
  readonly factKind: CliMemoryFact['factKind'];
  readonly scope: { readonly kind: 'user'; readonly userId: string };
  readonly provenance: 'user_stated' | 'assistant_inferred' | 'unknown';
  readonly status: 'active' | 'retracted' | 'candidate';
  readonly createdAt: number;
};

/** 只有用户自己说过的证据才算数——与 CLI 侧的导入判据同源。 */
const USER_STATED_EVENTS: ReadonlySet<string> = new Set(['explicit_statement', 'correction']);

const FACT_KIND_OF: Readonly<Record<ProfileCategory, CliMemoryFact['factKind']>> = {
  role_identity: 'identity_fact',
  domain_industry: 'identity_fact',
  capability_background: 'preference',
  long_term_work_context: 'project_fact',
};

/** 面板资料里的主体名，能认出来就认，认不出就用"用户"（只是展示字段）。 */
function subjectOf(statement: string): string {
  // 名字里允许有空格（"YL Z"），但不跨标点：认不出来就用"用户"，
  // 这一格只是展示，不值得为它猜。
  const match = /^我(?:是|叫|的名字是)\s*([^，。,.！!？?\n]{1,20})/u.exec(statement);
  return match?.[1]?.trim() || '用户';
}

/**
 * 把面板快照导出成 CLI 能导入的窄文档（B17 的另一半）。
 *
 * 关键的一格是 `provenance`：它**不是**由"这条事实看起来像什么"决定的，而是由
 * 这条事实引用的证据里，有没有一条是用户自己说的（`explicit_statement` /
 * `correction`）。没有就写 `unknown`，CLI 侧会把它留在原地——宁可少迁，也不能把
 * 模型推断的东西洗成用户明言。
 *
 * 这只是生成一份文件；真正的写入仍然发生在 `trylo memory import`。
 */
export function snapshotToLegacyDocument(snapshot: UserLearningSnapshot): {
  readonly version: 1;
  readonly facts: ReadonlyArray<LegacyExportEntry>;
} {
  const evidenceById = new Map(snapshot.evidence.map((record) => [record.id, record]));
  const facts = snapshot.profileFacts
    .filter((fact) => fact.status === 'active')
    .map((fact): LegacyExportEntry => {
      const userStated = fact.evidenceRefs.some((id) => {
        const evidence = evidenceById.get(id);
        return evidence !== undefined && USER_STATED_EVENTS.has(evidence.origin.eventType);
      });
      return {
        legacyId: fact.id,
        subject: subjectOf(fact.statement),
        statement: fact.statement,
        factKind: FACT_KIND_OF[fact.category],
        scope: { kind: 'user', userId: fact.userId },
        provenance: userStated ? 'user_stated' : 'unknown',
        status: 'active',
        createdAt: fact.createdAt,
      };
    });
  return { version: 1, facts };
}
