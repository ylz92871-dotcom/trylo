import type { MethodLayer } from "../../../../control/contracts.js";

/**
 * 方法子系统（M2）的数据形状。
 *
 * 这一份文件只放**形状与上限**，不放算法：卡 v2、适用范围、标签词表、钩子、
 * 记账、放权。放在一个文件里是因为它们互为定义——`MethodCard` 的
 * `appliesWhen.labels` 与 `labels` 都是词表成员，`niche` 由 `family` +
 * `labels` + `appliesWhen.tools` 派生，记账的 `state` 又只由 `supports` /
 * `counterexamples` 决定——拆开会让「什么算同一张卡」变成读者要在两个文件间
 * 拼出来的结论。
 *
 * 三条与 M1 不同的地方，都是所有者否定的那一处：
 *
 *  - **课题不在闭集里。** M1 的 `constraint` 是两枚举之一，卡被锁死成两条
 *    教训。M2 里课题由 `hint` 承载（一段自由语义，只受禁词扫描），闭集只
 *    留在**索引与度量**位（`labels` / `family` / `appliesWhen`）。
 *  - **寿命不绑 turn。** M1 的 `until: "end_of_this_turn"` 没了：卡过门即入档，
 *    跨 turn 可上场。`lineage.createdFrom` 只记它从哪一拍来，不是它活到哪。
 *  - **指针不是可写状态。** 档里没有 `pointer` 字段；「这一 niche 当前最好的
 *    一张」由排序结果派生（`compile.ts`），所以不存在「指针与实际分数不一致」
 *    这种双写风险。
 *
 * 禁名（`AGENTS.md` 明令不得复活旧稿）：`MethodGuard`、`LearningDirective`、
 * `TaskLearningPlan`。本文件里叫「适用范围」的字段是 `appliesWhen`。
 */

/**
 * 失败族，闭集。
 *
 * 它是**度量与索引**，不是课题：门不要求 `hint` 谈某一族，只要求 `family`
 * 若给就必须在这里面。增长要过门（新增一族 = 这里一行 + 一次评审），因为
 * 它会被写进档、被上场时的免费求值读，是最容易被悄悄扩成自由文本的位置。
 */
export const FAILURE_FAMILIES = [
  "containment",
  "repeat_call",
  "format",
  "availability",
  "budget",
  "unknown",
] as const;

export type FailureFamily = (typeof FAILURE_FAMILIES)[number];

const FAILURE_FAMILY_SET: ReadonlySet<string> = new Set(FAILURE_FAMILIES);

export function isFailureFamily(value: string): value is FailureFamily {
  return FAILURE_FAMILY_SET.has(value);
}

/**
 * 标签身份。
 *
 * 词表是**受控子集**：卡可以申请追加，但不许自由派。`LabelId` 是一个
 * string 别名而不是联合，因为词表跨 session 增长；形状由正则守住，成员资格
 * 由词表守住，两者都不是类型能表达的。
 */
export type LabelId = string;

export const LABEL_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

export function isLabelId(value: string): value is LabelId {
  return LABEL_ID_PATTERN.test(value);
}

/**
 * 适用范围：抽卡那一枪写进卡里，上场时**免费求值**（纯比较，不跑 LLM）。
 *
 * 每个字段缺省都是「不限」，所以「越窄越具体」是可数的：具体度 = 给出的
 * 字段数（`specificityOf`）。槽 A 取具体度最高者，就是取这一条。
 */
export type AppliesWhen = {
  readonly tools?: ReadonlyArray<string>;
  readonly failureFamily?: FailureFamily;
  readonly labels?: ReadonlyArray<LabelId>;
  readonly sameSession?: boolean;
};

export const APPLIES_WHEN_FIELDS = [
  "tools",
  "failureFamily",
  "labels",
  "sameSession",
] as const satisfies ReadonlyArray<keyof AppliesWhen>;

export const METHOD_SCHEMA_VERSION = 1 as const;

export type MethodLineage = {
  /** 同 niche 的上一版；没有上一版就是这一 niche 的第一张。 */
  readonly parentVersionId?: string;
  /**
   * 卡来自实际业务拍或中央研究 checkpoint。是**来路**，不是寿命：M1 的
   * `until: "end_of_this_turn"` 已经不存在了。
   */
  readonly createdFrom: {
    readonly turnId: string;
    readonly beat: number;
    readonly reason: ReleaseReason;
  } | { readonly kind: "central_research"; readonly requestRef: string;
    readonly checkpointRef: string; readonly reservationId: string;
    /** Legacy readers may inspect these fields; research never supplies them. */
    readonly turnId?: never; readonly beat?: never; readonly reason?: never };
};

export type MethodCard = {
  readonly schemaVersion: typeof METHOD_SCHEMA_VERSION;
  /**
   * 课题在这里。自由语义只出现在这一个字段里，且受禁词扫描。
   *
   * 长度上限是 `MAX_HINT_CHARS`：长 hint 是把文档偷运进来，不是一条经验。
   */
  readonly hint: string;
  readonly appliesWhen: AppliesWhen;
  /** ≤ `MAX_LABELS`，全在词表内。 */
  readonly labels: ReadonlyArray<LabelId>;
  readonly family?: FailureFamily;
  readonly lineage: MethodLineage;
};

/** 硬顶，全是可测的数，不是散文。 */
export const MAX_HINT_CHARS = 200;
export const MAX_LABELS = 4;
export const MAX_HOOK_LABELS = 3;
export const MAX_HOOK_CHARS = 80;
/**
 * 整卡字符帽。按**规范 JSON 文本长度**量（`cardLengthOf`）：唯一一个既覆盖
 * 所有字段、又不随键序漂移的口径。
 */
export const MAX_CARD_CHARS = 900;

export const MAX_VOCABULARY = 64;
export const MAX_LABEL_ADDITIONS = 2;
export const MAX_GLOSS_CHARS = 24;

/** 一个 niche 里非 dormant 变体的上限；超帽时把分数最低者标 `archived`。 */
export const MAX_VARIANTS_PER_NICHE = 8;

/**
 * dormant 阈值：反例够多而支持为零。
 *
 * **不进候选，不删。** 反例即删档会把「一次偶然反例」变成永久损失，而反例
 * 本身只是下一拍的一个事实。
 */
export const DORMANT_COUNTEREXAMPLES = 2;
export const DORMANT_SUPPORTS = 0;

/** 记账。`state` 的类型里**没有** `active`，这就是 I2 的类型级表达。 */
export type MethodVariantState = "active_pool" | "dormant" | "archived";

/**
 * 档里唯一的指针值。
 *
 * 它是**单成员**联合而不是 `string`：`"active"` 这个值在类型上不可表达，所以
 * 「方法卡不许到 active」（I2）不是纪律，是形状事实。M1 的
 * `SHADOW_POINTERS = ["shadow"]` 保留其意，M2 把它收成一个连数组都装不下的
 * 单值——数组可以有第二个元素，单成员联合不能。
 */
export const SHADOW_POINTER = "shadow" as const;

export type MethodPointer = typeof SHADOW_POINTER;

export function isMethodPointer(value: string): value is MethodPointer {
  return value === SHADOW_POINTER;
}

export type MethodLedger = {
  readonly supports: number;
  readonly counterexamples: number;
  /** 上场次数（初版：上场一次记一次，见 OPEN-M2-2）。 */
  readonly uses: number;
  /**
   * 最近一次上场在持久上场日志里的 **1-based 序号**（越大越新），不是 turn、不是
   * beat。beat 每个 turn 都从 1 重数，拿它当「最近」会让后发生的 turn 误判成更早
   * （E0M1 外部复核 P2-2）。它由控制板 `fieldings` 的追加次序投影而来，故跨 turn
   * 单调。当前只写不读（compile 不消费它），单位为日志序，0 = 从未上场。
   */
  readonly lastUsedSeq: number;
  readonly state: MethodVariantState;
  /** Optional only for source compatibility with pre-feedback adapters. */
  readonly fieldedCount?: number;
  readonly helpedCount?: number;
  readonly lastUsedAt?: string;
};

export function emptyLedger(): MethodLedger {
  return { supports: 0, counterexamples: 0, uses: 0, lastUsedSeq: 0, state: "active_pool", fieldedCount: 0, helpedCount: 0 };
}

/** 一条已经入档的变体：卡 + 它的 Board 身份 + 记账。 */
export type VariantRecord = {
  /** Board 的 `versionId`；卡的身份在档里就是它。 */
  readonly versionId: string;
  readonly proposalId: string;
  readonly nicheId: string;
  readonly card: MethodCard;
  readonly ledger: MethodLedger;
  /** Legacy variants are interpreted as retained working cards. */
  readonly layer?: MethodLayer;
  readonly retention?: "retained" | "evicted";
};

/** 词表成员（受控子集的当前全量）。 */
export type LabelVocabulary = {
  readonly known: ReadonlyArray<LabelId>;
  /**
   * 只在一张卡被门接纳的那一拍非空。
   *
   * 承载的就是「本拍申请追加、当拍即入词表」的那 ≤ `MAX_LABEL_ADDITIONS` 个词；
   * 放不进去的申请已经随卡一起被拒，所以从档里读出来的 `pending` 恒为空。
   */
  readonly pending: ReadonlyArray<LabelAddition>;
};

export type LabelAddition = {
  readonly id: LabelId;
  readonly gloss: string;
};

/**
 * 抽卡时模型可以提出的「下一拍要看什么」。
 *
 * 钩子**不是卡的一部分**，只活一拍：它随下一次执行请求发出，让模型在想的时候
 * 看到。空钩子（没有标签）不等于全库上场——没有标签就没有过滤依据，候选按
 * 免费求值的其余项决定。
 */
export type MethodHook = {
  readonly labels: ReadonlyArray<LabelId>;
  readonly need: string;
};

/** 一条已结算的工具失败事实，缩到策略会比较的三项。 */
export type ObservedFact = {
  readonly tool: string;
  readonly code: string;
  /** 规范化参数 JSON 的哈希；账里不存参数本身。 */
  readonly fingerprint: string;
};

/**
 * 释放理由。
 *
 * 它是 `FailureFamily` 的子集，而且是**故意**的子集：传感器只回答「为什么
 * 放权」，不回答「教什么」。M1 里这个位置叫相机，且相机直接映射课题
 * （`CONSTRAINT_MAPPINGS`），那正是被否定的一层。M2 保留「撞了什么」，
 * 把「学什么」交给执行里的模型自己定。
 */
export type ReleaseReason = "containment" | "repeat_call";

export const RELEASE_REASONS = ["containment", "repeat_call"] as const satisfies ReadonlyArray<ReleaseReason>;

const RELEASE_REASON_SET: ReadonlySet<string> = new Set(RELEASE_REASONS);

export function isReleaseReason(value: string): value is ReleaseReason {
  return RELEASE_REASON_SET.has(value);
}

/**
 * 一次放权。
 *
 * 它不携带课题、不携带张数、不携带延迟——那些要么是模型的（课题），要么是
 * `compile.ts` 的（张数），要么是策略表的（延迟）。它只带「这一拍可以带学习
 * 意图」以及额度。
 */
export type MethodRelease = {
  readonly releaseId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly reason: ReleaseReason;
  readonly tool: string;
  readonly code: string;
  readonly fingerprint: string;
  readonly repeats: number;
  readonly model: string;
  readonly slotChars: number;
  readonly slotCards: number;
};

/**
 * 顶板给子系统的额度。
 *
 * 数据，不是 `if`：`SubsystemGrant` 是判别联合，**加子系统 = 加一个 kind**。
 * M2 只实现 `agent_method`；`idle` 的三种理由都是「不 tick」而不是「tick 完
 * 再拒绝」，所以关学习时连决策都不会产生。
 */
export type MethodGrant = {
  readonly kind: "agent_method";
  /** 本 turn 允许带学习意图的拍数。默认 1，硬顶 1。 */
  readonly releases: number;
  /** 方法槽的字符预算。硬顶，与压缩预算同类。 */
  readonly slotChars: number;
  /** 槽内最多几张变体。硬顶。 */
  readonly slotCards: number;
  /** 学习输出使用的模型。 */
  readonly model: string;
};

export type IdleGrant = {
  readonly kind: "idle";
  readonly reason: "collection_disabled" | "no_budget" | "nothing_to_do";
};

export type SubsystemGrant = MethodGrant | IdleGrant;

/**
 * 默认额度：一拍一次放权，槽 1200 字符 / 8 张卡。
 *
 * **预算是主顶，张数是结果**（`§8.3`，2026-09-16 已拍）。一张卡在槽里占
 * `hint.length + 2`（`compile.ts::PROJECTION_PREFIX_CHARS`），典型 hint 下 1200
 * 字符天然装不到 8 张——所以 8 只是**兜底**，不是目标；而「这一拍一张都没有」是
 * 正常结果，不是失败。早先把「张数 ≤ 3」当主顶是把主从做反了：那会让一张写得长
 * 的卡把整槽挤空，而预算本来就是按字符算的。
 */
export const DEFAULT_METHOD_GRANT: MethodGrant = Object.freeze({
  kind: "agent_method",
  releases: 1,
  slotChars: 1200,
  slotCards: 8,
  model: "default",
});

/**
 * 规范 JSON 文本。
 *
 * 与 `domains/shared/hash.ts::canonicalJson` 的 `JSON.stringify` 不同：这里键
 * **排过序**，因为两个只在键序上不同的卡是同一张卡，而字符帽与 niche 都必须
 * 在那个意义下是函数。`undefined` 值的位置直接省略，和 JSON 一致。
 */
export function canonicalCardJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalCardJson).join(",")}]`;
  }

  const parts: string[] = [];

  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalCardJson(entry)}`);
  }

  return `{${parts.join(",")}}`;
}

/** 整卡字符总量，唯一口径。 */
export function cardLengthOf(card: MethodCard): number {
  return canonicalCardJson(card).length;
}

/**
 * 具体度：适用范围给出几个字段。
 *
 * 「越窄越具体」被写成可数的量，是为了让槽 A 的取舍是一个比较而不是一段
 * 判断。`sameSession` 也算一维——它现在恒真，但字段在，就该参与比较。
 */
export function specificityOf(appliesWhen: AppliesWhen): number {
  let count = 0;

  if (appliesWhen.tools !== undefined && appliesWhen.tools.length > 0) {
    count += 1;
  }

  if (appliesWhen.failureFamily !== undefined) {
    count += 1;
  }

  if (appliesWhen.labels !== undefined && appliesWhen.labels.length > 0) {
    count += 1;
  }

  if (appliesWhen.sameSession !== undefined) {
    count += 1;
  }

  return count;
}

/**
 * 一条失败三元组的身份。
 *
 * `\u0000` 因为工具名、失败码与十六进制指纹都不含它，所以两个不同的三元组
 * 不可能靠拼接撞在一起。
 */
export function tripleKey(fact: ObservedFact): string {
  return `${fact.tool}\u0000${fact.code}\u0000${fact.fingerprint}`;
}

export function sameTriple(left: ObservedFact, right: ObservedFact): boolean {
  return (
    left.tool === right.tool && left.code === right.code && left.fingerprint === right.fingerprint
  );
}

/**
 * 「同一个调用又试了一次」。
 *
 * 只有工具与参数指纹参与，**不含失败码**：换了个失败码的同一次调用仍然是
 * 同一次调用，而 `repeat_call` 要回答的正是「照原样再来一次有没有用」。
 */
export function sameArguments(left: ObservedFact, right: ObservedFact): boolean {
  return left.tool === right.tool && left.fingerprint === right.fingerprint;
}
