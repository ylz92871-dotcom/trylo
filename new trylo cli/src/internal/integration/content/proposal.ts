import type {
  ProposalDraft,
  SubmitProposalCommand,
} from "../../learning/control/commands.js";
import type { AssetKind, ProposalSource } from "../../learning/control/contracts.js";
import { RISK_LEVELS } from "../../learning/control/contracts.js";
import type { ContentProposalAdmission } from "../contract/admission.js";
import type { MappingFailure, MappingResult } from "../contract/rejection.js";
import { mapped, rejected } from "../contract/rejection.js";
import {
  isIso8601,
  isNonEmptyString,
  isStringArray,
} from "../shared/validate.js";
import { domainForAssetKind } from "./scope.js";

export type ProposalCore = {
  readonly proposalId: string;
  readonly assetKind: AssetKind;
  readonly scope: string;
  readonly candidateRef: string;
  readonly source: ProposalSource;
  readonly observationRefs: readonly string[];
};

export type SubmitProposalOptions = {
  readonly requireBaseVersion: boolean;
  readonly requestedAuthorities: readonly string[];
};

/**
 * 组装 `submit_proposal` 的通用实现。`requestedAuthorities` 必须由调用方显式给出，
 * 因为「能不能请求权限」是各域的合同，不是 adapter 可以替它们决定的默认值。
 */
export function buildSubmitProposal(
  core: ProposalCore,
  admission: ContentProposalAdmission,
  options: SubmitProposalOptions,
): MappingResult<readonly SubmitProposalCommand[]> {
  if (!isNonEmptyString(admission.commandId)) {
    return rejected("missing_admission", "commandId is required");
  }

  if (!isIso8601(admission.issuedAt)) {
    return rejected("invalid_admission", "issuedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(core.proposalId)) {
    return rejected("missing_admission", "proposalId cannot be derived from the source draft");
  }

  if (!isNonEmptyString(core.scope)) {
    return rejected("missing_scope", "scope cannot be derived from the source draft");
  }

  if (!isNonEmptyString(core.candidateRef)) {
    return rejected("missing_admission", "candidateRef cannot be derived from the source draft");
  }

  if (!(RISK_LEVELS as readonly string[]).includes(admission.risk)) {
    return rejected("invalid_admission", `risk must be one of ${RISK_LEVELS.join("|")}`);
  }

  if (!isNonEmptyString(admission.hypothesis)) {
    return rejected("missing_admission", "hypothesis must be provided explicitly");
  }

  if (!isStringArray(admission.requiredVerifiers)) {
    return rejected("invalid_admission", "requiredVerifiers must be an array of strings");
  }

  if (!isStringArray(core.observationRefs)) {
    return rejected("invalid_admission", "observationRefs must be an array of strings");
  }

  if (options.requireBaseVersion && !isNonEmptyString(admission.baseVersionId)) {
    return rejected(
      "missing_base_version",
      "an edited version must declare the parent asset version id",
    );
  }

  if (admission.baseVersionId !== undefined && !isNonEmptyString(admission.baseVersionId)) {
    return rejected("invalid_admission", "baseVersionId must not be empty when provided");
  }

  const proposal: ProposalDraft = {
    proposalId: core.proposalId,
    domain: domainForAssetKind(core.assetKind),
    scope: core.scope,
    assetKind: core.assetKind,
    candidateRef: core.candidateRef,
    hypothesis: admission.hypothesis,
    observationRefs: [...core.observationRefs],
    risk: admission.risk,
    requiredVerifiers: [...admission.requiredVerifiers],
    requestedAuthorities: [...options.requestedAuthorities],
    source: core.source,
    ...(admission.baseVersionId === undefined
      ? {}
      : { baseVersionId: admission.baseVersionId }),
  };

  return mapped([
    {
      type: "submit_proposal",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      proposal,
    },
  ]);
}

/**
 * draft 自带 scope 时，admission 不得再提供一份：那等于给同一个概念开第二个状态源。
 */
export function checkNoAdmittedScope(
  admission: ContentProposalAdmission,
): MappingFailure | undefined {
  return admission.scope === undefined
    ? undefined
    : rejected("invalid_admission", "scope is derived from the draft; the admission must not provide one");
}

/** draft 必须仍是 draft：C 四域无权产出任何已晋升状态。返回 undefined 表示通过。 */
export function checkDraftStatus(status: string): MappingFailure | undefined {
  return status === "draft" ? undefined : rejected("not_a_draft", `status=${status}`);
}

/**
 * 内容学习域（user/prompt/skill/workflow）的提案入口。
 *
 * 不变式：内容学习域永远不请求权限，`requestedAuthorities` 恒为空数组。这是 P01 的
 * 硬规则（学习不能授予权限），不是默认值填充；需要权限的提案走的是 Board approval 流程。
 */
export function buildContentProposal(
  core: ProposalCore,
  admission: ContentProposalAdmission,
  options: { readonly requireBaseVersion: boolean },
): MappingResult<readonly SubmitProposalCommand[]> {
  return buildSubmitProposal(core, admission, {
    ...options,
    requestedAuthorities: [],
  });
}
