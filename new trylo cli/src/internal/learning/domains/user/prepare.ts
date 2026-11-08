import { inferDimension } from "./conclusion.js";
import type { CompiledPolicyRule, PolicyDimension, UserModelRecord } from "./contracts.js";

/**
 * 用户政策段的**准备**：解析 → 挑包 → 编译成一段 `system` 文本（UE-2）。
 *
 * 这是纯函数，不读盘、不落盘、不注入。它回答三个问题：
 *
 *  1. **哪些规则命中这次任务？** 命中 = 规则的维度等于任务文本的维度，且规则背后的
 *     用户模型的作用域指纹等于本次作用域指纹。两条都是**等于**，没有相似度、没有
 *     打分、没有兜底。同一个任务文本永远得到同一份挑选结果——这是「确定性解析」的
 *     全部内容，也是「未命中也注入」这条反例能被证伪的原因：没命中就是空段。
 *  2. **预算内能放下几条？** 预算是主顶、张数是结果（与方法槽同一口径）：按序加，
 *     遇到第一条放不下的就停：`0 条`不是失败，是正常结果。
 *  3. **它长什么样？** 一条 `system` 消息，明写「已记录，尚未用于执行」，并且明写
 *     它**不改变任何权限、不改审批**。影子状态不是一句注释，是注入文本里的话——
 *     模型看得到，用户也看得到（观察行里带它）。
 *
 * 质量缺陷类话术（资格闸的 `general_quality_defect`）在这里**没有过滤代码**，因为
 * 它在链上根本走不到这里：质量缺陷不产结论、不产模型、不产承诺、不产规则。用一条
 * 「排除」代码去挡它，等于承认它可能被编译出来；这里没有那条代码，测试却仍然断言
 * 它永不出现，这才是真正的保证。
 */

/** 段的头一行。`尚未用于执行` 是 shadow 的字面落点。 */
export const USER_POLICY_HEADER =
  "[user policy] 用户协作偏好（已记录，尚未用于执行；不改变任何权限，也不改审批）：";

/** 每条规则一行的前缀宽度，与 `learning/method/compile.ts` 的投影口径同义。 */
export const USER_POLICY_LINE_PREFIX = "- ";

/** 强度次序：越硬的越先被放进来。数字只用于排序，不参与任何判断。 */
const STRENGTH_RANK: Readonly<Record<CompiledPolicyRule["strength"], number>> = {
  hard: 0,
  strong_default: 1,
  soft: 2,
  advisory: 3,
};

export type PrepareUserPolicyInput = {
  readonly rules: readonly CompiledPolicyRule[];
  /** 规则背后的模型；作用域匹配靠它，规则自己不重复存指纹。 */
  readonly models: readonly UserModelRecord[];
  readonly scopeFingerprint: string;
  readonly taskText: string;
  readonly budgetChars: number;
};

export type UserPolicySelection = {
  /** 空段落 = `undefined`（不是空串），于是「没命中」与「关学习」在字节上不可区分。 */
  readonly segment: string | undefined;
  readonly adoptedRuleIds: readonly string[];
  /** 命中了任务、但预算放不下的规则。它是观测事实，不是失败。 */
  readonly droppedRuleIds: readonly string[];
  readonly chars: number;
};

const EMPTY: UserPolicySelection = { segment: undefined, adoptedRuleIds: [], droppedRuleIds: [], chars: 0 };

/**
 * 命中判定，逐条可复核。
 *
 * `dimension` 用任务文本推断，而不是用规则自己的维度反推——反推会让「这条规则适不
 * 适用」永远为真。
 */
export function matchesTask(
  rule: CompiledPolicyRule,
  taskText: string,
  scopeFingerprint: string,
  models: readonly UserModelRecord[],
): boolean {
  if (rule.status !== "active") {
    return false;
  }

  if (inferDimension(taskText) !== rule.domain) {
    return false;
  }

  return inScope(rule, scopeFingerprint, models);
}

/**
 * 规则的作用域：它来源的模型里只要有一个是活的且指纹相同即可。
 *
 * 用 `some` 而不是要求全部相同，是因为一条规则可能由多条同维度结论合并而来
 * （`conclusion.ts` 的 stableKey 已经按 scope 分桶），而合并后的规则只保留
 * 来源 id——「至少一条同作用域来源」与 stableKey 的分桶口径一致。
 */
function inScope(
  rule: CompiledPolicyRule,
  scopeFingerprint: string,
  models: readonly UserModelRecord[],
): boolean {
  return models.some(
    (model) =>
      model.status === "active" &&
      model.scopeFingerprint === scopeFingerprint &&
      rule.sourceUserModelIds.includes(model.id),
  );
}

/** 排序键：强度、再规则 id。同一次请求必须得到同一个次序，所以不用时间、不用随机。 */
function order(a: CompiledPolicyRule, b: CompiledPolicyRule): number {
  const byStrength = STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength];
  if (byStrength !== 0) {
    return byStrength;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function prepareUserPolicy(input: PrepareUserPolicyInput): UserPolicySelection {
  if (input.budgetChars <= 0 || input.rules.length === 0) {
    return EMPTY;
  }

  const hit = input.rules
    .filter((rule) => matchesTask(rule, input.taskText, input.scopeFingerprint, input.models))
    .sort(order);
  const kept: CompiledPolicyRule[] = [];
  const lines: string[] = [];
  let body = 0;

  for (const rule of hit) {
    const line = `${USER_POLICY_LINE_PREFIX}${rule.instruction}`;
    const next = body + line.length + (lines.length === 0 ? 0 : 1);
    if (USER_POLICY_HEADER.length + 1 + next > input.budgetChars) {
      break;
    }

    kept.push(rule);
    lines.push(line);
    body = next;
  }

  if (kept.length === 0) {
    return { ...EMPTY, droppedRuleIds: hit.map((rule) => rule.id) };
  }

  const segment = `${USER_POLICY_HEADER}\n${lines.join("\n")}`;

  return {
    segment,
    adoptedRuleIds: kept.map((rule) => rule.id),
    droppedRuleIds: hit.filter((rule) => !kept.includes(rule)).map((rule) => rule.id),
    chars: segment.length,
  };
}

/** 维度 → 这条政策的「说给谁听」的一句话。只用于呈现，不参与任何判断。 */
export function dimensionLabel(dimension: PolicyDimension): string {
  switch (dimension) {
    case "reporting_information_density":
      return "汇报与信息密度";
    case "work_artifact_workflow":
      return "交付物工作流";
    case "verification_audit":
      return "验证与审核";
    case "planning_direct_execution":
      return "计划与直接执行";
    case "architecture_refactor":
      return "架构与重构";
    case "agent_autonomy":
      return "协作自主度";
  }
}
