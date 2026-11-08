import { DAILY_PROPOSAL_LIMIT, PER_TOOL_PROPOSALS_PER_RUN, PROPOSAL_COOLDOWN_MS } from "./constants.js";

/**
 * 频控（规格 §5）。
 *
 * 存在的理由只有一句：**提议的价值在于它稀有**。提议一次就要人点一次，没有闸门，
 * 一个反复失败的工具会在每个 run 里各提一次，几轮下来用户面对的是同一句话刷屏，
 * 于是他学会的不是「工具该换了」，而是「别理这个提示」。
 *
 * 三条闸，判据维度刻意不同：
 *
 *  - **冷却**按提议身份（同一件事 7 天内只提一次）；
 *  - **每-run 上限**按工具（一个工具一个 run 最多一条）；
 *  - **日上限**按全局（今天最多三条）。
 *
 * 三个不同的计数单位，所以三条不能互相顶替。判据顺序 = 冷却 → 每-run → 日上限，
 * 于是「为什么被拒」永远是最好解释的那一个。
 *
 * 时间读不出来时 fail closed：账本是追加写的、只有我们自己写，一行坏时间说明
 * 别处已经出事了，此时少提一次比多提一次安全。
 */

export type ProposalRecord = {
  /** 提议身份，如 `improve:run_shell`。冷却按它计。 */
  readonly key: string;
  /** 提议针对的工具（缺口类提议可能没有具体工具）。 */
  readonly tool?: string;
  readonly runId: string;
  /** ISO 时间串。 */
  readonly proposedAt: string;
};

export type ThrottleDenial = "cooldown" | "per_tool_per_run" | "daily_limit" | "invalid_time";

export type ThrottleVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: ThrottleDenial };

export type ThrottleInput = {
  readonly candidate: { readonly key: string; readonly tool?: string };
  readonly runId: string;
  readonly at: string;
  readonly history: readonly ProposalRecord[];
};

export function admitProposal(input: ThrottleInput): ThrottleVerdict {
  const now = Date.parse(input.at);
  const parsed = input.history.map((record) => ({ record, at: Date.parse(record.proposedAt) }));
  if (Number.isNaN(now) || parsed.some((entry) => Number.isNaN(entry.at))) {
    return { allowed: false, reason: "invalid_time" };
  }

  for (const entry of parsed) {
    if (entry.record.key === input.candidate.key && now - entry.at < PROPOSAL_COOLDOWN_MS) {
      return { allowed: false, reason: "cooldown" };
    }
  }

  const tool = input.candidate.tool;
  if (tool !== undefined) {
    const sameToolSameRun = parsed.filter(
      (entry) => entry.record.tool === tool && entry.record.runId === input.runId,
    ).length;
    if (sameToolSameRun >= PER_TOOL_PROPOSALS_PER_RUN) {
      return { allowed: false, reason: "per_tool_per_run" };
    }
  }

  const today = utcDay(now);
  const sameDay = parsed.filter((entry) => utcDay(entry.at) === today).length;
  if (sameDay >= DAILY_PROPOSAL_LIMIT) {
    return { allowed: false, reason: "daily_limit" };
  }

  return { allowed: true };
}

/** UTC 日：日上限按 UTC 切分，不按本地时区——否则同一本账在两个时区里算法不同。 */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}
