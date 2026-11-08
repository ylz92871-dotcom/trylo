/**
 * WP27.2 跨包用户闭环组合判定。
 *
 * 意图：把“输入→权限→进程→修改→审阅→Skill/MCP→子代理→取消/恢复”这一条
 * 用户闭环变成可机检的纯判定。每个阶段必须有真实 adapter 消费证据（由
 * evidenceRef 携带引用）；缺消费者保持 partial，不把接口或 mock 当闭合，
 * 更不允许“双方等整包完成”的循环写法。
 *
 * 边界：本模块只判定组合终态，不执行任何进程、provider 或 TTY。真实
 * 磁盘/TTY/安装验收归 WP28；本包只证明组合语义完整且失败可终局。
 */

export const CROSS_LOOP_STAGES = [
  "input",
  "permission",
  "process",
  "edit",
  "review",
  "skill_mcp",
  "subagent",
  "cancel_recover",
] as const;

export type CrossLoopStage = (typeof CROSS_LOOP_STAGES)[number];

export type StageResult = "passed" | "blocked" | "failed" | "unknown" | "pending_consumer";

export type StageOutcome = {
  readonly stage: CrossLoopStage;
  readonly result: StageResult;
  readonly evidenceRef: string;
};

export type CrossLoopVerdict =
  | { readonly kind: "closed"; readonly closedStages: readonly CrossLoopStage[] }
  | { readonly kind: "blocked"; readonly blockedStage: CrossLoopStage; readonly reason: string }
  | { readonly kind: "failed"; readonly failedStage: CrossLoopStage; readonly failure: string }
  | { readonly kind: "partial"; readonly pendingStages: readonly CrossLoopStage[] };

function pendingReason(outcome: StageOutcome | undefined, stage: CrossLoopStage): string {
  if (outcome === undefined) {
    return `missing stage evidence: ${stage}`;
  }
  return `${stage}: ${outcome.result} (${outcome.evidenceRef})`;
}

/**
 * The same stage reported twice with different results is not a stage that can
 * be settled — a permission denial appended after a pass would otherwise be
 * silently dropped by first-wins, and the loop would certify itself on the
 * strength of the entry it happened to read first.
 */
function findConflictingStage(
  outcomes: readonly StageOutcome[],
): { readonly stage: CrossLoopStage; readonly results: readonly string[] } | undefined {
  const byStage = new Map<CrossLoopStage, string[]>();

  for (const outcome of outcomes) {
    const seen = byStage.get(outcome.stage) ?? [];
    seen.push(outcome.result);
    byStage.set(outcome.stage, seen);
  }

  for (const [stage, results] of byStage) {
    if (new Set(results).size > 1) {
      return { stage, results };
    }
  }

  return undefined;
}

/**
 * A stage counts as passed only when it says so *and* carries the reference
 * that proves a real adapter consumed it. "passed" with nothing behind it is the
 * assertion this package exists to catch, so it cannot be the one thing the
 * check waves through.
 */
function isSettledPass(outcome: StageOutcome | undefined): outcome is StageOutcome {
  return outcome !== undefined
    && outcome.result === "passed"
    && outcome.evidenceRef.trim().length > 0;
}

/**
 * 按规范阶段顺序结算：failed 优先于 blocked，blocked 优先于 partial，
 * 只有全部 passed 且各自带证据引用才 closed。unknown、缺消费者、无法识别的
 * 结果词与缺证据引用的 passed 一律进 partial，永不升格为通过。
 */
export function evaluateCrossLoop(outcomes: readonly StageOutcome[]): CrossLoopVerdict {
  const conflict = findConflictingStage(outcomes);
  if (conflict !== undefined) {
    return {
      kind: "failed",
      failedStage: conflict.stage,
      failure: `conflicting results for one stage: ${conflict.stage} (${conflict.results.join(" vs ")})`,
    };
  }

  const byStage = new Map<CrossLoopStage, StageOutcome>();

  for (const outcome of outcomes) {
    if (!byStage.has(outcome.stage)) {
      byStage.set(outcome.stage, outcome);
    }
  }

  const failed = CROSS_LOOP_STAGES.map((stage) => byStage.get(stage)).find(
    (outcome) => outcome?.result === "failed",
  );
  if (failed !== undefined) {
    return { kind: "failed", failedStage: failed.stage, failure: pendingReason(failed, failed.stage) };
  }

  const blocked = CROSS_LOOP_STAGES.map((stage) => byStage.get(stage)).find(
    (outcome) => outcome?.result === "blocked",
  );
  if (blocked !== undefined) {
    return {
      kind: "blocked",
      blockedStage: blocked.stage,
      reason: pendingReason(blocked, blocked.stage),
    };
  }

  const pending = CROSS_LOOP_STAGES.filter((stage) => !isSettledPass(byStage.get(stage)));
  if (pending.length > 0) {
    return { kind: "partial", pendingStages: pending };
  }

  return { kind: "closed", closedStages: [...CROSS_LOOP_STAGES] };
}
