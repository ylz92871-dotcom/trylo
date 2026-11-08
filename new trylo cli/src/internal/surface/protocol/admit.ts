import { consume } from "../../protocol/compat.js";
import type { Envelope } from "../../protocol/envelope.js";
import { redactEnvelope } from "../../protocol/redact.js";
import { freezeEnvelope, parseEnvelope } from "../../protocol/validate.js";

/**
 * 投影进场闸：**唯一**的校验点与**唯一**的脱敏点。
 *
 * ```text
 * unknown ──parseEnvelope──► Envelope ──consume──► 已知 kind? ──redactEnvelope──► AdmittedEnvelope
 *                │                                      │
 *                └─ 失败：invalid_envelope               └─ 未知：ignored_unknown_kind（不投影）
 * ```
 *
 * 三条纪律：
 *
 * 1. **未过校验的 envelope 绝不投影**（WP §4 P2）。`parseEnvelope` 是仓库既有的
 *    帧级契约（protocolVersion 锁定、sequence 非负整数、payload 尺寸上限、
 *    `deepFreeze`），本包复用它，不写第二套校验。
 * 2. **脱敏只有一次，且在这里**（WP §2.3）。投影器再拿到的是已经脱敏的副本；
 *    投影器里不做任何清洗，也就不可能出现两套不一致的规则表。
 *    唯一规则表仍是 `protocol/redact.ts`。
 * 3. **未知 kind 不抛异常**：走 `consume()` 得到 `ignored_unknown_kind`，
 *    带上 `eventId`/`sequence`/`kind` 返回，调用方据此跳过而不是崩溃
 *    （对齐 `protocol/compat.ts` 的前向兼容取向，也满足 §5 反方第 8 条）。
 *
 * `AdmittedEnvelope` 带一个**不可导出的 symbol** 键：只有本模块能构造它，
 * 因此「未脱敏的 envelope 进不了投影器」是编译期事实，不是约定。
 */

const REDACTED: unique symbol = Symbol("trylo.surface.protocol.admitted");

export type AdmittedEnvelope = {
  /** 已校验、已脱敏、已冻结的 envelope。 */
  readonly envelope: Envelope;
  readonly [REDACTED]: true;
};

export type AdmitResult =
  | { readonly ok: true; readonly outcome: "admitted"; readonly admitted: AdmittedEnvelope }
  | {
      readonly ok: true;
      readonly outcome: "ignored_unknown_kind";
      readonly eventId: string;
      readonly sequence: number;
      readonly kind: string;
    }
  | { readonly ok: false; readonly code: "invalid_envelope"; readonly detail: string };

export function admit(raw: unknown): AdmitResult {
  const parsed = parseEnvelope(raw);
  if (!parsed.ok) {
    return { ok: false, code: "invalid_envelope", detail: parsed.code };
  }

  const consumed = consume(parsed.envelope);
  if (consumed.status === "ignored_unknown_kind") {
    return {
      ok: true,
      outcome: "ignored_unknown_kind",
      eventId: consumed.eventId,
      sequence: consumed.sequence,
      kind: consumed.kind,
    };
  }

  return {
    ok: true,
    outcome: "admitted",
    admitted: { envelope: freezeEnvelope(redactEnvelope(consumed.envelope)), [REDACTED]: true },
  };
}
