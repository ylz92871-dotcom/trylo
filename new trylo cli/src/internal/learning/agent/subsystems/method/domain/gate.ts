import { scanForbiddenText } from "../../../../domains/shared/forbidden-scan.js";
import {
  MAX_CARD_CHARS,
  MAX_HINT_CHARS,
  MAX_HOOK_CHARS,
  MAX_HOOK_LABELS,
  MAX_LABEL_ADDITIONS,
  MAX_LABELS,
  METHOD_SCHEMA_VERSION,
  cardLengthOf,
  isFailureFamily,
  type AppliesWhen,
  type FailureFamily,
  type LabelAddition,
  type LabelVocabulary,
  type MethodCard,
  type MethodHook,
  type MethodRelease,
} from "./contracts.js";
import { acceptedAdditions, withAdditions } from "./vocabulary.js";
import type { DraftAppliesWhen, DraftCard, DraftHook } from "./gate-draft.js";
import { parseJson, readDraft } from "./gate-draft.js";

/**
 * 门：只管形状与禁区。
 *
 * 它是模型的一句话与下一次请求之间的唯一一道关，而它**故意不管课题**：不判断
 * `hint` 好不好、不要求它谈某一族失败、不把失败码映射成允许内容。M1 的门把
 * 课题锁死成两条枚举（`ConstraintName`），那正是所有者否定的「门在卡课题」。
 * M2 的门只回答「这句话是不是一张形状合法的卡」，剩下的判断留给读它的人。
 *
 * 门也**不编辑**：不合格的卡直接拒，不修成合格的。改一个字都会让记录说模型
 * 写了它没写的东西，而一次可避免的拒绝远比一条伪造的记录便宜。
 *
 * 十条杠，**按序**核对，首个失败即返回码：
 *
 *   1  是不是严格 JSON（对象外不许有散文）      `card_not_json`
 *   2  字段集合与类型是否恰好                  `card_shape_invalid`
 *   3  `hint` 非空白且 ≤ 200 字符              `card_hint_invalid` / `card_hint_too_long`
 *   4  `labels` ≤ 4 且全在词表内（含本拍申请）  `card_label_not_in_vocabulary` / `card_label_over_cap`
 *   5  `family` 若给，在闭集内                 `card_family_not_in_closed_set`
 *   6  `appliesWhen` 字段闭集，其 `labels` 也在词表内 `card_applies_when_invalid`
 *   7  `appliesWhen.tools` 若是真的工具名      `card_unknown_tool`
 *   8  `hint` 不带禁止载荷                     `card_forbidden_word`
 *   9  钩子：标签 ≤ 3 且在词表内，`need` ≤ 80 字符 `card_hook_invalid`
 *  10  整卡（规范 JSON 文本）≤ 900 字符        `card_too_large`
 *
 * 顺序是合同的一部分，不是写代码的顺手：1、2 必须最先（没有字段的卡，下面每
 * 一条都无从评估），5 在 6 之前是因为「不是我们这一族的」比「适用范围没写好」
 * 更具体。每条拒绝路径各有一个夹具（`testdata/method-learning/gate/**`）。
 */

export const GATE_REFUSAL_CODES = [
  "card_not_json",
  "card_shape_invalid",
  "card_hint_invalid",
  "card_hint_too_long",
  "card_label_not_in_vocabulary",
  "card_label_over_cap",
  "card_family_not_in_closed_set",
  "card_applies_when_invalid",
  "card_unknown_tool",
  "card_forbidden_word",
  "card_hook_invalid",
  "card_too_large",
] as const;

export type GateRefusalCode = (typeof GATE_REFUSAL_CODES)[number];

/**
 * 门需要知道的、卡以外的事实。
 *
 * 三项都是**外面的事实**而不是卡的属性：当前词表（受控子集）、本轮真实存在的
 * 工具名（防幻觉）、以及这一枪是从哪一拍放出来的（写进 `lineage.createdFrom`）。
 */
export type GateContext = {
  readonly vocabulary: LabelVocabulary;
  readonly toolNames: ReadonlyArray<string>;
  readonly release: MethodRelease;
};

export type GateVerdict =
  | {
      readonly kind: "admitted";
      readonly card: MethodCard;
      /** 本拍要发给模型的钩子；卡里没写就是没有。 */
      readonly hook: MethodHook | undefined;
      /** 本拍申请的、当拍即入词表的追加（≤ `MAX_LABEL_ADDITIONS`）。 */
      readonly additions: ReadonlyArray<LabelAddition>;
    }
  | { readonly kind: "refused"; readonly code: GateRefusalCode };

export function admitCard(text: string, context: GateContext): GateVerdict {
  const parsed = parseJson(text);
  if (parsed.kind === "not_json") {
    return refused("card_not_json");
  }

  const draft = readDraft(parsed.value);
  if (draft === undefined) {
    return refused("card_shape_invalid");
  }

  const hint = hintRefusal(draft.hint);
  if (hint !== undefined) {
    return refused(hint);
  }

  const labels = labelsAdmission(draft, context);
  if (labels.kind === "refused") {
    return refused(labels.code);
  }

  const family = familyOf(draft.family);
  if (family === "invalid") {
    return refused("card_family_not_in_closed_set");
  }

  const appliesWhen = appliesWhenAdmission(draft.appliesWhen, labels.vocabulary);
  if (typeof appliesWhen === "string") {
    return refused(appliesWhen);
  }

  if (unknownTools(draft.appliesWhen, context.toolNames)) {
    return refused("card_unknown_tool");
  }

  if (forbiddenPayloadRefusal(draft)) {
    return refused("card_forbidden_word");
  }

  const hook = hookAdmission(draft.hook, labels.vocabulary);
  if (hook.kind === "refused") {
    return refused("card_hook_invalid");
  }

  const card = buildCard(draft.hint, labels.labels, appliesWhen, family, context.release);
  if (cardLengthOf(card) > MAX_CARD_CHARS) {
    return refused("card_too_large");
  }

  return { kind: "admitted", card, hook: hook.hook, additions: labels.additions };
}

/** 3. hint 是提示还是文档。空白与超长是两种不同的诊断，所以是两个码。 */
function hintRefusal(hint: string): GateRefusalCode | undefined {
  if (hint.trim().length === 0) {
    return "card_hint_invalid";
  }
  return hint.length > MAX_HINT_CHARS ? "card_hint_too_long" : undefined;
}

/** 族的读法：缺席、合法、或「给了但不合法」——第三种是拒绝而不是默认值。 */
function familyOf(value: string | undefined): FailureFamily | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  return isFailureFamily(value) ? value : "invalid";
}

type LabelsAdmission =
  | {
      readonly kind: "ok";
      readonly vocabulary: LabelVocabulary;
      readonly labels: ReadonlyArray<string>;
      readonly additions: ReadonlyArray<LabelAddition>;
    }
  | { readonly kind: "refused"; readonly code: GateRefusalCode };

/**
 * 4. 标签与追加。
 *
 * 两个不同的超帽合成一个码：`labels` 超过 4 张，与申请追加超过 2 个，对出卡的
 * 模型来说是同一件事——它这一拍想说的标签太多了。而「这个词不在表里」是另一
 * 回事：申请没被接纳（形状不合、放不下、或压根没申请），所以卡上出现了一个
 * 不在生效词表里的词。
 */
function labelsAdmission(draft: DraftCard, context: GateContext): LabelsAdmission {
  if (draft.labels.length > MAX_LABELS || draft.addLabels.length > MAX_LABEL_ADDITIONS) {
    return { kind: "refused", code: "card_label_over_cap" };
  }

  const additions = acceptedAdditions(context.vocabulary, draft.addLabels);
  const vocabulary = withAdditions(context.vocabulary, additions);
  const missing =
    !allKnown(draft.labels, vocabulary) ||
    !allKnown(draft.appliesWhen?.labels ?? [], vocabulary);
  if (missing) {
    return { kind: "refused", code: "card_label_not_in_vocabulary" };
  }

  return { kind: "ok", vocabulary, labels: draft.labels, additions };
}

function allKnown(labels: ReadonlyArray<string>, vocabulary: LabelVocabulary): boolean {
  return labels.every((label) => vocabulary.known.includes(label));
}

/**
 * 6. `appliesWhen` 的字段闭集与类型；其 `labels` 也必须全在词表内。
 *
 * 词表检查与 `labels` 同样严格，因为两者都会被拿去做候选过滤：一个不在词表里的
 * 适用范围标签会让这张卡永远匹配不上（它谁也不是），而那种「静默永不命中」比
 * 一次拒绝难查得多。
 */
function appliesWhenAdmission(
  draft: DraftAppliesWhen | undefined,
  vocabulary: LabelVocabulary,
): AppliesWhen | GateRefusalCode {
  if (draft === undefined) {
    return {};
  }

  if (!allKnown(draft.labels ?? [], vocabulary)) {
    return "card_label_not_in_vocabulary";
  }

  const family = familyOf(draft.failureFamily);
  if (family === "invalid") {
    return "card_applies_when_invalid";
  }

  return {
    ...(draft.tools === undefined ? {} : { tools: draft.tools }),
    ...(family === undefined ? {} : { failureFamily: family }),
    ...(draft.labels === undefined ? {} : { labels: draft.labels }),
    ...(draft.sameSession === undefined ? {} : { sameSession: draft.sameSession }),
  };
}

/** 7. 幻觉工具：适用范围里点名的工具必须**真的在本轮目录里**。 */
function unknownTools(
  draft: DraftAppliesWhen | undefined,
  toolNames: ReadonlyArray<string>,
): boolean {
  const claimed = draft?.tools;
  if (claimed === undefined) {
    return false;
  }
  return claimed.some((name) => !toolNames.includes(name));
}

/**
 * 8. 禁止载荷。
 *
 * 口径沿用 `domains/shared/forbidden-scan.ts`（M1 用它扫 hint）。M2 把扫描面
 * 从 `hint` 扩到**每一个会随请求发出去的自由文本**：`hint`、钩子的 `need`、
 * 以及追加项的 `gloss`（gloss 会随词表全量一起打进下一次提示词）。加宽的是
 * 同一条杠的范围，不是加杠——三条路都是「一句话被偷运进提示词」，而 M1 只堵
 * 了其中一条是因为当时只有一条。
 */
function forbiddenPayloadRefusal(draft: DraftCard): boolean {
  const texts = [
    draft.hint,
    ...(draft.hook === undefined ? [] : [draft.hook.need]),
    ...draft.addLabels.map((addition) => addition.gloss),
  ];
  return scanForbiddenText(texts).length > 0;
}

/** 9. 钩子：标签 ≤ 3 且在词表内，`need` 非空白且 ≤ 80 字符。 */
function hookAdmission(
  draft: DraftHook | undefined,
  vocabulary: LabelVocabulary,
): { readonly kind: "ok"; readonly hook: MethodHook | undefined } | { readonly kind: "refused" } {
  if (draft === undefined) {
    return { kind: "ok", hook: undefined };
  }

  if (draft.labels.length > MAX_HOOK_LABELS || draft.need.length > MAX_HOOK_CHARS) {
    return { kind: "refused" };
  }

  if (draft.need.trim().length === 0 || !allKnown(draft.labels, vocabulary)) {
    return { kind: "refused" };
  }

  return { kind: "ok", hook: { labels: draft.labels, need: draft.need } };
}

/**
 * 把读过的那几个字段重建成卡。
 *
 * 只从**已验证**的字段重建，所以卡上不可能出现一个没有被检查过的字段；同时
 * `schemaVersion` 与 `lineage` 由门自己盖章——模型不需要知道、也不该被要求
 * 写出这一拍是第几拍。
 */
function buildCard(
  hint: string,
  labels: ReadonlyArray<string>,
  appliesWhen: AppliesWhen,
  family: FailureFamily | undefined,
  release: MethodRelease,
): MethodCard {
  return {
    schemaVersion: METHOD_SCHEMA_VERSION,
    hint,
    appliesWhen,
    labels,
    ...(family === undefined ? {} : { family }),
    lineage: {
      createdFrom: { turnId: release.turnId, beat: release.beat, reason: release.reason },
    },
  };
}

function refused(code: GateRefusalCode): GateVerdict {
  return { kind: "refused", code };
}
