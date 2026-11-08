import {
  AGENT_METHOD_SUBJECT_KIND,
  USER_EXPLICIT_SOURCE_PREFIXES,
  USER_EXPLICIT_SUBJECT_KIND,
  VERIFICATION_AUTHORITY_FORMAT_VERSION,
  type ReceiptIssuanceFailureCode,
  type ReceiptIssuanceInput,
  type VerificationReceipt,
  type VerificationVerdict,
} from "./contracts.js";
import { isNonEmptyString, normalizeIdentity } from "./parse.js";
import { epochMs } from "../../ports/approval-consumption.js";
import { canonicalJson, sha256Hex } from "../control/hash.js";
import {
  checkValidationRecord,
  deriveChecksDigest,
  deriveSourceDigest,
} from "./validation-record.js";

/**
 * 签发校验与收据派生（WP-F §7 D1.2）。
 *
 * 这里是「权限签发只由 Permission Service、证据签发只由 Verification Authority」
 * 在证据侧的对应物：verifier/checker composition 提交事实，authority 派生收据。
 * 调用方不能提供 verdict / digest，也不能用 `user_explicit` 域夹带 external 验证。
 */

export type IssuanceDraft = {
  readonly domain: VerificationReceipt["domain"];
  readonly receiptId: string;
  readonly subject: VerificationReceipt["subject"];
  readonly verifierId: string;
  readonly generatorId: string;
  readonly verdict: VerificationVerdict;
  readonly checksDigest: string;
  readonly sourceDigest: string;
  readonly issuedAt: string;
};

export type IssuanceCheck =
  | { readonly ok: true; readonly draft: IssuanceDraft }
  | { readonly ok: false; readonly code: ReceiptIssuanceFailureCode; readonly message: string };

export function checkIssuance(input: unknown): IssuanceCheck {
  if (typeof input !== "object" || input === null) {
    return refusal("missing_issuance_field", "issuance input must be an object");
  }

  const candidate = input as Partial<ReceiptIssuanceInput> & Record<string, unknown>;
  const domain = candidate.domain;
  if (domain !== "agent_method" && domain !== "user_explicit") {
    return refusal("missing_issuance_field", `unknown issuance domain ${String(domain)}`);
  }

  const subject = candidate.subject;
  if (typeof subject !== "object" || subject === null) {
    return refusal("missing_issuance_field", "issuance subject is required");
  }

  const coordinates = subject as Record<string, unknown>;
  if (
    !isNonEmptyString(coordinates.subjectKind) ||
    !isNonEmptyString(coordinates.subjectId) ||
    !isNonEmptyString(coordinates.subjectVersion) ||
    !isNonEmptyString(coordinates.scope)
  ) {
    return refusal(
      "missing_issuance_field",
      "subjectKind, subjectId, subjectVersion and scope must all be non-empty",
    );
  }

  const verifierRaw = candidate.verifierId;
  const generatorRaw = candidate.generatorId;
  if (!isNonEmptyString(verifierRaw) || !isNonEmptyString(generatorRaw)) {
    return refusal("missing_issuance_field", "verifierId and generatorId are required");
  }

  // 身份分离是必要条件（不是独立性证明）。比较必须在**归一化身份**上做，
  // 否则 `"one-agent "` 与 `"one-agent"` 会被记成两个不同身份（外审 R3 §3 P2-1）。
  // 归一化后的值一路写进收据，registry 里因此不会留下带别名的身份。
  const verifierId = normalizeIdentity(verifierRaw);
  const generatorId = normalizeIdentity(generatorRaw);
  if (verifierId === generatorId) {
    return refusal("generator_is_verifier", "the verifier of a receipt cannot be its generator");
  }

  const issuedAt = candidate.issuedAt;
  if (!isNonEmptyString(issuedAt) || epochMs(issuedAt) === undefined) {
    return refusal("invalid_issuance_timestamp", "issuedAt must be a strict ISO-8601 timestamp");
  }

  const receiptId = candidate.receiptId;
  if (!isNonEmptyString(receiptId)) {
    return refusal("missing_issuance_field", "receiptId must be supplied by the authority");
  }

  if (domain === "agent_method") {
    return checkAgentMethod({ candidate, verifierId, generatorId, issuedAt, receiptId });
  }

  return checkUserExplicit({ candidate, verifierId, generatorId, issuedAt, receiptId });
}

/**
 * 已经把「调用方不可自报」的字段收窄成确定值的签发上下文。
 * 传值而不是继续 spread 未收窄的 `Record<string, unknown>`，避免
 * `exactOptionalPropertyTypes` 下把可选属性混进必填位置。
 */
type IssuanceContext = {
  readonly candidate: Record<string, unknown>;
  readonly verifierId: string;
  readonly generatorId: string;
  readonly issuedAt: string;
  readonly receiptId: string;
};

function checkAgentMethod(context: IssuanceContext): IssuanceCheck {
  const { candidate } = context;
  const checked = checkValidationRecord(candidate.validationRecord);
  if (!checked.ok) {
    // 结构不完整的记录不能变成收据；也就永远派生不出 pass。
    return refusal("verdict_not_bound_to_checks", checked.detail);
  }

  const record = checked.record;
  if (record.verdict !== "pass") {
    return refusal(
      "verdict_not_bound_to_checks",
      "an agent_method receipt may only be issued for a passing validation record",
    );
  }

  const subject = candidate.subject as Record<string, unknown>;
  if (subject.subjectKind !== AGENT_METHOD_SUBJECT_KIND) {
    return refusal(
      "missing_issuance_field",
      `agent_method receipts must cover ${AGENT_METHOD_SUBJECT_KIND}`,
    );
  }

  if (subject.subjectId !== record.packageVersionId) {
    return refusal(
      "missing_issuance_field",
      "the receipt subject must be the package version the validation record covers",
    );
  }

  return {
    ok: true,
    draft: {
      domain: "agent_method",
      receiptId: context.receiptId,
      subject: {
        subjectKind: AGENT_METHOD_SUBJECT_KIND,
        subjectId: record.packageVersionId,
        subjectVersion: String(subject.subjectVersion),
        scope: String(subject.scope),
      },
      verifierId: context.verifierId,
      generatorId: context.generatorId,
      verdict: "pass",
      checksDigest: deriveChecksDigest(record),
      sourceDigest: deriveSourceDigest(record),
      issuedAt: context.issuedAt,
    },
  };
}

function checkUserExplicit(context: IssuanceContext): IssuanceCheck {
  const { candidate } = context;
  const sourceFactRef = candidate.sourceFactRef;
  if (!isNonEmptyString(sourceFactRef)) {
    return refusal(
      "missing_issuance_field",
      "user_explicit receipts must cite an execution-bound or user-explicit fact reference",
    );
  }

  const prefixed = USER_EXPLICIT_SOURCE_PREFIXES.some((prefix) => sourceFactRef.startsWith(prefix));
  if (!prefixed) {
    return refusal(
      "missing_issuance_field",
      `user evidence sources must start with one of ${USER_EXPLICIT_SOURCE_PREFIXES.join("|")}`,
    );
  }

  const subject = candidate.subject as Record<string, unknown>;
  if (subject.subjectKind !== USER_EXPLICIT_SUBJECT_KIND) {
    return refusal(
      "missing_issuance_field",
      `user_explicit receipts must cover ${USER_EXPLICIT_SUBJECT_KIND}`,
    );
  }

  const narrowed = {
    subjectKind: USER_EXPLICIT_SUBJECT_KIND,
    subjectId: String(subject.subjectId),
    subjectVersion: String(subject.subjectVersion),
    scope: String(subject.scope),
  } as const;

  return {
    ok: true,
    draft: {
      domain: "user_explicit",
      receiptId: context.receiptId,
      subject: narrowed,
      verifierId: context.verifierId,
      generatorId: context.generatorId,
      // 用户明令只有 pass 形态：它不是验证结论，不存在「用户让它 fail」。
      verdict: "pass",
      ...deriveUserExplicitDigests(narrowed, sourceFactRef),
      issuedAt: context.issuedAt,
    },
  };
}

/**
 * `user_explicit` 域的摘要派生。
 *
 * 关键点：**不把事实引用原样写进摘要字段**。`checks:${ref}` 这种写法等于让调用方
 * 直接决定 digest 的内容——那正是外审 R2 §3.1 在 D 侧关掉的「回显而非派生」。
 * 这里两个摘要都从 authority 自己收窄后的事实算出：
 *   - `checksDigest` 绑定「被核对的对象」：主体坐标 + 所引用的事实；
 *   - `sourceDigest` 绑定「被引用的来源」：事实引用本身。
 *
 * 于是 registry 里不会出现明文事实引用（WP-F §5「只存最小摘要与 digest/ref」），
 * 同一事实的收据仍可通过摘要做审计关联。
 */
function deriveUserExplicitDigests(
  subject: VerificationReceipt["subject"],
  sourceFactRef: string,
): { readonly checksDigest: string; readonly sourceDigest: string } {
  return {
    checksDigest: `checks:${sha256Hex(canonicalJson({ subject, sourceFactRef })).slice(0, 32)}`,
    sourceDigest: `source:${sha256Hex(sourceFactRef).slice(0, 32)}`,
  };
}

export function receiptFromDraft(draft: IssuanceDraft, sequence: number): VerificationReceipt {
  return {
    formatVersion: VERIFICATION_AUTHORITY_FORMAT_VERSION,
    receiptId: draft.receiptId,
    domain: draft.domain,
    subject: draft.subject,
    verifierId: draft.verifierId,
    generatorId: draft.generatorId,
    verdict: draft.verdict,
    checksDigest: draft.checksDigest,
    sourceDigest: draft.sourceDigest,
    issuedAt: draft.issuedAt,
    sequence,
  };
}

function refusal(code: ReceiptIssuanceFailureCode, message: string): IssuanceCheck {
  return { ok: false, code, message };
}
