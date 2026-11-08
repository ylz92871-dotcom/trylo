import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import {
  VERIFICATION_AUTHORITY_FORMAT_VERSION,
  type ReceiptFailureCode,
  type VerificationReceipt,
} from "../../learning/verification-authority/contracts.js";
import {
  hasExactKeys,
  isNonEmptyString,
  parseVerificationReceipt,
  unknownKeys,
} from "../../learning/verification-authority/parse.js";
import { epochMs } from "../../ports/approval-consumption.js";

/**
 * Verification Authority registry 的 append-only、带校验和的记录编码。
 *
 * 与 Permission store 的账本并列但**不共用**：两者记录的是不同事实（授权 vs 验证）。
 * 共享的是机械做法（checksum、序号连续、torn tail 拒绝、整写 + fsync），
 * 不共享任何 canonical 类型。
 *
 * 严格性（外审 R2 §4.4 的同类要求在这里从第一天就生效）：每条记录的键集合必须
 * 精确等于该 kind 的允许集合，多一个键即 corrupt，不允许「未知字段被静默忽略」。
 */

export const VERIFICATION_REGISTRY_FORMAT_VERSION = VERIFICATION_AUTHORITY_FORMAT_VERSION;

export type RegistryEvent =
  | {
      readonly formatVersion: typeof VERIFICATION_REGISTRY_FORMAT_VERSION;
      readonly kind: "receipt_issued";
      readonly sequence: number;
      readonly receiptId: string;
      readonly domain: string;
      readonly subjectKind: string;
      readonly subjectId: string;
      readonly subjectVersion: string;
      readonly scope: string;
      readonly verifierId: string;
      readonly generatorId: string;
      readonly verdict: string;
      readonly checksDigest: string;
      readonly sourceDigest: string;
      readonly issuedAt: string;
    }
  | {
      readonly formatVersion: typeof VERIFICATION_REGISTRY_FORMAT_VERSION;
      readonly kind: "receipt_revoked";
      readonly sequence: number;
      readonly receiptId: string;
      readonly revokedAt: string;
      readonly reason: string;
    };

export type RegistryDecodeErr = Extract<
  ReceiptFailureCode,
  "registry_corrupt" | "registry_torn_tail"
>;

export type RegistryDecode =
  | { readonly ok: true; readonly events: readonly RegistryEvent[] }
  | { readonly ok: false; readonly code: RegistryDecodeErr; readonly detail: string };

const RECEIPT_ISSUED_KEYS: readonly string[] = [
  "formatVersion",
  "kind",
  "sequence",
  "receiptId",
  "domain",
  "subjectKind",
  "subjectId",
  "subjectVersion",
  "scope",
  "verifierId",
  "generatorId",
  "verdict",
  "checksDigest",
  "sourceDigest",
  "issuedAt",
];

const RECEIPT_REVOKED_KEYS: readonly string[] = [
  "formatVersion",
  "kind",
  "sequence",
  "receiptId",
  "revokedAt",
  "reason",
];

export function encodeRegistryEvent(event: RegistryEvent): string {
  const payload = canonicalJson(event);
  return `${sha256Hex(payload)} ${payload}\n`;
}

export function decodeRegistry(raw: string): RegistryDecode {
  if (raw.length === 0) {
    return { ok: true, events: [] };
  }

  // 缺少结尾换行说明写入被中断；那条记录是否落盘不可知，整库拒绝服务。
  if (!raw.endsWith("\n")) {
    return corrupt("registry_torn_tail", "trailing record is incomplete");
  }

  const lines = splitRecordLines(raw);
  if (!lines.ok) {
    return corrupt("registry_corrupt", lines.detail);
  }

  const events: RegistryEvent[] = [];
  let expected = 1;

  for (const line of lines.value) {
    const parsed = decodeLine(line, expected);
    if (!parsed.ok) {
      return parsed;
    }
    events.push(parsed.event);
    expected = parsed.event.sequence + 1;
  }

  return { ok: true, events };
}

/**
 * 逐行切分，并且**把记录之间的空行判为损坏**（外审 R3 §3 P3-2）。
 *
 * 旧实现是 `raw.split("\n").filter((line) => line.length > 0)`：空行在读进逐行
 * 校验之前就被丢掉了，于是 `rec1\n\nrec2\n` 与 `rec1\nrec2\n` 无法区分。这与
 * `PERSISTENCE-AND-RECOVERY.md`「行尾换行是记录完整性的一部分 / 任何损坏都拒服务」
 * 的表述不一致，也没有权限提示作用——空行不携带记录，但它意味着文件被外部改过，
 * 属于必须 fail closed 的格式偏离。
 *
 * 结尾换行产生的那个空元素是**行终止符**，不是空行，因此先 pop 掉。
 */
function splitRecordLines(
  raw: string,
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly detail: string } {
  const lines = raw.split("\n");

  lines.pop();
  const blank = lines.findIndex((line) => line.length === 0);
  if (blank >= 0) {
    return { ok: false, detail: `blank line between records at line ${String(blank + 1)}` };
  }

  return { ok: true, value: lines };
}

function decodeLine(
  line: string,
  expectedSequence: number,
): { readonly ok: true; readonly event: RegistryEvent } | Extract<RegistryDecode, { ok: false }> {
  const space = line.indexOf(" ");
  if (space <= 0) {
    return corrupt("registry_corrupt", `missing checksum at seq~${String(expectedSequence)}`);
  }

  const checksum = line.slice(0, space);
  const payload = line.slice(space + 1);
  if (sha256Hex(payload) !== checksum) {
    return corrupt("registry_corrupt", `checksum mismatch at seq~${String(expectedSequence)}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return corrupt("registry_corrupt", `unparseable record at seq~${String(expectedSequence)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return corrupt("registry_corrupt", `record is not an object at seq~${String(expectedSequence)}`);
  }

  const event = parsed as Record<string, unknown>;
  if (event.formatVersion !== VERIFICATION_REGISTRY_FORMAT_VERSION) {
    return corrupt(
      "registry_corrupt",
      `unsupported format version ${String(event.formatVersion)} at seq~${String(expectedSequence)}`,
    );
  }

  if (typeof event.sequence !== "number" || event.sequence !== expectedSequence) {
    return corrupt(
      "registry_corrupt",
      `sequence gap: expected ${String(expectedSequence)} got ${String(event.sequence)}`,
    );
  }

  return decodeBody(event, expectedSequence);
}

function decodeBody(
  event: Record<string, unknown>,
  sequence: number,
): { readonly ok: true; readonly event: RegistryEvent } | Extract<RegistryDecode, { ok: false }> {
  if (event.kind === "receipt_issued") {
    return decodeReceiptIssued(event, sequence);
  }

  if (event.kind === "receipt_revoked") {
    return decodeReceiptRevoked(event, sequence);
  }

  return corrupt("registry_corrupt", `unknown kind ${String(event.kind)} at seq~${String(sequence)}`);
}

type DecodedEvent =
  | { readonly ok: true; readonly event: RegistryEvent }
  | Extract<RegistryDecode, { ok: false }>;

/** `receipt_issued` 分支（§10 单函数长度纪律：`decodeBody` 曾因此超 80 行）。 */
function decodeReceiptIssued(event: Record<string, unknown>, sequence: number): DecodedEvent {
  const extra = unknownKeys(event, RECEIPT_ISSUED_KEYS);
  if (extra.length > 0) {
    return corrupt("registry_corrupt", `unknown keys at seq~${String(sequence)}: ${extra.join(",")}`);
  }

  // 收据解析器只接受收据自己的 14 个键；`kind` 和 `sequence` 是账本记录层面的
  // 字段，不能混进去（否则「未知键」检查会把自己人挡在门外）。
  const receiptParse = parseVerificationReceipt({
    formatVersion: event.formatVersion,
    receiptId: event.receiptId,
    domain: event.domain,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    subjectVersion: event.subjectVersion,
    scope: event.scope,
    verifierId: event.verifierId,
    generatorId: event.generatorId,
    verdict: event.verdict,
    checksDigest: event.checksDigest,
    sourceDigest: event.sourceDigest,
    issuedAt: event.issuedAt,
    sequence,
  });
  if (!receiptParse.ok) {
    return corrupt("registry_corrupt", `${receiptParse.detail} at seq~${String(sequence)}`);
  }

  const receipt = receiptParse.value;

  return {
    ok: true,
    event: {
      formatVersion: VERIFICATION_REGISTRY_FORMAT_VERSION,
      kind: "receipt_issued",
      sequence,
      receiptId: receipt.receiptId,
      domain: receipt.domain,
      subjectKind: receipt.subject.subjectKind,
      subjectId: receipt.subject.subjectId,
      subjectVersion: receipt.subject.subjectVersion,
      scope: receipt.subject.scope,
      verifierId: receipt.verifierId,
      generatorId: receipt.generatorId,
      verdict: receipt.verdict,
      checksDigest: receipt.checksDigest,
      sourceDigest: receipt.sourceDigest,
      issuedAt: receipt.issuedAt,
    },
  };
}

/** `receipt_revoked` 分支。 */
function decodeReceiptRevoked(event: Record<string, unknown>, sequence: number): DecodedEvent {
  const extra = unknownKeys(event, RECEIPT_REVOKED_KEYS);
  if (extra.length > 0) {
    return corrupt("registry_corrupt", `unknown keys at seq~${String(sequence)}: ${extra.join(",")}`);
  }

  const receiptId = event.receiptId;
  const reason = event.reason;
  const revokedAt = event.revokedAt;
  if (
    !isNonEmptyString(receiptId) ||
    !isNonEmptyString(reason) ||
    !isNonEmptyString(revokedAt) ||
    epochMs(revokedAt) === undefined
  ) {
    return corrupt("registry_corrupt", `malformed receipt_revoked at seq~${String(sequence)}`);
  }

  return {
    ok: true,
    event: {
      formatVersion: VERIFICATION_REGISTRY_FORMAT_VERSION,
      kind: "receipt_revoked",
      sequence,
      receiptId,
      revokedAt,
      reason,
    },
  };
}

/**
 * 折算出某条收据的当前事实。撤销是后续事件，不改写已签发的记录——
 * 「改写即 stale」在这里表现为：主体/版本变更必须重新签发新收据。
 */
export type ResolvedReceipt = {
  readonly receipt: VerificationReceipt;
  readonly status: "active" | "revoked";
};

export function resolveReceipt(
  events: readonly RegistryEvent[],
  receiptId: string,
): ResolvedReceipt | undefined {
  let resolved: ResolvedReceipt | undefined;

  for (const event of events) {
    if (event.receiptId !== receiptId) {
      continue;
    }
    if (event.kind === "receipt_issued") {
      resolved = {
        receipt: {
          formatVersion: VERIFICATION_AUTHORITY_FORMAT_VERSION,
          receiptId: event.receiptId,
          domain: event.domain as VerificationReceipt["domain"],
          subject: {
            subjectKind: event.subjectKind as VerificationReceipt["subject"]["subjectKind"],
            subjectId: event.subjectId,
            subjectVersion: event.subjectVersion,
            scope: event.scope,
          },
          verifierId: event.verifierId,
          generatorId: event.generatorId,
          verdict: event.verdict as VerificationReceipt["verdict"],
          checksDigest: event.checksDigest,
          sourceDigest: event.sourceDigest,
          issuedAt: event.issuedAt,
          sequence: event.sequence,
        },
        status: "active",
      };
    } else if (resolved !== undefined) {
      resolved = { receipt: resolved.receipt, status: "revoked" };
    }
  }

  return resolved;
}

export function lastSequence(events: readonly RegistryEvent[]): number {
  const last = events[events.length - 1];
  return last === undefined ? 0 : last.sequence;
}

/** 供架构扫描与 codec 自检使用：记录键集合的单一来源。 */
export function registryKeySets(): {
  readonly issued: readonly string[];
  readonly revoked: readonly string[];
  readonly receipt: readonly string[];
} {
  return {
    issued: RECEIPT_ISSUED_KEYS,
    revoked: RECEIPT_REVOKED_KEYS,
    receipt: RECEIPT_ISSUED_KEYS.filter((key) => key !== "kind"),
  };
}

export { hasExactKeys };

function corrupt(
  code: RegistryDecodeErr,
  detail: string,
): Extract<RegistryDecode, { ok: false }> {
  return { ok: false, code, detail };
}
