import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  LedgerPort,
  LedgerReadResult,
  LedgerWriteResult,
  UserLearningRecord,
} from "../../learning/domains/user/scheduler-ports.js";
import { OUTCOME_SIGNALS, RECEIPT_REASONS } from "../../learning/domains/user/contracts.js";
import { STRONG_SIGNALS } from "../../learning/domains/user/scheduler-ports.js";
import { isUserCycleRecord } from "../../learning/domains/user/learning-cycle-codec.js";

/**
 * 本地账本：一份追加型 `ndjson`。
 *
 * 放在 `integration/**` 而不是 `learning/**`，理由与 `integration/method/board-writer.ts`
 * 逐字相同：学习层不得 import `node:fs`（`learning/io-boundary.test.ts` 会把任何一条
 * `node:fs` 判红），而「这条记录落在磁盘上」不是学习层的知识。学习层只持有
 * `LedgerPort` 这个形状，实现由组合层借出——这正是 UE-1 那份 seam 的兑现处。
 *
 * 三条与 `learning-sink.ts`（方法子系统的落点）同源的纪律：
 *
 *  - **追加，且不阻塞用户任务。** 写失败吞掉、上报一行 warning 了事；账写不进不该让
 *    用户的任务失败。
 *  - **目录惰性建。** 开关没开时这个端口根本不会被构造；构造了也只有第一次真的写
 *    才建目录——于是「开了学习但这一轮什么都没发生」在磁盘上不留任何东西。
 *  - **读不到不是错误，读不懂才是。** 文件不存在 ⇒ 空账（关着的时候本来就没有）；
 *    有行但解不成记录 ⇒ 记 `unreadable` 计数并由调用方上报降级，**不当成空账**
 *    ——把读不懂的账当成空账，会让子系统在一个它并不理解的状态上继续做决定。
 */

export const USER_LEDGER_FILE = "ledger.ndjson";

/**
 * 读回的尾部上界。
 *
 * 每轮都要把账读回来跑一遍链，所以读的量必须有个上界。取尾部而不是头部：账是追加的，
 * 最近发生的事才最相关。裁剪与降采样登记在 `OPEN-UE-6`（账本增长），本包不建存储底座。
 */
export const LEDGER_TAIL_RECORDS = 500;

const RECORD_KINDS = new Set(["evidence", "signal", "policy", "receipt", "observation"]);

export function createFileLedgerPort(root: string): LedgerPort {
  const file = path.join(root, USER_LEDGER_FILE);
  let prepared = false;

  return {
    read: () => readLedger(file),

    append: (records) => {
      if (records.length === 0) {
        return { ok: true, appended: 0 };
      }
      try {
        if (!prepared) {
          mkdirSync(root, { recursive: true });
          prepared = true;
        }
        appendFileSync(file, records.map(lineOf).join(""), "utf8");
        return { ok: true, appended: records.length };
      } catch (error) {
        // 目录可能是建好之后又被删掉的，所以下一次写还会再试一次建目录。
        prepared = false;
        return { ok: false, reason: `ledger_write_failed:${messageOf(error)}` };
      }
    },
  };
}

function lineOf(record: UserLearningRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function readLedger(file: string): LedgerReadResult {
  let raw: string;

  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = codeOf(error);
    // 没有账 = 空账。任何别的读失败都是「读不到」，由调用方 fail closed。
    return code === "ENOENT" ? { ok: true, records: [], unreadable: 0 } : { ok: false, reason: code ?? "read_failed" };
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const records: UserLearningRecord[] = [];
  let unreadable = 0;

  for (const line of lines) {
    const decoded = decodeRecord(line);
    if (decoded === undefined) {
      unreadable += 1;
      continue;
    }
    records.push(decoded);
  }

  // Preserve immutable learned heads and their provenance outside the rolling event tail.
  // Retention/deletion still belongs to the existing user-memory lifecycle, not to central funding.
  const heads = new Map<string, UserLearningRecord>();

  for (const item of records) {
    if (item.record === "learning_version") heads.set(`version:${item.version.scopeFingerprint}:${item.version.availability ?? "ready"}`, item);
    if (item.record === "learning_progress") {
      heads.set(`progress:${item.progress.questionRef}`, item);
      if (item.progress.workRef !== undefined) heads.set(`progress-work:${item.progress.workRef}`, item);
    }
    if (item.record === "policy_fielding") heads.set(`fielding:${item.fielding.scopeFingerprint}`, item);
  }

  const retained = new Set<UserLearningRecord>([...records.slice(-LEDGER_TAIL_RECORDS), ...heads.values()]);
  const referencedVersions = new Set(records.flatMap(item => item.record === "policy_feedback" ? [item.feedback.versionId]
    : item.record === "policy_fielding" && retained.has(item) ? [item.fielding.versionId] : []));

  for (const item of records) if (item.record === "learning_version" && referencedVersions.has(item.version.versionId)) retained.add(item);

  const evidenceIds = new Set([...retained].flatMap(item => item.record === "learning_version" ? item.version.evidenceIds
    : item.record === "policy_feedback" && item.feedback.sourceEvidenceId !== undefined ? [item.feedback.sourceEvidenceId] : []));
  const feedbackReceiptIds = new Set(records.flatMap(item => item.record === "policy_feedback" ? [item.feedback.receiptId] : []));

  for (const item of records) {
    if (item.record === "evidence" && evidenceIds.has(item.evidence.id) || item.record === "policy_feedback"
      || item.record === "policy_fielding" && feedbackReceiptIds.has(item.fielding.receiptId)) retained.add(item);
  }

  return { ok: true, records: records.filter(item => retained.has(item)), unreadable };
}

/**
 * 一行 → 一条记录（E0：全分支完整解码）。
 *
 * 每个 `record` 分支校验其必需字段、枚举、数组与有限数字；坏行返回
 * `undefined` 由调用方计 `unreadable` 并降级上报，永不把伪合法对象送进
 * reducer（F08/U07）。未知 `formatVersion` 显式拒绝，不按空档。
 *
 * 写进这份文件的只有本模块自己；未知键允许保留（前向兼容），但已知
 * 必需字段缺一不可。判别键 `record` 之外的形状权威仍在
 * `learning/domains/user/contracts.ts` 与 `scheduler-ports.ts`，
 * 这里只做读边界的运行时守卫，不另立第二份语义。
 */
function decodeRecord(line: string): UserLearningRecord | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const fields = parsed as Record<string, unknown>;
  if (fields["formatVersion"] !== undefined && fields["formatVersion"] !== 1) {
    return undefined;
  }

  if (isUserCycleRecord(parsed)) return parsed;

  const kind = fields["record"];
  if (typeof kind !== "string" || !RECORD_KINDS.has(kind)) {
    return undefined;
  }

  if (kind === "evidence") {
    return isEvidenceShape(fields["evidence"]) ? (parsed as UserLearningRecord) : undefined;
  }

  if (kind === "signal") {
    return isSignalShape(fields) ? (parsed as UserLearningRecord) : undefined;
  }

  if (kind === "policy") {
    return isPolicyShape(fields) ? (parsed as UserLearningRecord) : undefined;
  }

  if (kind === "receipt") {
    return isReceiptShape(fields["receipt"]) ? (parsed as UserLearningRecord) : undefined;
  }

  return isObservationShape(fields["observation"]) ? (parsed as UserLearningRecord) : undefined;
}

const EVIDENCE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "explicit_statement",
  "correction",
  "choice",
  "approval",
  "rejection",
  "override",
  "intervention",
]);

const EVIDENCE_DURABILITY: ReadonlySet<string> = new Set([
  "task_local",
  "session_local",
  "long_term_candidate",
  "authoritative_long_term",
]);

const USER_SIGNAL_KINDS: ReadonlySet<string> = new Set([
  "task_requirement",
  "task_override",
  "collaboration_preference",
  "correction",
  "cognition_answer",
  "impact_resolution",
]);

const INFORMEDNESS_STAGES: ReadonlySet<string> = new Set([
  "pre_task",
  "in_task",
  "post_execution",
  "post_outcome",
  "unknown",
]);

const SCOPE_NARROWNESS: ReadonlySet<string> = new Set(["narrow", "medium", "broad"]);

const STRONG_SIGNAL_SET: ReadonlySet<string> = new Set(STRONG_SIGNALS);

const RECEIPT_REASON_SET: ReadonlySet<string> = new Set(RECEIPT_REASONS);

const OUTCOME_SIGNAL_SET: ReadonlySet<string> = new Set(OUTCOME_SIGNALS);

const OUTCOME_ATTRIBUTION: ReadonlySet<string> = new Set(["direct", "partial", "unknown"]);

const REVOKE_ACTIONS: ReadonlySet<string> = new Set([
  "this_time_only",
  "change_scope",
  "pause",
  "retract",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvidenceShape(value: unknown): boolean {
  if (!isRecordObject(value)) {
    return false;
  }

  if (!isNonEmptyString(value["id"]) || typeof value["rawText"] !== "string" || !isNonEmptyString(value["textHash"])) {
    return false;
  }

  const claim = value["claim"];
  if (!(typeof claim === "string" || claim === null)) {
    return false;
  }

  if (typeof value["eventKind"] !== "string" || !EVIDENCE_EVENT_KINDS.has(value["eventKind"])) {
    return false;
  }

  if (typeof value["durability"] !== "string" || !EVIDENCE_DURABILITY.has(value["durability"])) {
    return false;
  }

  if (typeof value["signalKind"] !== "string" || !USER_SIGNAL_KINDS.has(value["signalKind"])) {
    return false;
  }

  if (!isFiveQuestions(value["answers"])) {
    return false;
  }

  if (!isRecordObject(value["source"]) || !isNonEmptyString(value["source"]["sessionId"])) {
    return false;
  }

  const source = value["source"];

  for (const key of ["taskId", "turnId", "actionId", "traceId", "workspaceId"] as const) {
    if (!isOptionalString(source[key])) {
      return false;
    }
  }

  return isNonEmptyString(value["sourceHash"]) && isFiniteNumber(value["createdAt"]);
}

function isFiveQuestions(value: unknown): boolean {
  if (!isRecordObject(value)) {
    return false;
  }

  const semantic = value["semantic"];
  const relevance = value["relevance"];

  if (!((typeof semantic === "number" && Number.isFinite(semantic)) || semantic === null)) {
    return false;
  }

  if (!((typeof relevance === "number" && Number.isFinite(relevance)) || relevance === null)) {
    return false;
  }

  const informed = value["contextInformedness"];
  if (!(informed === null || (typeof informed === "string" && INFORMEDNESS_STAGES.has(informed)))) {
    return false;
  }

  const governance = value["governance"];
  if (!(governance === null || governance === 1 || governance === 2 || governance === 3 || governance === 4)) {
    return false;
  }

  const narrow = value["scopeNarrowness"];

  return narrow === null || (typeof narrow === "string" && SCOPE_NARROWNESS.has(narrow));
}

function isSignalShape(fields: Record<string, unknown>): boolean {
  return (
    typeof fields["signal"] === "string" &&
    STRONG_SIGNAL_SET.has(fields["signal"]) &&
    isNonEmptyString(fields["eventId"]) &&
    isFiniteNumber(fields["at"]) &&
    isOptionalString(fields["sessionId"]) &&
    isOptionalString(fields["turnId"])
  );
}

function isPolicyShape(fields: Record<string, unknown>): boolean {
  return (
    typeof fields["adopted"] === "boolean" &&
    isStringArray(fields["ruleIds"]) &&
    isFiniteNumber(fields["matched"]) &&
    isFiniteNumber(fields["chars"]) &&
    isNonEmptyString(fields["scopeFingerprint"]) &&
    isNonEmptyString(fields["bundleChecksum"]) &&
    isOptionalString(fields["turnId"]) &&
    isFiniteNumber(fields["at"])
  );
}

function isReceiptShape(value: unknown): boolean {
  if (!isRecordObject(value)) {
    return false;
  }

  if (!isNonEmptyString(value["id"]) || !isNonEmptyString(value["commitmentId"])) {
    return false;
  }

  if (!isFiniteNumber(value["commitmentVersion"]) || !isNonEmptyString(value["dedupeKey"])) {
    return false;
  }

  if (typeof value["reason"] !== "string" || !RECEIPT_REASON_SET.has(value["reason"])) {
    return false;
  }

  if (!isNonEmptyString(value["scopeLabel"]) || typeof value["effectSummary"] !== "string") {
    return false;
  }

  if (
    !Array.isArray(value["revokeActions"]) ||
    !value["revokeActions"].every((item) => typeof item === "string" && REVOKE_ACTIONS.has(item))
  ) {
    return false;
  }

  return typeof value["message"] === "string" && isFiniteNumber(value["createdAt"]);
}

function isObservationShape(value: unknown): boolean {
  if (!isRecordObject(value)) {
    return false;
  }

  if (!isNonEmptyString(value["id"]) || !isNonEmptyString(value["commitmentId"])) {
    return false;
  }

  if (!isOptionalString(value["traceId"])) {
    return false;
  }

  return (
    typeof value["signal"] === "string" &&
    OUTCOME_SIGNAL_SET.has(value["signal"]) &&
    typeof value["attribution"] === "string" &&
    OUTCOME_ATTRIBUTION.has(value["attribution"]) &&
    isFiniteNumber(value["createdAt"])
  );
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function messageOf(error: unknown): string {
  return codeOf(error) ?? (error instanceof Error ? error.message : "unknown");
}

/** 写成一行给用户的降级提示。与 `learning-sink.ts` 的口径一致：码优先。 */
export function ledgerDegradation(result: LedgerReadResult | LedgerWriteResult): string | undefined {
  return result.ok ? undefined : `user_learning_ledger:${result.reason}`;
}
