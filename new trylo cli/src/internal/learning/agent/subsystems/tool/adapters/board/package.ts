import type { SubmitProposalCommand } from "../../../../../control/commands.js";
import type { ToolCandidate } from "../../../../../../tooling/contract/types.js";
import type { ToolPackageAdmission } from "../../../../../../integration/contract/admission.js";
import type { MappingFailure, MappingResult } from "../../../../../../integration/contract/rejection.js";
import { rejected } from "../../../../../../integration/contract/rejection.js";
import { isNonEmptyString, isNonEmptyStringArray, isStringArray } from "../../../../../../integration/shared/validate.js";
import { buildSubmitProposal } from "../../../../../../integration/content/proposal.js";

/** 工具候选的独立 verifier 就是十段验证流水线的 independent_verdict 段。 */
const TOOL_VERIFIER = "tool_validation_pipeline";

const REJECTED_LICENSES = [
  "GPL-2.0-only",
  "GPL-3.0-only",
  "AGPL-3.0-only",
  "UNLICENSED",
  "UNKNOWN",
  "SOURCE-AVAILABLE",
] as const;

/**
 * `ToolCandidate` → `submit_proposal`（`tool_package`）。
 *
 * 本 adapter 只做映射，不做下载/安装/验证。许可证与身份的硬拒绝在此 fail closed：
 * 被拒许可证、冒充官方、`open/` 来源都不应产出 Board proposal。
 * Apache-2.0 不是硬拒（按 WP-D 政策走审计门），因此不在本表内。
 *
 * 外审 P1-2：`requestedAuthorities` 与 `requiredPermissions` 必须**精确相等**
 * （同集合、无重复）——子集检查会放行夹带的 network/shell 权限请求；
 * 权限只能来自候选自身声明的最小集合。
 */
export function mapToolCandidate(
  candidate: ToolCandidate,
  admission: ToolPackageAdmission,
): MappingResult<readonly SubmitProposalCommand[]> {
  if ((REJECTED_LICENSES as readonly string[]).includes(candidate.licenseSpdx)) {
    return rejected(
      "license_not_admissible",
      `license ${candidate.licenseSpdx} cannot enter the board as a proposal`,
    );
  }

  if (candidate.officialIdentity === "impersonation_risk") {
    return rejected("identity_unverified", "candidate identity looks like an impersonation");
  }

  if (candidate.fromOpenTree) {
    return rejected(
      "reference_only_source",
      "open/ content stays reference material and does not gain product admission",
    );
  }

  if (!isNonEmptyString(candidate.candidateId)) {
    return rejected("missing_admission", "candidateId is required");
  }

  if (!isNonEmptyString(admission.scope)) {
    return rejected("missing_scope", "candidate has no scope; it must be admitted");
  }

  if (!isNonEmptyString(admission.hypothesis)) {
    return rejected("missing_admission", "hypothesis must be provided explicitly");
  }

  if (!isNonEmptyStringArray(admission.observationRefs)) {
    return rejected(
      "missing_observation_link",
      "a candidate proposal must trace back to at least one observation",
    );
  }

  if (!isStringArray(admission.requestedAuthorities)) {
    return rejected("invalid_admission", "requestedAuthorities must be an array of strings");
  }

  const permissionFailure = checkExactPermissions(
    candidate.requiredPermissions,
    admission.requestedAuthorities,
  );
  if (permissionFailure !== undefined) {
    return permissionFailure;
  }

  return buildSubmitProposal(
    {
      proposalId: `tool_package:${candidate.candidateId}`,
      assetKind: "tool_package",
      scope: admission.scope,
      candidateRef: `tool_package:${candidate.candidateId}:${candidate.commitOrVersion}`,
      source: "inferred",
      observationRefs: admission.observationRefs,
    },
    {
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      risk: candidate.supplyChainRisk,
      hypothesis: admission.hypothesis,
      requiredVerifiers: [TOOL_VERIFIER],
    },
    {
      requireBaseVersion: false,
      requestedAuthorities: [...candidate.requiredPermissions],
    },
  );
}

function checkExactPermissions(
  required: readonly string[],
  requested: readonly string[],
): MappingFailure | undefined {
  const duplicated = requested.some(
    (authority, index) => requested.indexOf(authority) !== index,
  );
  if (duplicated) {
    return rejected("authority_mismatch", "requestedAuthorities must not repeat an authority");
  }

  const missing = required.find((permission) => !requested.includes(permission));
  if (missing !== undefined) {
    return rejected(
      "authority_mismatch",
      `required permission ${missing} is not declared for approval`,
    );
  }

  const extra = requested.find((authority) => !required.includes(authority));
  if (extra !== undefined) {
    return rejected(
      "authority_mismatch",
      `requested authority ${extra} is not required by the candidate; smuggled permissions are rejected`,
    );
  }

  return undefined;
}
