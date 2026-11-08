import { TOOL_FAILURE_THRESHOLD } from "./constants.js";
import type { FailureFact, FailureTally } from "./types.js";

/**
 * 源①：客观失败统计（规格 §2 表格第一行）。
 *
 * 规格说这一源「现成，只缺聚合器」，实测比它说的还要现成——执行环那一侧已经在
 * 逐拍把 `{工具, 失败码, 输入指纹}` 报出来了，所以这里真的只有一个纯函数：
 * 数一数，排好序，交出去。
 *
 * 三条口径，都是刻意的：
 *
 *  - **按工具聚合，不按三元组。** 规格 §2 写的是「同一工具在本 run 内
 *    `tool_result failed/unknown` ≥ 阈值」——工具维度。三元组（工具+实参+失败码）
 *    是执行环判「同一件事又发生了」的口径，另一件事，不在这一层。所以本 run 里
 *    一个工具换三种参数错了三次，也算三次。
 *  - **失败码与指纹去重但保序。** 它们是给人看的证据，不是计数依据；去重让
 *    「三次都是同一个码」与「三次三个码」长得不一样。
 *  - **输出按工具名排序。** 同一份输入永远得到同一份输出，提议才能被复现、
 *    被对账。Map 的插入顺序取决于输入顺序，所以排序不能省。
 */
export function tallyToolFailures(facts: readonly FailureFact[]): readonly FailureTally[] {
  const byTool = new Map<string, { failures: number; codes: string[]; fingerprints: string[] }>();

  for (const fact of facts) {
    const entry = byTool.get(fact.tool) ?? { failures: 0, codes: [], fingerprints: [] };

    entry.failures += 1;

    if (!entry.codes.includes(fact.code)) {
      entry.codes.push(fact.code);
    }

    if (!entry.fingerprints.includes(fact.fingerprint)) {
      entry.fingerprints.push(fact.fingerprint);
    }

    byTool.set(fact.tool, entry);
  }

  return [...byTool.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([tool, entry]) => ({
      tool,
      failures: entry.failures,
      codes: entry.codes,
      fingerprints: entry.fingerprints,
    }));
}

/**
 * 到门槛的那些工具。
 *
 * `threshold` 是形参而不是写死的引用，只有一个理由：用例要能证明「差一次就不入榜」
 * 这条边界，而不是靠把常量改成 2 再改回来。默认值永远是命名常量。
 */
export function toolsAtOrOverThreshold(
  tallies: readonly FailureTally[],
  threshold: number = TOOL_FAILURE_THRESHOLD,
): readonly FailureTally[] {
  return tallies.filter((tally) => tally.failures >= threshold);
}
