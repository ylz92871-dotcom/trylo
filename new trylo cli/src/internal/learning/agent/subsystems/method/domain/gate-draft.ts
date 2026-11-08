import { APPLIES_WHEN_FIELDS, type LabelAddition } from "./contracts.js";

/**
 * 门的读数层：把围栏里的那段文本读成一张**草稿**卡。
 *
 * 与 `gate.ts` 分开，是因为两者回答的问题不同：这一层只回答「它是不是一个
 * 恰好长成这样的 JSON 对象」，`gate.ts` 回答「这张卡能不能进档」。混在一起时
 * 「读不出来」和「读出来了但不合格」会退化成同一个返回值，而它们的诊断价值
 * 完全不同——前者说明模型不会写形状，后者说明模型写了别的东西。
 *
 * 逐字读进来之前不信它的任何一部分：未知的键是形状问题（不是「忽略掉就好」），
 * 值的类型不对与值缺席是两件不同的事实（`null` 与 `undefined`）。
 */

/** 模型在围栏里写的那张卡，逐字读进来之前不信它的任何一部分。 */
export type DraftCard = {
  readonly hint: string;
  readonly labels: ReadonlyArray<string>;
  readonly appliesWhen: DraftAppliesWhen | undefined;
  readonly family: string | undefined;
  readonly addLabels: ReadonlyArray<LabelAddition>;
  readonly hook: DraftHook | undefined;
};

export type DraftAppliesWhen = {
  readonly tools: ReadonlyArray<string> | undefined;
  readonly failureFamily: string | undefined;
  readonly labels: ReadonlyArray<string> | undefined;
  readonly sameSession: boolean | undefined;
};

export type DraftHook = {
  readonly labels: ReadonlyArray<string>;
  readonly need: string;
};

const TOP_FIELDS: ReadonlyArray<string> = [
  "hint",
  "labels",
  "appliesWhen",
  "family",
  "addLabels",
  "hook",
];

const REQUIRED_TOP_FIELDS: ReadonlyArray<string> = ["hint", "labels"];
const APPLIES_WHEN_KEYS: ReadonlyArray<string> = APPLIES_WHEN_FIELDS;
const ADDITION_FIELDS: ReadonlyArray<string> = ["id", "gloss"];
const HOOK_FIELDS: ReadonlyArray<string> = ["labels", "need"];

export type ParsedJson =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "not_json" };

/**
 * 严格 JSON，且只有严格 JSON。
 *
 * 对象外面带着散文是模型包答案的常态，也是禁止载荷搭着一张像样的卡进来的
 * 常态。在花括号之间找子串是门在猜模型指的是哪一对花括号，所以「对象前面有一
 * 句话」是拒绝，不是要剥掉的东西。
 */
export function parseJson(text: string): ParsedJson {
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "not_json" };
  }
}

/**
 * 2. 字段集合与类型。
 *
 * 多一个字段是形状问题而不是「忽略掉就好」：一张带多余字段的卡，它的作者相信
 * 那个字段会被用上。`appliesWhen` 内部留到第 6 条查，此处只要求它是个普通对象。
 */
export function readDraft(value: unknown): DraftCard | undefined {
  if (!isPlainObject(value) || !hasAllowedKeys(value, TOP_FIELDS, REQUIRED_TOP_FIELDS)) {
    return undefined;
  }

  const hint = value["hint"];
  const labels = readStringArray(value["labels"]);
  if (typeof hint !== "string" || labels === undefined || labels === null) {
    return undefined;
  }

  const appliesWhen = readDraftAppliesWhen(value["appliesWhen"]);
  const addLabels = readAdditions(value["addLabels"]);
  const hook = readDraftHook(value["hook"]);
  const family = value["family"];
  if (
    appliesWhen === undefined ||
    addLabels === undefined ||
    hook === undefined ||
    !(family === undefined || typeof family === "string")
  ) {
    return undefined;
  }

  return {
    hint,
    labels,
    appliesWhen: appliesWhen.kind === "absent" ? undefined : appliesWhen.value,
    family,
    addLabels,
    hook: hook.kind === "absent" ? undefined : hook.value,
  };
}

type Maybe<T> = { readonly kind: "absent" } | { readonly kind: "present"; readonly value: T };

function readDraftAppliesWhen(value: unknown): Maybe<DraftAppliesWhen> | undefined {
  if (value === undefined) {
    return { kind: "absent" };
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  if (Object.keys(value).some((key) => !APPLIES_WHEN_KEYS.includes(key))) {
    return undefined;
  }

  const tools = value["tools"] === undefined ? undefined : readStringArray(value["tools"]);
  const failureFamily =
    value["failureFamily"] === undefined ? undefined : readString(value["failureFamily"]);
  const labels = value["labels"] === undefined ? undefined : readStringArray(value["labels"]);
  const sameSession = value["sameSession"];
  if (
    tools === null ||
    failureFamily === null ||
    labels === null ||
    !(sameSession === undefined || typeof sameSession === "boolean")
  ) {
    return undefined;
  }

  return { kind: "present", value: { tools, failureFamily, labels, sameSession } };
}

function readDraftHook(value: unknown): Maybe<DraftHook> | undefined {
  if (value === undefined) {
    return { kind: "absent" };
  }

  if (!isPlainObject(value) || !hasAllowedKeys(value, HOOK_FIELDS, HOOK_FIELDS)) {
    return undefined;
  }

  const labels = readStringArray(value["labels"]);
  const need = readString(value["need"]);
  if (labels === undefined || labels === null || need === undefined || need === null) {
    return undefined;
  }

  return { kind: "present", value: { labels, need } };
}

function readAdditions(value: unknown): ReadonlyArray<LabelAddition> | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const additions: LabelAddition[] = [];

  for (const entry of value) {
    if (!isPlainObject(entry) || !hasAllowedKeys(entry, ADDITION_FIELDS, ADDITION_FIELDS)) {
      return undefined;
    }

    const id = readString(entry["id"]);
    const gloss = readString(entry["gloss"]);
    if (id === undefined || id === null || gloss === undefined || gloss === null) {
      return undefined;
    }

    additions.push({ id, gloss });
  }

  return additions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 键集合：**不许有表外的键**，且必填键都在。
 *
 * 必填只检查「键在不在」，不检查值对不对——那一条属于值那一杠。两张卡因此有
 * 两种不同的诊断：`{"labels":[]}` 缺 `hint` 是形状问题，`{"hint":"  "}` 是
 * hint 值问题。
 */
function hasAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.includes(key)) &&
    required.every((key) => value[key] !== undefined)
  );
}

/** `null` 表示值在但类型不对；`undefined` 表示缺席。两者是不同的事实。 */
function readString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): ReadonlyArray<string> | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  return value.every((item) => typeof item === "string") ? (value as ReadonlyArray<string>) : null;
}
