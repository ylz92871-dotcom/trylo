import { epochMs } from "../../ports/approval-consumption.js";
import {
  RECEIPT_SUBJECT_KINDS,
  VERIFICATION_AUTHORITY_FORMAT_VERSION,
  VERIFICATION_DOMAINS,
  VERIFICATION_VERDICTS,
  type ReceiptSubjectKind,
  type VerificationDomain,
  type VerificationReceipt,
  type VerificationSubject,
  type VerificationVerdict,
} from "./contracts.js";

/**
 * 收据的运行时解析（WP-F §6 末段：新 persistent 类型必须有运行时 parser、
 * formatVersion、unknown-version 行为与唯一导出；禁止用 TypeScript brand 假装
 * 获得运行时安全）。
 *
 * 严格性来自两点：
 *   1. **键集合精确相等**——多一个键即 `registry_corrupt`。攻击者不能靠追加
 *      字段把「将来的语义」偷渡进当前记录（外审 R2 §4.4）。
 *   2. 每个字段都重新做枚举/时间/非空校验，不相信 `JSON.parse` 的结果形状。
 */

export type ReceiptParseFailure = {
  readonly ok: false;
  readonly reason: "registry_corrupt";
  readonly detail: string;
};

export type ReceiptParse<T> = { readonly ok: true; readonly value: T } | ReceiptParseFailure;

const RECEIPT_KEYS: readonly string[] = [
  "formatVersion",
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
  "sequence",
];

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 身份归一化：Unicode NFC + 去首尾空白（外审 R3 §3 P2-1）。
 *
 * 为什么必须有：`generatorId !== verifierId` 若按**原始字符串**比较，一个尾随
 * 空格、一个不换行空格或一段未合成的组合序列就能把同一个身份写成两个不同的串，
 * 于是「verifier 不是 generator」这条必要条件被字面层别名绕过。归一化把这类
 * 书写差异收拢到同一身份上，使比较落在**身份**而不是落在**写法**。
 *
 * 归一化只在身份字段上做：主体坐标（subjectId / subjectVersion / scope）不做，
 * 它们靠精确相等绑定，任何规范化都可能把两个不同的坐标折到一起。
 *
 * 明确**未**关闭（不得写成已关闭，登记在 `HANDOFF-MANIFEST.md` §OPEN-P2-1）：
 *   - 大小写差异（`One-Agent` 与 `one-agent`）仍是两个身份；
 *   - Unicode 同形字（拉丁 `a` 与西里尔 `а`）仍是两个身份；
 *   - NFC 只做规范等价合成，**不做**兼容折叠（NFKC 的语义会改写标识符本身）。
 */
export function normalizeIdentity(value: string): string {
  return value.normalize("NFC").trim();
}

export function isVerificationDomain(value: unknown): value is VerificationDomain {
  return (
    typeof value === "string" && (VERIFICATION_DOMAINS as readonly string[]).includes(value)
  );
}

export function isVerificationVerdict(value: unknown): value is VerificationVerdict {
  return (
    typeof value === "string" && (VERIFICATION_VERDICTS as readonly string[]).includes(value)
  );
}

export function isReceiptSubjectKind(value: unknown): value is ReceiptSubjectKind {
  return (
    typeof value === "string" && (RECEIPT_SUBJECT_KINDS as readonly string[]).includes(value)
  );
}

/** 键集合精确相等的机器可执行形式。 */
export function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) {
    return false;
  }
  const expected = new Set(keys);
  return actual.every((key) => expected.has(key));
}

export function unknownKeys(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const expected = new Set(keys);
  return Object.keys(record).filter((key) => !expected.has(key));
}

/** 收据上除主体坐标外的可收窄字段集合。 */
type ReceiptFields = {
  readonly receiptId: string;
  readonly checksDigest: string;
  readonly sourceDigest: string;
  readonly verifierId: string;
  readonly generatorId: string;
  readonly issuedAt: string;
  readonly verdict: VerificationVerdict;
  readonly sequence: number;
};

/**
 * 逐字段收窄（§10 单函数长度纪律：`parseVerificationReceipt` 曾因此超 60 行）。
 *
 * 先把字段读成局部常量再调用其他校验函数：属性访问的收窄会被后续函数调用重置，
 * 直接在返回对象里读 `value.x` 会退回 `unknown`。
 */
function parseReceiptFields(record: Record<string, unknown>): ReceiptParse<ReceiptFields> {
  const receiptId = record.receiptId;
  const checksDigest = record.checksDigest;
  const sourceDigest = record.sourceDigest;
  const verifierId = record.verifierId;
  const generatorId = record.generatorId;
  const issuedAt = record.issuedAt;
  const verdict = record.verdict;

  if (!isNonEmptyString(receiptId)) {
    return corrupt("receiptId must be a non-empty string");
  }

  if (!isNonEmptyString(checksDigest) || !isNonEmptyString(sourceDigest)) {
    return corrupt("checksDigest and sourceDigest are required");
  }

  if (!isNonEmptyString(verifierId) || !isNonEmptyString(generatorId)) {
    return corrupt("verifierId and generatorId are required");
  }

  if (!isVerificationVerdict(verdict)) {
    return corrupt(`unknown verdict ${String(verdict)}`);
  }

  if (!isNonEmptyString(issuedAt) || epochMs(issuedAt) === undefined) {
    return corrupt("issuedAt is not a strict ISO-8601 timestamp");
  }

  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence <= 0) {
    return corrupt("sequence must be a positive integer");
  }

  return {
    ok: true,
    value: { receiptId, checksDigest, sourceDigest, verifierId, generatorId, issuedAt, verdict, sequence },
  };
}

/**
 * 解析一条已签发收据。`sequence` 由 registry 在读取时按事件序回填，
 * 因此这里要求它是正整数（它已经过一个完整的账本解码）。
 */
export function parseVerificationReceipt(value: unknown): ReceiptParse<VerificationReceipt> {
  if (!isPlainRecord(value)) {
    return corrupt("receipt record is not an object");
  }

  if (value.formatVersion !== VERIFICATION_AUTHORITY_FORMAT_VERSION) {
    return corrupt(
      `unsupported receipt format version ${String(value.formatVersion)} (expected ${String(VERIFICATION_AUTHORITY_FORMAT_VERSION)})`,
    );
  }

  const extra = unknownKeys(value, RECEIPT_KEYS);
  if (extra.length > 0) {
    return corrupt(`receipt record carries unknown keys: ${extra.join(",")}`);
  }

  const subject = parseSubject(value);
  if (!subject.ok) {
    return subject;
  }

  const fields = parseReceiptFields(value);
  if (!fields.ok) {
    return fields;
  }

  return {
    ok: true,
    value: {
      formatVersion: VERIFICATION_AUTHORITY_FORMAT_VERSION,
      receiptId: fields.value.receiptId,
      domain: value.domain as VerificationDomain,
      subject: subject.value,
      // 身份在**解析边界**归一化一次（外审 R3 §3 P2-1）：读路径上的身份比较
      // 于是落在归一化后的值上，手写的 registry 文件（如 `"one-agent "` 对
      // `"one-agent"`）无法靠字面层别名冒充两个不同身份。
      verifierId: normalizeIdentity(fields.value.verifierId),
      generatorId: normalizeIdentity(fields.value.generatorId),
      verdict: fields.value.verdict,
      checksDigest: fields.value.checksDigest,
      sourceDigest: fields.value.sourceDigest,
      issuedAt: fields.value.issuedAt,
      sequence: fields.value.sequence,
    },
  };
}

function parseSubject(record: Record<string, unknown>): ReceiptParse<VerificationSubject> {
  if (!isVerificationDomain(record.domain)) {
    return corrupt(`unknown verification domain ${String(record.domain)}`);
  }

  if (!isReceiptSubjectKind(record.subjectKind)) {
    return corrupt(`unknown receipt subject kind ${String(record.subjectKind)}`);
  }

  if (
    !isNonEmptyString(record.subjectId) ||
    !isNonEmptyString(record.subjectVersion) ||
    !isNonEmptyString(record.scope)
  ) {
    return corrupt("subjectId, subjectVersion and scope must be non-empty strings");
  }

  return {
    ok: true,
    value: {
      subjectKind: record.subjectKind,
      subjectId: record.subjectId,
      subjectVersion: record.subjectVersion,
      scope: record.scope,
    },
  };
}

function corrupt(detail: string): ReceiptParseFailure {
  return { ok: false, reason: "registry_corrupt", detail };
}
