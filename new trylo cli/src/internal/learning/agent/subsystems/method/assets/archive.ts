import {
  DORMANT_COUNTEREXAMPLES,
  DORMANT_SUPPORTS,
  MAX_VARIANTS_PER_NICHE,
  METHOD_SCHEMA_VERSION,
  SHADOW_POINTER,
  emptyLedger,
  isFailureFamily,
  type AppliesWhen,
  type MethodCard,
  type MethodLedger,
  type MethodVariantState,
  type VariantRecord,
} from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import { isCentralResearchMethodOrigin } from "../domain/research-origin.js";

/**
 * 变体档案：入档、记账、上帽、选择。纯函数，全部只吃 `VariantRecord[]`。
 *
 * 它**不碰磁盘、不碰控制板**：档的来源是 Board 状态（由
 * `method/adapters/board-writer.ts` 读出来），写下去的命令也在那一边。所以
 * 这里没有一个 `save`，也没有一个 `delete`——反例不删档、变体不删档，两者在
 * 这一层是同一件事：**没有删除这个操作**。
 *
 * 三个数与一条阈值，全是可测的：
 *
 *  - `MAX_VARIANTS_PER_NICHE = 8`：同 niche 的非 dormant 变体上限；超帽把分数
 *    最低者标 `archived`（**保留、不进候选**）。
 *  - `DORMANT_COUNTEREXAMPLES = 2` / `DORMANT_SUPPORTS = 0`：满足即 `dormant`
 *    （不进候选，不删）。
 *  - 分数 = `supports - counterexamples`，只用于上帽取舍；**上场排序的第一键是
 *    匹配，不是它**（`compile.ts`）。
 *
 * 「指针」在这里是**派生**的：入档即 shadow 区，从不 active，所以
 * `MethodPointer` 只有 `"shadow"` 一个值，`"active"` 在类型上不可表达。Board 上
 * 若真有一条指向这一版的 shadow 激活，会记进 `activationRef`——本包不写它，但
 * 读到它就要如实带出来。
 */

export function emptyArchive(): ReadonlyArray<VariantRecord> {
  return [];
}

/** 一条记账事件，Board 之外的中立形状。 */
export type AccountingEvent = {
  readonly proposalId: string;
  readonly outcome: "supports" | "counterexamples";
};

/** 记账事件的来源约定。适配器把 Board 的 `provenance` 翻成这个。 */
export const ADMISSION_PROVENANCE = "method:admission";
export const ACCOUNT_PROVENANCE = "method:account";

export function accountingEventOf(
  provenance: string,
): AccountingEvent["outcome"] | undefined {
  if (provenance === `${ACCOUNT_PROVENANCE}:supports`) {
    return "supports";
  }
  return provenance === `${ACCOUNT_PROVENANCE}:counterexamples` ? "counterexamples" : undefined;
}

/**
 * 档里的那张卡：入档时写的 `content` 是不是一张 `MethodCard`。
 *
 * 校验而不是断言：`LearningAssetVersion.content` 是 `unknown`，档又可能被别的
 * 写入者、别的版本动过。读不出来的一律**跳过**（调用方据此上报一条 degraded
 * 观察），绝不半信半疑地用——半信半疑的档会让选择器把一张读不懂的卡送进提示词。
 */
export function isMethodCardContent(value: unknown): value is MethodCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const draft = value as Record<string, unknown>;
  if (draft["schemaVersion"] !== METHOD_SCHEMA_VERSION) {
    return false;
  }

  if (typeof draft["hint"] !== "string") {
    return false;
  }

  const labels = draft["labels"];
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    return false;
  }

  const family = draft["family"];
  if (family !== undefined && !(typeof family === "string" && isFailureFamily(family))) {
    return false;
  }

  return isAppliesWhen(draft["appliesWhen"]) && isLineage(draft["lineage"]);
}

function isAppliesWhen(value: unknown): value is AppliesWhen {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const draft = value as Record<string, unknown>;
  const tools = draft["tools"];
  const labels = draft["labels"];
  const sameSession = draft["sameSession"];
  const family = draft["failureFamily"];

  return (
    optionalStringArray(tools) &&
    optionalStringArray(labels) &&
    (sameSession === undefined || typeof sameSession === "boolean") &&
    (family === undefined || (typeof family === "string" && isFailureFamily(family)))
  );
}

function isLineage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const created = (value as Record<string, unknown>)["createdFrom"];
  if (typeof created !== "object" || created === null || Array.isArray(created)) {
    return false;
  }

  const from = created as Record<string, unknown>;
  if ("kind" in from) return isCentralResearchMethodOrigin(from);

  return (
    typeof from["turnId"] === "string" &&
    typeof from["beat"] === "number" &&
    typeof from["reason"] === "string"
  );
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

/** 一条变体：卡的 Board 身份 + 由证据折出来的记账。 */
export function variantOf(input: {
  readonly versionId: string;
  readonly proposalId: string;
  readonly card: MethodCard;
  readonly accounting: ReadonlyArray<AccountingEvent["outcome"]>;
}): VariantRecord {
  let ledger = emptyLedger();

  for (const outcome of input.accounting) {
    ledger = nextLedger(ledger, outcome);
  }

  return {
    versionId: input.versionId,
    proposalId: input.proposalId,
    nicheId: nicheOf(input.card),
    card: input.card,
    ledger,
    layer: "working",
    retention: "retained",
  };
}

/** 入档：新版本进档，然后按 niche 上帽。 */
export function withVariant(
  archive: ReadonlyArray<VariantRecord>,
  record: VariantRecord,
): ReadonlyArray<VariantRecord> {
  // Layered working cards use the persistent global LRU at endTurn. Legacy
  // adapters without layer metadata retain their original niche-cap contract.
  const next = [...archive, record];
  return record.layer === undefined ? applyNicheCap(next) : next;
}

/**
 * 记账：`supports` 与 `counterexamples` 各自加一。
 *
 * 加完之后重算状态，所以 dormant 是一条由计数**派生**的事实，而不是一次需要
 * 有人记得去写的状态迁移。
 */
export function withAccount(
  archive: ReadonlyArray<VariantRecord>,
  versionId: string,
  outcome: AccountingEvent["outcome"],
): ReadonlyArray<VariantRecord> {
  return archive.map((variant) =>
    variant.versionId === versionId
      ? { ...variant, ledger: nextLedger(variant.ledger, outcome) }
      : variant,
  );
}

/** 上场一次记一次（OPEN-M2-2：精确口径待定，初版只影响同分打破）。 */
export function withUse(
  archive: ReadonlyArray<VariantRecord>,
  versionId: string,
  seq: number,
): ReadonlyArray<VariantRecord> {
  return archive.map((variant) =>
    variant.versionId === versionId
      ? { ...variant, ledger: { ...variant.ledger, uses: variant.ledger.uses + 1, lastUsedSeq: seq } }
      : variant,
  );
}

function nextLedger(ledger: MethodLedger, outcome: AccountingEvent["outcome"]): MethodLedger {
  const counted: MethodLedger =
    outcome === "supports"
      ? { ...ledger, supports: ledger.supports + 1 }
      : { ...ledger, counterexamples: ledger.counterexamples + 1 };
  return { ...counted, state: stateAfter(counted) };
}

/**
 * 状态由计数派生。
 *
 * `archived` 只由 niche 上帽产生，所以它在这里不进不出：一次记账不会把一张
 * 被上帽的卡拿回候选池。反过来说，`dormant` 是可逆的——一张被标 dormant 的卡
 * 只要又攒到支持，就会自己回到候选池，不需要谁去「唤醒」它。
 */
function stateAfter(ledger: MethodLedger): MethodVariantState {
  if (ledger.state === "archived") {
    return "archived";
  }
  const dormant =
    ledger.counterexamples >= DORMANT_COUNTEREXAMPLES && ledger.supports <= DORMANT_SUPPORTS;
  return dormant ? "dormant" : "active_pool";
}

/**
 * 上帽：每个 niche 的非 dormant 变体不超过 `MAX_VARIANTS_PER_NICHE`。
 *
 * 超帽时把**分数最低**者标 `archived`。同分时淘汰档里更早的那一张（更老的
 * 版本），因为同分说明新的没有更差，而档的用途是留证据——留着新的更有用。
 */
function applyNicheCap(
  archive: ReadonlyArray<VariantRecord>,
): ReadonlyArray<VariantRecord> {
  const byNiche = new Map<string, string[]>();

  for (const variant of archive) {
    if (variant.ledger.state === "dormant" || variant.ledger.state === "archived") {
      continue;
    }
    const bucket = byNiche.get(variant.nicheId) ?? [];
    bucket.push(variant.versionId);
    byNiche.set(variant.nicheId, bucket);
  }

  const overCap = new Set<string>();

  for (const bucket of byNiche.values()) {
    if (bucket.length <= MAX_VARIANTS_PER_NICHE) {
      continue;
    }

    const ranked = [...bucket].sort((left, right) => rank(archive, right) - rank(archive, left));

    for (const versionId of ranked.slice(MAX_VARIANTS_PER_NICHE)) {
      overCap.add(versionId);
    }
  }

  if (overCap.size === 0) {
    return archive;
  }

  return archive.map((variant) =>
    overCap.has(variant.versionId)
      ? { ...variant, ledger: { ...variant.ledger, state: "archived" } }
      : variant,
  );
}

/** 排序用的分数：支持减反例。只在同 niche 的取舍里用，**不是**上场的第一键。 */
export function scoreOf(ledger: MethodLedger): number {
  return ledger.supports - ledger.counterexamples;
}

function rank(archive: ReadonlyArray<VariantRecord>, versionId: string): number {
  const index = archive.findIndex((variant) => variant.versionId === versionId);
  const variant = archive[index];
  const score = variant === undefined ? 0 : scoreOf(variant.ledger);
  // 同分时后进档的排前面：索引大的更新。
  return score * 1000 + (index < 0 ? 0 : index);
}

export function variantsInNiche(
  archive: ReadonlyArray<VariantRecord>,
  nicheId: string,
): ReadonlyArray<VariantRecord> {
  return archive.filter((variant) => variant.nicheId === nicheId);
}

/**
 * 同 niche 的上一版。
 *
 * 只是**记血缘**，不是「指针挪过去」：档里没有任何指针，上一版留着、随时能被
 * 选择器重新选中（`§4.2`）。
 */
export function parentVersionFor(
  archive: ReadonlyArray<VariantRecord>,
  nicheId: string,
): string | undefined {
  for (let index = archive.length - 1; index >= 0; index -= 1) {
    const variant = archive[index];
    if (variant !== undefined && variant.nicheId === nicheId) {
      return variant.versionId;
    }
  }
  return undefined;
}

/** 候选池：`active_pool` 的那些。dormant 与 archived 都不进候选，且都不删。 */
export function candidatePool(
  archive: ReadonlyArray<VariantRecord>,
): ReadonlyArray<VariantRecord> {
  return archive.filter((variant) => variant.ledger.state === "active_pool" &&
    variant.layer !== "stable" && variant.retention !== "evicted");
}

/**
 * 只读选择器：档里的 shadow 变体。
 *
 * 「入档即 shadow 区」是本包自己的声明（`MethodPointer` 只有 `"shadow"`），所以
 * 指针是派生量而不是读出来的字段。Board 的 `activations` 仍然读一次——若真有一
 * 条指向这一版的 `shadow` 激活（别的写入者、或守卫放开之后的将来），记进
 * `activationRef` 里如实带出来；本包不写它，也**不因为读到它就改判什么**。
 */
export type ShadowVariant = {
  readonly versionId: string;
  readonly nicheId: string;
  readonly card: MethodCard;
  readonly ledger: MethodLedger;
  readonly pointer: typeof SHADOW_POINTER;
  readonly activationRef?: string;
};

export function selectShadowVariants(
  archive: ReadonlyArray<VariantRecord>,
  shadowActivations: Readonly<Record<string, string>>,
): ReadonlyArray<ShadowVariant> {
  return archive.map((variant) => {
    const activationRef = shadowActivations[variant.versionId];
    return {
      versionId: variant.versionId,
      nicheId: variant.nicheId,
      card: variant.card,
      ledger: variant.ledger,
      pointer: SHADOW_POINTER,
      ...(activationRef === undefined ? {} : { activationRef }),
    };
  });
}
