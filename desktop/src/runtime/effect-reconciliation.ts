import { runCliCommand } from '../host-adapter/cli-command';
import type { ProcessService } from '../host-adapter/process-service';
import type { FilePath } from '../host-adapter/types';

/**
 * 未确认副作用的人工核对（Desktop 侧的入口）。
 *
 * 未确认结果不再阻止 --resume。下一轮保留未知事实并可继续检查；这里提供
 * 可选的人工结果记录，不自动重放操作，也不把人工判定作为聊天的前置条件。
 *
 * 这里只做两件事：读引擎已经算好的清单，和在用户判定后把判定写回。清单的
 * 定义权、判定的合法性、写入的路径全部归 CLI；Desktop 不解析 journal，也不
 * 自己决定什么算"已确认"。
 *
 * 调用时机：会话没有在跑的轮次（引擎的会话锁会直接拒绝并发写入，所以这条
 * 不是靠这里自觉，而是靠 CLI 拒绝）。
 */

/** `trylo session reconcile <id> --json` 的一项。CLI 是唯一定义者。 */
export type PendingEffect = {
  readonly turn?: string;
  readonly key: string;
  readonly issuedAtSequence: number;
  readonly issuedAt: string;
  /** 缺失表示 journal 里已经没有这次调用，只剩"发出过"的意图。 */
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
};

export type PendingEffectRead =
  | { readonly ok: true; readonly pending: ReadonlyArray<PendingEffect>; readonly openBlocks: number }
  | { readonly ok: false; readonly reason: string };

/** 引擎只接受这两个终局判定；没有"还算不确定"可写。 */
export type EffectVerdict = 'committed' | 'failed';

export type ReconcileCliTarget = {
  readonly process: Pick<ProcessService, 'spawn' | 'stop'> & Partial<Pick<ProcessService, 'send' | 'closeInput' | 'list'>>;
  readonly cliPath: FilePath;
  readonly nodeProgram?: string;
  readonly cwd: FilePath;
  readonly timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePending(raw: unknown): PendingEffect | undefined {
  if (!isRecord(raw)) return undefined;
  const key = raw['key'];
  const sequence = raw['issuedAtSequence'];
  const issuedAt = raw['issuedAt'];
  if (typeof key !== 'string' || key.length === 0) return undefined;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return undefined;
  if (typeof issuedAt !== 'string' || issuedAt.length === 0) return undefined;

  const turn = raw['turn'];
  const tool = raw['tool'];
  const args = raw['arguments'];
  return {
    key,
    issuedAtSequence: sequence,
    issuedAt,
    ...(typeof turn === 'string' && turn.length > 0 ? { turn } : {}),
    ...(typeof tool === 'string' && tool.length > 0 ? { tool } : {}),
    ...(isRecord(args) ? { arguments: args } : {}),
  };
}

/**
 * 解一份清单。整份接受或整份拒绝：只解了一半的清单会让"还有几件事要核对"
 * 变成一个更小的数字，比空清单更容易骗人。
 */
export function parsePendingJson(stdout: string): PendingEffectRead {
  const line = stdout.split('\n').map((item) => item.trim()).filter((item) => item.length > 0).at(-1);
  if (line === undefined) return { ok: false, reason: 'empty_output' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['pending'])) return { ok: false, reason: 'bad_shape' };
  const openBlocks = parsed['openBlocks'];
  if (openBlocks !== undefined && (typeof openBlocks !== 'number' || !Number.isSafeInteger(openBlocks))) {
    return { ok: false, reason: 'bad_shape' };
  }

  const pending: PendingEffect[] = [];
  for (const item of parsed['pending']) {
    const decoded = decodePending(item);
    if (decoded === undefined) return { ok: false, reason: 'bad_shape' };
    pending.push(decoded);
  }

  return { ok: true, pending, openBlocks: typeof openBlocks === 'number' ? openBlocks : 0 };
}

/**
 * 读这个会话里还没被证明的副作用。
 *
 * 注意退出码：有未决项时 CLI **故意**返回非零（与 `--resume` 被拒是同一个
 * 条件），所以一次"失败"的退出里带着合法 JSON 是正常形状——判据是 stdout，
 * 不是 exit code。
 */
export async function readPendingEffects(
  target: ReconcileCliTarget,
  sessionId: string,
): Promise<PendingEffectRead> {
  const result = await runCliCommand({
    ...target,
    args: ['session', 'reconcile', sessionId, '--json'],
  });
  const stdout = result.ok ? result.stdout : result.stdout;
  if (stdout === undefined || stdout.trim().length === 0) {
    return { ok: false, reason: result.ok ? 'empty_output' : result.reason };
  }

  const decoded = parsePendingJson(stdout);
  if (!decoded.ok) {
    return { ok: false, reason: result.ok ? decoded.reason : `${result.reason}:${decoded.reason}` };
  }

  return decoded;
}

/**
 * 把一个人的判定写回引擎。
 *
 * `evidence` 不是形式主义：它是这条记录唯一能说明"凭什么这么判"的东西，
 * 而且引擎允许同一件事只判一次（append-only，第二个相反判定会被拒）。
 */
export async function recordEffectVerdict(
  target: ReconcileCliTarget,
  input: {
    readonly sessionId: string;
    readonly key: string;
    readonly turn: string;
    readonly verdict: EffectVerdict;
    readonly evidence: string;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (input.evidence.trim().length === 0) return { ok: false, reason: 'evidence_required' };

  const result = await runCliCommand({
    ...target,
    args: [
      'session', 'reconcile', input.sessionId,
      '--turn', input.turn,
      '--key', input.key,
      '--outcome', input.verdict,
      '--evidence', input.evidence,
    ],
  });
  if (result.ok) return { ok: true };

  // 引擎把被拒的原因写在自己的那套词汇里（already_recorded / no_match / …），
  // 这里不重译：调用方要显示的是引擎的判断，不是 Desktop 的猜测。
  return { ok: false, reason: result.reason };
}
