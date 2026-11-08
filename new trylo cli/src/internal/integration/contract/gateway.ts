import type { EvaluationEvidenceDraft } from "../../evaluation/types.js";
import type { RecordEvidenceCommand } from "../../learning/control/commands.js";
import type { EvidenceBundle, EvidenceKind, ExternalVerdict } from "../../learning/control/contracts.js";
import { EVIDENCE_KINDS } from "../../learning/control/contracts.js";
import type {
  ReceiptExpectation,
  ReceiptFailureCode,
  VerificationAuthorityReader,
} from "../../learning/verification-authority/contracts.js";
import type { ToolBoardCommandDraft } from "../../tooling/contract/types.js";
import type { ContentEvidenceAdmission, ToolEvidenceAdmission } from "./admission.js";
import type { MappingFailure, MappingFailureReason, MappingResult } from "./rejection.js";
import { mapped, rejected } from "./rejection.js";
import { isEvaluationEvidenceDraftShape } from "../shared/draft-shape.js";
import {
  isFiniteNumber,
  isIso8601,
  isNonEmptyString,
  isStringArray,
} from "../shared/validate.js";

/**
 * 唯一可信准入 gateway（WP-F §7 D3.2）。
 *
 * 这是 C/D 侧证据进入 Board 的**唯一**入口。它做三件事，顺序固定：
 *   1. 校验调用方提交的引用形状（只允许不透明 `receiptRef`）；
 *   2. 从 Verification Authority registry **读回**收据并核对全部绑定；
 *   3. 用读回的事实派生 canonical `record_evidence` 命令。
 *
 * 调用方提供的 verdict、actor、provenance、kinds、externalVerdict、selfGenerated
 * 一律不参与判定，只用于形状校验后丢弃。因此「完全自洽的伪造记录」（外审 R2
 * 的 P1-R1）在这里失去全部权力：registry 里没有这条收据就没有 external_verifier。
 *
 * 未注入 authority reader 时，本条路径不产生任何 Board 命令——不是降级到
 * 「相信调用方」，而是 fail closed。
 */

/** 收据失败码 → 映射层失败原因。两个枚举分属不同层，不合并。 */
const RECEIPT_FAILURE_TO_REASON: Readonly<Record<ReceiptFailureCode, MappingFailureReason>> = {
  missing_receipt_ref: "missing_verification_ref",
  invalid_receipt_ref: "missing_verification_ref",
  unknown_receipt: "verification_receipt_unavailable",
  receipt_revoked: "verification_receipt_unavailable",
  receipt_domain_mismatch: "verification_binding_mismatch",
  receipt_subject_mismatch: "verification_binding_mismatch",
  receipt_version_mismatch: "verification_binding_mismatch",
  receipt_scope_mismatch: "verification_binding_mismatch",
  // verifier 身份与 generator 相同 ⇒ 「产出者给自己打分」，沿用同一个 reason，
  // 不因为换了 authority 边界就新造同义码。
  receipt_identity_not_independent: "generator_is_evaluator",
  registry_corrupt: "verification_receipt_unavailable",
  registry_torn_tail: "verification_receipt_unavailable",
  registry_lock_conflict: "verification_receipt_unavailable",
  registry_write_failed: "verification_receipt_unavailable",
  registry_multi_writer: "verification_receipt_unavailable",
};

/** 按 canonical 枚举顺序输出 kinds；不依赖调用方书写顺序，也不需要类型断言。 */
function canonicalKindOrder(kinds: ReadonlySet<EvidenceKind>): readonly EvidenceKind[] {
  const ordered: EvidenceKind[] = [];

  for (const kind of EVIDENCE_KINDS) {
    if (kinds.has(kind)) {
      ordered.push(kind);
    }
  }

  return ordered;
}

type VerifiedSubject = {
  readonly receiptId: string;
  readonly verdict: ExternalVerdict;
  readonly checksDigest: string;
  readonly sourceDigest: string;
};

async function readVerifiedSubject(
  authority: VerificationAuthorityReader | undefined,
  receiptRef: unknown,
  expected: ReceiptExpectation,
): Promise<VerifiedSubject | { readonly failure: ReturnType<typeof rejected> }> {
  if (!isNonEmptyString(receiptRef)) {
    return {
      failure: rejected(
        "missing_verification_ref",
        "evidence must cite a receipt reference issued by the Verification Authority",
      ),
    };
  }

  if (authority === undefined) {
    return {
      failure: rejected(
        "verification_authority_unavailable",
        "no Verification Authority reader is injected; independent evidence cannot be admitted",
      ),
    };
  }

  const verified = await authority.verify({ receiptId: receiptRef }, expected);
  if (!verified.ok) {
    return {
      failure: rejected(
        RECEIPT_FAILURE_TO_REASON[verified.code],
        `${verified.code}: ${verified.message}`,
      ),
    };
  }

  if (verified.receipt.verdict !== "pass") {
    // 只有 pass 才能成为 promotion 依据；fail/partial 记录进不了这道门。
    return {
      failure: rejected(
        "verification_verdict_rejected",
        `receipt verdict is ${verified.receipt.verdict}, not pass`,
      ),
    };
  }

  return {
    receiptId: verified.receipt.receiptId,
    verdict: verified.receipt.verdict,
    checksDigest: verified.receipt.checksDigest,
    sourceDigest: verified.receipt.sourceDigest,
  };
}

/**
 * D 侧 admission 的形状校验。**顺序即失败码优先级，不要重排**——同一条输入命中
 * 多个条件时，先报的码是契约的一部分（测试按首码断言）。
 *
 * 抽成独立函数的理由是 §10 的单函数长度纪律：`admitToolEvidence` 曾因此超 60 行。
 */
function checkToolEvidenceAdmission(
  draft: Extract<ToolBoardCommandDraft, { kind: "submit_evidence" }>,
  admission: ToolEvidenceAdmission,
): MappingFailure | undefined {
  if (!isNonEmptyString(draft.evidenceId)) {
    return rejected("missing_admission", "evidenceId is required");
  }

  if (!isNonEmptyString(draft.summary)) {
    return rejected("missing_summary", "an evidence submission must say what it is");
  }

  if (!isNonEmptyString(admission.commandId)) {
    return rejected("missing_admission", "commandId is required");
  }

  if (!isIso8601(admission.issuedAt)) {
    return rejected("invalid_admission", "issuedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(admission.proposalId)) {
    return rejected("missing_admission", "proposalId is required");
  }

  if (!isNonEmptyString(admission.dataVersion)) {
    return rejected("missing_admission", "dataVersion is required");
  }

  if (!isNonEmptyString(admission.packageVersionId)) {
    return rejected("missing_version_link", "evidence must name the package version it covers");
  }

  if (!isNonEmptyString(admission.scope)) {
    return rejected("missing_scope", "evidence must name the scope it applies to");
  }

  if (admission.failureSamples !== undefined && !isStringArray(admission.failureSamples)) {
    return rejected("invalid_admission", "failureSamples must be an array of strings");
  }

  if (admission.critiqueRef !== undefined && !isNonEmptyString(admission.critiqueRef)) {
    return rejected("missing_admission", "critiqueRef must be a non-empty source reference");
  }

  if (admission.critiqueRef !== undefined && admission.critiqueRef === draft.summary) {
    return rejected("summary_as_provenance", "critiqueRef must be a source reference, not the summary");
  }

  return undefined;
}

/**
 * D 的 `submit_evidence` → `record_evidence`。
 *
 * `provenance` 由 gateway 从收据派生为 `receipt:<receiptId>`：Board 的晋升因此
 * 可被事后回查到 registry 里的同一条收据（WP-F §7 D3.5 的「可追溯」）。
 */
export async function admitToolEvidence(
  authority: VerificationAuthorityReader | undefined,
  draft: Extract<ToolBoardCommandDraft, { kind: "submit_evidence" }>,
  admission: ToolEvidenceAdmission,
): Promise<MappingResult<readonly RecordEvidenceCommand[]>> {
  const invalid = checkToolEvidenceAdmission(draft, admission);
  if (invalid !== undefined) {
    return invalid;
  }

  const verified = await readVerifiedSubject(authority, admission.receiptRef, {
    domain: "agent_method",
    subjectKind: "tool_package_version",
    subjectId: admission.packageVersionId,
    // 版本坐标：对工具包主体即 packageVersionId。收据覆盖旧版本时无法复用到新版本。
    subjectVersion: admission.packageVersionId,
    scope: admission.scope,
  });
  if ("failure" in verified) {
    return verified.failure;
  }

  const kinds = new Set<EvidenceKind>();

  kinds.add("external_verifier");

  if (admission.critiqueRef !== undefined) {
    kinds.add("llm_critique");
  }

  const evidence: EvidenceBundle = {
    evidenceId: draft.evidenceId,
    proposalId: admission.proposalId,
    kinds: canonicalKindOrder(kinds),
    dataVersion: admission.dataVersion,
    failureSamples: [...(admission.failureSamples ?? [])],
    provenance: `receipt:${verified.receiptId}`,
    externalVerdict: verified.verdict,
    receipt: {
      receiptId: verified.receiptId,
      checksDigest: verified.checksDigest,
      sourceDigest: verified.sourceDigest,
    },
  };

  return mapped([
    {
      type: "record_evidence",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      evidence,
    },
  ]);
}

/**
 * C 侧 admission 的形状校验（顺序即失败码优先级）。`draft` 的窄化由调用方的
 * `isEvaluationEvidenceDraftShape` 完成，因此这里直接收窄后的类型。
 */
function checkContentEvidenceAdmission(
  draft: EvaluationEvidenceDraft,
  admission: ContentEvidenceAdmission,
): MappingFailure | undefined {
  if (!isNonEmptyString(admission.commandId)) {
    return rejected("missing_admission", "commandId is required");
  }

  if (!isIso8601(admission.issuedAt)) {
    return rejected("invalid_admission", "issuedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(admission.evidenceId)) {
    return rejected("missing_admission", "evidenceId is required");
  }

  if (!isNonEmptyString(admission.dataVersion)) {
    return rejected("missing_admission", "dataVersion is required");
  }

  if (!isNonEmptyString(admission.candidateVersion)) {
    return rejected("missing_version_link", "evidence must name the candidate version it covers");
  }

  if (!isNonEmptyString(admission.scope)) {
    return rejected("missing_scope", "evidence must name the scope it applies to");
  }

  if (draft.replay.compared !== true) {
    return rejected("missing_replay", "evidence requires a completed baseline/candidate replay");
  }

  if (admission.failureSamples !== undefined && !isStringArray(admission.failureSamples)) {
    return rejected("invalid_admission", "failureSamples must be an array of strings");
  }

  if (admission.delta !== undefined) {
    const delta = admission.delta;
    if (
      !isNonEmptyString(delta.metric) ||
      !isFiniteNumber(delta.baseline) ||
      !isFiniteNumber(delta.candidate)
    ) {
      return rejected("invalid_admission", "delta requires metric and finite baseline/candidate");
    }
  }

  return undefined;
}

/**
 * C 的 `EvaluationEvidenceDraft` → `record_evidence`。
 *
 * draft 自带的 `externalAnchors[].selfGenerated` 与 `externalPass` **不再被读取**：
 * 它们保留在域 draft 里只作生成过程诊断（WP-F §7 D3.1 的「废弃」口径）。
 * 用户证据的唯一合法来源是 `user_explicit` 域收据，而该域只接受
 * `execution:` / `user_explicit:` 前缀的执行绑定事实。
 */
export async function admitContentEvidence(
  authority: VerificationAuthorityReader | undefined,
  draft: unknown,
  admission: ContentEvidenceAdmission,
): Promise<MappingResult<readonly RecordEvidenceCommand[]>> {
  if (!isEvaluationEvidenceDraftShape(draft)) {
    return rejected("invalid_admission", "evaluation evidence draft is malformed");
  }

  const invalid = checkContentEvidenceAdmission(draft, admission);
  if (invalid !== undefined) {
    return invalid;
  }

  const verified = await readVerifiedSubject(authority, admission.receiptRef, {
    domain: "user_explicit",
    subjectKind: "content_candidate",
    subjectId: draft.proposalId,
    subjectVersion: admission.candidateVersion,
    scope: admission.scope,
  });
  if ("failure" in verified) {
    return verified.failure;
  }

  const kinds = new Set<EvidenceKind>();

  kinds.add("user_feedback");

  if (draft.weakSignals.length > 0) {
    kinds.add("llm_critique");
  }

  const evidence: EvidenceBundle = {
    evidenceId: admission.evidenceId,
    proposalId: draft.proposalId,
    kinds: canonicalKindOrder(kinds),
    baselineRef: draft.baselineRef,
    candidateRef: draft.candidateRef,
    dataVersion: admission.dataVersion,
    failureSamples: [...(admission.failureSamples ?? [])],
    provenance: `receipt:${verified.receiptId}`,
    externalVerdict: verified.verdict,
    receipt: {
      receiptId: verified.receiptId,
      checksDigest: verified.checksDigest,
      sourceDigest: verified.sourceDigest,
    },
    ...(admission.delta === undefined ? {} : { delta: admission.delta }),
  };

  return mapped([
    {
      type: "record_evidence",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      evidence,
    },
  ]);
}
