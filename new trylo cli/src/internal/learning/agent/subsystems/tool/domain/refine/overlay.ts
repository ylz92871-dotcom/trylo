import { sanitizeToolDescription } from "../../../../../../tooling/catalog/description-guard.js";
import { sha256Hex } from "../../../../../domains/shared/hash.js";
import { REFINE_MAX_HISTORY, REFINE_MIN_EVIDENCE } from "./constants.js";
import { converged } from "./similarity.js";
import type {
  DescriptionOverlay,
  RefineTriggerInput,
  RefineTriggerVerdict,
  RefinementEntry,
  RefinementVersion,
} from "./types.js";

/**
 * 覆盖层的语义（P05 工具学习规格 §6）。
 *
 * 这一层只做四件事，全是纯函数：**判该不该提议**、**记一版**、**判该显示什么**、
 * **转 enforced / 回滚**。没有第五件。尤其是：它不认识 `mount.ts`，也不认识
 * `McpToolSpec`——挂载处把「原文」作为字符串交进来，这一层把「该显示什么」作为
 * 字符串交回去。两边通过 `DescriptionOverlay` 这个窄函数接头，于是覆盖层**没有
 * 途径**去碰 name、parameters、sideEffect 或 needsApproval。
 */

/** 原文指纹。回滚靠它认领被换掉的那段，作废也靠它认出原文已变。 */
export function hashOf(description: string): string {
  return `dh_${sha256Hex(description).slice(0, 32)}`;
}

/**
 * 要不要为这个工具提议一次精炼。
 *
 * 三条规则按顺序，且**每一条独立的理由都要能被追问**——所以返回的是带原因的不提议，
 * 不是一个 `false`。理由进账，于是「为什么这个工具天天坏却没被精炼」有一个答案。
 *
 *  - 证据不够：攒到 `REFINE_MIN_EVIDENCE` 条之前不开口。少于一扇门的证据，精炼出来
 *    的只是模型的想象。
 *  - 已 enforced 且已收敛：正在生效的精炼版本，与这次要产出的版本会几乎一样——
 *    说明「描述不对」这个诊断已经做到了头，再改是原地打转。这正是 §6 的收敛线。
 *  - 没有新证据：规格 §6 的退化口径（无嵌入版）。上一版精炼之后没有任何**新**的失败，
 *    就没有理由认为再重写一次会不一样。
 */
export function shouldProposeRefinement(input: RefineTriggerInput): RefineTriggerVerdict {
  if (input.evidenceCount < REFINE_MIN_EVIDENCE) {
    return { kind: "skip", reason: "below_min_evidence" };
  }

  const entry = input.entry;
  if (entry !== undefined && entry.state === "enforced" && !input.hasNewEvidenceSince) {
    return { kind: "skip", reason: "enforced_and_converged" };
  }

  if (entry !== undefined && !input.hasNewEvidenceSince) {
    return { kind: "skip", reason: "no_new_evidence" };
  }

  return { kind: "propose" };
}

/**
 * 记一版精炼：新条目**默认 shadow**。
 *
 * 默认 shadow 是规格 §6/验收 #6 的第一句，也是这一整套东西的授权底线：Agent 可以
 * 提议、可以写下一段它认为更好的话，但**在有人看它一眼之前，模型看到的一个字都不会
 * 变**。所以这个函数的返回值永远是 `state: "shadow"`——转 enforced 只有 `promote`
 * 一条路，那条路要有人按。
 *
 * 上一版进 `history`；`history` 有上限，因为这是本地 app-data 里的一份文件，而不是
 * 一台无限存档机。
 */
export function refineEntryFor(input: {
  readonly tool: string;
  readonly originalDescription: string;
  readonly refinedDescription: string;
  readonly evidenceRefs: readonly string[];
  readonly at: string;
  readonly previous: RefinementEntry | undefined;
}): RefinementEntry {
  const prior = input.previous;
  const history = [
    ...(prior === undefined ? [] : [...prior.history, versionOf(prior)]),
  ].slice(-REFINE_MAX_HISTORY);

  return {
    tool: input.tool,
    originalHash: hashOf(input.originalDescription),
    refinedDescription: input.refinedDescription,
    evidenceRefs: input.evidenceRefs,
    refinedAt: input.at,
    state: "shadow",
    history,
  };
}

/**
 * 人审通过 → enforced。行为在这一步改变，且只在这一步。
 *
 * 同时把被换下的那一版（如果有）保留在 history 里：回滚要退得到它，人审要看得见它。
 */
export function promoteToEnforced(entry: RefinementEntry): RefinementEntry {
  return { ...entry, state: "enforced" };
}

/**
 * 单工具回滚：退回原文，但**不删除历史**。
 *
 * 回滚成 `shadow` 而不是删条目，是刻意的：删掉之后，当初「为什么改、改成了什么」就
 * 一并消失了，而这个工具会从「有一次没改好的精炼」退化成「一次没发生过的精炼」——
 * 下一次同一段描述让模型用错，判断会从零开始。规格要求「保留 originalHash」，正是
 * 这个意思。回到 shadow 之后行为立即等于原文（`resolveDescription` 对非 enforced 恒
 * 返回 `undefined`），可再被人审 promote。
 */
export function rollbackToShadow(entry: RefinementEntry): RefinementEntry {
  return { ...entry, state: "shadow" };
}

/**
 * 该显示哪段描述。这是**注入点唯一的判据**，也是「精炼不改执行语义」落地的地方：
 * 它只产出字符串，不产出任何别的字段。
 *
 * 三种情况回答 `undefined`（= 用原文）：
 *
 *  - 没有条目：从没精炼过。
 *  - 还在 shadow：提议了但没人审。
 *  - **原文已变**（`originalHash` 对不上）：这条精炼基于的那句话已经不存在了。继续
 *    拿它去替换，等于用一个针对旧描述的诊断去改新描述——模型读错的本来就不是这句。
 *    作废是这里正确的动作，而且它不需要任何人记得去做。
 */
export function resolveDescription(input: {
  readonly entry: RefinementEntry | undefined;
  readonly original: string;
}): string | undefined {
  const entry = input.entry;
  if (entry === undefined || entry.state !== "enforced") {
    return undefined;
  }

  if (entry.originalHash !== hashOf(input.original)) {
    return undefined;
  }

  return entry.refinedDescription;
}

/**
 * 精炼文本的守卫。
 *
 * **规格 §6 说「替换原文（sanitize 之后）」**，字面读是：原文先过守卫，然后覆盖层换掉
 * 它。但那样一来，覆盖层就是一条**绕过**描述守卫的通道——精炼文本是模型写的、或者来自
 * 一份本地文件，它没有理由天然比上游服务器的描述更可信。上游的注入描述会被拒收
 * （`mount.ts` 的 D5），而一条经过「精炼」的注入描述却能直接进模型的眼睛，这个不对称
 * 没有道理。
 *
 * 所以这里的做法是：**精炼文本单独过一次同一个守卫**，不通过就退回原文——不是拒绝整个
 * 工具。原文已经过了守卫（否则工具根本挂不上），所以退回原文永远是安全的；而拒绝工具会
 * 让一次坏精炼连带废掉一个本来能用的工具，代价不对等。降级要能被看见，所以回答里带
 * `degraded`。
 */
export function guardRefinedText(input: {
  readonly refined: string;
  readonly original: string;
}): { readonly text: string; readonly degraded: boolean } {
  const guarded = sanitizeToolDescription(input.refined);
  if (!guarded.ok) {
    return { text: input.original, degraded: true };
  }
  return { text: guarded.text, degraded: false };
}

/**
 * 覆盖层 → 注入点要的那半个能力。
 *
 * 换进来的精炼文本**一律再过一次守卫**（`guardRefinedText`），而且这个函数就是
 * `DescriptionOverlay` 的全部实现面——挂载处只能问「显示什么」，不能写、不能看别的工具。
 */
export function overlayFor(store: {
  readonly entryFor: (tool: string) => RefinementEntry | undefined;
}): DescriptionOverlay {
  return {
    descriptionFor: (tool, original) => {
      const resolved = resolveDescription({ entry: store.entryFor(tool), original });
      if (resolved === undefined) {
        return undefined;
      }
      const guarded = guardRefinedText({ refined: resolved, original });
      return guarded.text;
    },
  };
}

/** 没有覆盖层时的注入点缺省值：恒返回「用原文」。 */
export const noOverlay: DescriptionOverlay = {
  descriptionFor: () => undefined,
};

/** 一版精炼被换下时，进 history 的那条记录。 */
function versionOf(entry: RefinementEntry): RefinementVersion {
  return {
    at: entry.refinedAt,
    description: entry.refinedDescription,
    evidenceRefs: entry.evidenceRefs,
  };
}

/** 两版是否已经收敛到「再改也是原地打转」。 */
export function isConverged(previous: string, next: string): boolean {
  return converged(previous, next);
}
