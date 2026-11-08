import type {
  ReceiptExpectation,
  ReceiptFailureCode,
  VerificationReceipt,
} from "./contracts.js";
import { normalizeIdentity } from "./parse.js";

/**
 * 收据与本次 admission 的绑定核对（WP-F §5「receipt 内容由 authority store 读回，
 * 不信调用方回显」）。
 *
 * reader 在返回收据前必须调用本函数；gateway 不复用调用方提供的任何 verdict /
 * actor / selfGenerated 字段。核对是逐项 AND，任何一项不符整条 fail closed。
 */

export type BindingCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReceiptFailureCode; readonly message: string };

export function checkReceiptBinding(
  receipt: VerificationReceipt,
  expected: ReceiptExpectation,
): BindingCheck {
  if (receipt.domain !== expected.domain) {
    return refusal(
      "receipt_domain_mismatch",
      `receipt ${receipt.receiptId} is in domain ${receipt.domain}, not ${expected.domain}`,
    );
  }

  if (receipt.subject.subjectKind !== expected.subjectKind) {
    return refusal(
      "receipt_subject_mismatch",
      `receipt covers ${receipt.subject.subjectKind}, not ${expected.subjectKind}`,
    );
  }

  if (receipt.subject.subjectId !== expected.subjectId) {
    return refusal(
      "receipt_subject_mismatch",
      "the receipt covers a different subject than this admission names",
    );
  }

  // 改写即 stale：版本不符必须重新验证，不能复用旧 pass。
  if (receipt.subject.subjectVersion !== expected.subjectVersion) {
    return refusal(
      "receipt_version_mismatch",
      "a receipt cannot be replayed across subject versions; re-verification is required",
    );
  }

  if (receipt.subject.scope !== expected.scope) {
    return refusal(
      "receipt_scope_mismatch",
      "a receipt issued for one scope cannot authorize another",
    );
  }

  // generator === verifier 必须在这里再拒一次：签发侧已拒，读取侧不依赖签发侧行为。
  //
  // 比较落在**归一化后的身份**上（外审 R3 §3 P2-1）：`"one-agent "` 与 `"one-agent"`
  // 是同一身份，不能靠尾随空白 / 不换行空格 / 未合成序列冒充两个不同的 verifier。
  // 这里刻意不复用解析器的归一化结果：本函数是纯函数，可能被直接以手工构造的收据
  // 调用（见 `contract.test.ts`），因此必须自己归一化，而不是假设调用方已经做过。
  //
  // 未关闭的残留（不得写成已关闭）：大小写与 Unicode 同形字仍算两个不同身份。
  if (normalizeIdentity(receipt.verifierId) === normalizeIdentity(receipt.generatorId)) {
    return refusal(
      "receipt_identity_not_independent",
      "the receipt's verifier and generator are the same identity",
    );
  }

  return { ok: true };
}

export function refusal(code: ReceiptFailureCode, message: string): BindingCheck {
  return { ok: false, code, message };
}
