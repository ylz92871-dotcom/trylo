import { shortId } from "../../../../domains/shared/hash.js";
import type { FailureFamily, LabelId, MethodCard } from "./contracts.js";

/**
 * niche：同一适用条件。
 *
 * niche 是**派生量**，不落第二个可写状态。这一个决定是刻意的：如果档里存一个
 * 「这一 niche 当前最好的是哪张」的可写指针，它就必然在某次入档、某次记账之后
 * 与实际分数不一致，而两份状态里哪一份是对的，读者无从判断。指针能回答的问题
 * （「现在该上哪张」）由排序结果回答（`compile.ts`），旧版本留在档里，随时能
 * 回来——所以「挪指针」这件事根本不需要存在。
 *
 * 键的三段与 `§4.2` 逐字一致：
 *
 *  - `family ?? "-"`：没给族就是一个独立的 niche，不并进任何一族；
 *  - `sorted(labels)`：标签是集合，**码位序**排序后拼接——换 `localeCompare`
 *    会得到另一个 niche id，所以口径必须钉死在一处；
 *  - `sorted(appliesWhen.tools)`：同理。空表示「任意工具」，与「工具列表为空」
 *    是同一件事，因此都拼成空串。
 *
 * 三段都用 `+` 连接，用 `shortId` 哈希成短身份。哈希而不是保留原文，是因为
 * niche 要写进 `VariantRecord`、要在日志里出现，而它承载的是工具名与标签这些
 * 本可以很长（且可能带内部命名）的字符串。
 */

/** 规范顺序：码位序、去重。 */
export function sortedUnique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].sort();
}

export function nicheIdOf(
  family: FailureFamily | undefined,
  labels: ReadonlyArray<LabelId>,
  tools: ReadonlyArray<string>,
): string {
  return shortId("niche", [
    family ?? "-",
    sortedUnique(labels).join("+"),
    sortedUnique(tools).join("+"),
  ]);
}

/**
 * 一张卡的 niche。
 *
 * `appliesWhen.failureFamily` 优先于卡上的 `family`，因为前者是「这条经验只在
 * 这一族失败时适用」，后者是「这条经验是关于哪一族的」——适用条件是约束，
 * 记账与索引的族是描述。两者不同时，约束更窄的那个决定 niche。
 */
export function nicheOf(card: MethodCard): string {
  return nicheIdOf(
    card.appliesWhen.failureFamily ?? card.family,
    card.labels,
    card.appliesWhen.tools ?? [],
  );
}
