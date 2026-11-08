import { compileBehaviorCommitments } from "../../learning/domains/user/behavior-commitment.js";
import { discoverEvidenceRelations, synthesizeConclusions } from "../../learning/domains/user/conclusion.js";
import type {
  BehaviorCommitment,
  CompiledPolicyRule,
  LearningReceipt,
  UserEvidence,
  UserModelRecord,
} from "../../learning/domains/user/contracts.js";
import { classifyEligibility } from "../../learning/domains/user/eligibility.js";
import { appendReceiptsForNewCommitments } from "../../learning/domains/user/learning-receipt.js";
import { compilePolicyBundle } from "../../learning/domains/user/policy-compile.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";
import type { UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";
import { detectSpeechAct, residualPreference } from "../../learning/domains/user/speech-act.js";
import { reasonUserModels } from "../../learning/domains/user/user-model.js";

/**
 * 账本 → 当前有效政策包：把深链在**账本内容上跑一遍**。
 *
 * 链本身（资格闸 → 结论 → 模型 → 承诺 → 编译）一段未改，全是 UL 包落座好的纯函数；
 * 这个文件只负责按次序把它们串起来，并说清楚两件事：
 *
 *  - **为什么每轮重跑而不是读一份现成政策。** 现成的政策包得有人先写进盘。UL 包明
 *    确不落盘、不注入，接线也没人写过 —— 如果这里只「读当前有效政策 bundle」，读到
 *    的永远是空的，于是「让深链第一次真正影响行为」就成了一句空话。链是纯函数、
 *    输入只有账本里的证据，所以重跑是**确定性**的：同一份账本永远得到同一个包。
 *  - **它的代价是明写的。** 成本随账本线性增长，第一版接受它并登记 `OPEN-UE-6`
 *    （账本增长/裁剪），而不是先建一座存储底座 —— 存储是另一个待拍项。
 *
 * 另有两处是**故意不做**的：不落盘、不改账本。这个文件是纯的（除了 `now`），于是
 * 「链跑过了会留下什么」只有一个答案：什么都不留。
 */

export type DerivedUserPolicy = {
  readonly scopeFingerprint: string;
  readonly evidence: readonly UserEvidence[];
  readonly models: readonly UserModelRecord[];
  readonly commitments: readonly BehaviorCommitment[];
  readonly rules: readonly CompiledPolicyRule[];
  readonly bundleChecksum: string;
  /** 本次**新**产生的收据（已在账里的不重复计）。 */
  readonly newReceipts: readonly LearningReceipt[];
};

export type DeriveInput = {
  readonly records: readonly UserLearningRecord[];
  readonly userId: string;
  readonly workspaceId: string;
  readonly now: number;
};

export function evidenceOf(records: readonly UserLearningRecord[]): readonly UserEvidence[] {
  return records.filter((item) => item.record === "evidence").map((item) => item.evidence);
}

/**
 * 只保留**产生时**就属于当前工作区的证据（E0M1 P1-1）。
 *
 * 账本是单一物理文件、不按 workspace 分键，所以读出来时必须按证据自己盖的来源戳过滤，
 * 而不是把全部证据用当前运行时的 `userId+workspaceId` 重新盖戳合成——后者正是外部复核
 * 实测的跨 scope 串用：工作区 A 写的偏好会被建模成工作区 B 的模型与规则。
 *
 * 判定是**严格等值**，没有相似度、没有兜底：
 *  - `source.workspaceId === current` → 属于本工作区，进链；
 *  - 不等于（别的 workspace）→ 隔离，不进链；
 *  - 缺省（M1 之前的旧证据，来源未知）→ **同样隔离**。未知来源绝不提升到当前 scope，
 *    否则「旧证据归属不明」就会被悄悄当成「属于现在这个工作区」。
 */
export function evidenceInScope(
  evidence: readonly UserEvidence[],
  workspaceId: string,
): readonly UserEvidence[] {
  return evidence.filter((item) => item.source.workspaceId === workspaceId);
}

export function deriveUserPolicy(input: DeriveInput): DerivedUserPolicy {
  const evidence = evidenceInScope(evidenceOf(input.records), input.workspaceId);
  const scopeFingerprint = fingerprintScopeV2({ userId: input.userId, workspaceId: input.workspaceId });
  const eligibility = evidence.map((item) =>
    classifyEligibility({
      evidence: item,
      speechAct: detectSpeechAct(item.rawText),
      residualText: residualPreference(item.rawText),
      now: input.now,
    }),
  );
  const relations = discoverEvidenceRelations({
    userId: input.userId,
    fresh: evidence,
    existing: [],
    now: input.now,
  });
  const conclusions = synthesizeConclusions({
    userId: input.userId,
    fresh: evidence,
    existing: [],
    relations,
    scopeFingerprint,
    now: input.now,
  });
  const { models } = reasonUserModels({ userId: input.userId, conclusions, now: input.now });
  const commitments = compileBehaviorCommitments({
    userId: input.userId,
    models,
    evidence,
    eligibility,
    now: input.now,
  });
  const compiled = compilePolicyBundle({
    userId: input.userId,
    commitments,
    models,
    mode: "shadow",
    now: input.now,
  });

  return {
    scopeFingerprint,
    evidence,
    models,
    commitments,
    rules: compiled.rules,
    bundleChecksum: compiled.bundle.checksum,
    newReceipts: freshReceipts(input.records, evidence, commitments, input.now),
  };
}

/**
 * 新收据 = 全量收据 − 账里已有的。
 *
 * 比对用 `id` 而不是 `dedupeKey`：`learning-receipt.ts` 的 `id` 就是 dedupeKey 的
 * 哈希，两者一一对应，而 `id` 是账里已经存着的那个字段。
 */
function freshReceipts(
  records: readonly UserLearningRecord[],
  evidence: readonly UserEvidence[],
  commitments: readonly BehaviorCommitment[],
  now: number,
): readonly LearningReceipt[] {
  if (commitments.length === 0) {
    return [];
  }

  const existing = records.filter((item) => item.record === "receipt").map((item) => item.receipt);
  const known = new Set(existing.map((item) => item.id));

  return appendReceiptsForNewCommitments({ before: [], after: commitments, evidence, existing, now }).filter(
    (item) => !known.has(item.id),
  );
}
