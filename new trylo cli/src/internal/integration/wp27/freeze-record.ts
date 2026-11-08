/**
 * WP27.3 独立复核与冻结候选。
 *
 * 意图：WP27 的冻结不是“绿色总门禁抵消”，而是逐包检查实际复核表、
 * 对象 hash、来源/制品和真实消费者证据后，对证据齐备的候选做版本冻结。
 * 冻结记录必须可回滚、可审计，且实现人与复核人不得为同一人。
 *
 * 边界：成熟度仍只由主能力矩阵及对应事实更新，本模块不另造状态 writer；
 * 缺平台/缺件不能签全量完成，排除项不得计 PASS。
 */

import type { ScopedCapability } from "./scope-ledger.js";

export type FreezeMaturity = "interface_ready" | "locally_verified" | "platform_verified" | "release_accepted";

export type FreezeCandidate = {
  readonly packageId: string;
  readonly sourceHash: string;
  /**
   * The revision the reviewer actually read. Without this the four-eyes check
   * can be satisfied by a review of an older tree: the reviewer signs, the code
   * moves, and the hash that gets frozen is not the hash that was looked at.
   */
  readonly reviewedHash: string;
  readonly artifactPath: string;
  readonly evidenceLink: string;
  readonly implementer: string;
  readonly reviewer: string;
  readonly maturityClaim: FreezeMaturity;
};

export type FreezeFailureCode =
  | "same_reviewer"
  | "missing_hash"
  | "missing_artifact"
  | "missing_evidence"
  | "anonymous_owner"
  | "excluded_claimed_pass"
  | "no_owned_capability"
  | "invalid_maturity"
  | "review_covers_other_revision";

export type FreezeFailure = {
  readonly code: FreezeFailureCode;
  readonly detail: string;
};

export type FreezeVerdict =
  | { readonly kind: "freezable"; readonly packageId: string }
  | { readonly kind: "not_freezable"; readonly failures: readonly FreezeFailure[] };

const MATURITY_CLAIMS: ReadonlySet<string> = new Set<FreezeMaturity>([
  "interface_ready",
  "locally_verified",
  "platform_verified",
  "release_accepted",
]);

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Identity is compared case-insensitively because the same person signing
 * `Alice` and `alice` is the same person, and a four-eyes check that can be
 * defeated by capitalisation is not a four-eyes check.
 */
function isSamePerson(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function collectOwnerFailures(candidate: FreezeCandidate): readonly FreezeFailure[] {
  const failures: FreezeFailure[] = [];

  if (isBlank(candidate.implementer) || isBlank(candidate.reviewer)) {
    failures.push({ code: "anonymous_owner", detail: `${candidate.packageId}: implementer/reviewer must be named` });
    return failures;
  }

  if (isSamePerson(candidate.implementer, candidate.reviewer)) {
    failures.push({ code: "same_reviewer", detail: `${candidate.packageId}: reviewer must differ from implementer` });
  }

  if (!MATURITY_CLAIMS.has(candidate.maturityClaim)) {
    failures.push({
      code: "invalid_maturity",
      detail: `${candidate.packageId}: maturity claim is not one of the four defined levels: ${candidate.maturityClaim}`,
    });
  }

  return failures;
}

function collectEvidenceFailures(candidate: FreezeCandidate): readonly FreezeFailure[] {
  const failures: FreezeFailure[] = [];

  if (isBlank(candidate.sourceHash)) {
    failures.push({ code: "missing_hash", detail: `${candidate.packageId}: source hash is required` });
  }

  if (isBlank(candidate.artifactPath)) {
    failures.push({ code: "missing_artifact", detail: `${candidate.packageId}: artifact path is required` });
  }

  if (isBlank(candidate.evidenceLink)) {
    failures.push({ code: "missing_evidence", detail: `${candidate.packageId}: evidence link is required` });
  }

  if (isBlank(candidate.reviewedHash)) {
    failures.push({ code: "missing_hash", detail: `${candidate.packageId}: the revision the reviewer read is required` });
  } else if (candidate.reviewedHash.trim() !== candidate.sourceHash.trim()) {
    failures.push({
      code: "review_covers_other_revision",
      detail: `${candidate.packageId}: reviewer signed ${candidate.reviewedHash} but ${candidate.sourceHash} would be frozen`,
    });
  }

  return failures;
}

/**
 * 冻结校验：owner 四眼、证据三件套齐备，且若该包主责全在排除范围，
 * 不得携带任何成熟度 PASS 断言（调用方以 excluded 包建候选即失败）。
 */
export function validateFreezeCandidate(
  candidate: FreezeCandidate,
  scope: readonly ScopedCapability[],
): FreezeVerdict {
  const failures: FreezeFailure[] = [...collectOwnerFailures(candidate), ...collectEvidenceFailures(candidate)];
  const owned = scope.filter((item) => item.primaryWorkPackage === candidate.packageId);
  const ownedInScope = owned.filter((item) => item.scope === "in_scope");

  if (owned.length === 0) {
    failures.push({
      code: "no_owned_capability",
      detail: `${candidate.packageId}: owns no capability in the scope ledger, so there is nothing to freeze`,
    });
  } else if (ownedInScope.length === 0) {
    failures.push({
      code: "excluded_claimed_pass",
      detail: `${candidate.packageId}: all owned capabilities are excluded_by_user; no PASS to freeze`,
    });
  }

  if (failures.length > 0) {
    return { kind: "not_freezable", failures };
  }

  return { kind: "freezable", packageId: candidate.packageId };
}
