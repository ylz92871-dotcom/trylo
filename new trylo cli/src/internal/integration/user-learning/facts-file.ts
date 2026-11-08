import { appendFileSync, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  MemoryFactKind,
  MemoryProposalStatus,
  MemoryScope,
  MemorySource,
  UserFactRecord,
  UserMemoryRecord,
} from "../../learning/domains/user/memory-fact.js";
import { compactMemoryRecords, MEMORY_FACT_KINDS, MEMORY_FACT_STATUSES, MEMORY_PROPOSAL_STATUSES } from "../../learning/domains/user/memory-fact.js";

/**
 * 用户事实的落点：`<userLearningRoot>/facts.ndjson`。
 *
 * 为什么不和 `ledger.ndjson` 同一个文件：账本按信号追加、只读尾部
 * `LEDGER_TAIL_RECORDS` 条（`ledger-file.ts:39`）。事实放进去会被后续信号滚出
 * 窗口——"记住的事"恰恰是最不该被滚动淘汰的那一类。分文件后，每轮成本只与事实
 * 条数相关（有界），与信号量无关。
 *
 * 这是**同一个所有者**的第二份物理文件，不是第二个账本：写它的只有
 * `UserMemoryService` 一个 writer，读它的只有检索与面板，两者都从本模块取；
 * 没有第二套生命周期、没有第二个写入路径。放弃的方案：把尾部上界调大（治标，
 * 仍会滚出）、每轮全量扫描信号账（无界）。
 *
 * 文件字节、记录数和单行均有硬上限；不存在才是空库，读失败/超限均显式拒绝。
 */

export const USER_FACTS_FILE = "facts.ndjson";
/** Known plaintext residue; delete-all owns cleanup after acquiring the shared writer lock. */
export const USER_FACTS_COMPACT_FILE = `${USER_FACTS_FILE}.compact.tmp`;
/** Beside the facts file, so one root has exactly one writer at a time. */
export const USER_FACTS_LOCK = "facts.lock";
export const USER_FACTS_MAX_BYTES = 16 * 1024 * 1024;
export const USER_FACTS_MAX_RECORDS = 32_768;
export const USER_FACTS_MAX_LINE_BYTES = 65_536;

export type FactCompactResult =
  | { readonly ok: true; readonly before: number; readonly after: number }
  | { readonly ok: false; readonly reason: string };

export type FileFactStore = UserFactStore & { readonly compact: () => FactCompactResult };

export type FactReadResult =
  | { readonly ok: true; readonly records: ReadonlyArray<UserMemoryRecord>; readonly unreadable: number }
  | { readonly ok: false; readonly reason: string };

export type FactAppendResult =
  | { readonly ok: true; readonly appended: number }
  | { readonly ok: false; readonly reason: string };

export type UserFactStore = {
  readonly read: () => FactReadResult;
  readonly append: (records: ReadonlyArray<UserMemoryRecord>) => FactAppendResult;
  /**
   * Read-validate-append under one exclusive lock (B11).
   *
   * Without it, two CLI processes correcting the same fact both read v1, both
   * pass the version check, and both append v2 — one edit silently disappears
   * and the fold picks a winner by timestamp. The lock makes the check and the
   * append one step, so the second writer sees the first one's version.
   */
  readonly transact: <T>(
    body: (records: ReadonlyArray<UserMemoryRecord>) => FactTransactionStep<T>,
  ) => FactTransactionResult<T>;
};

export type FactTransactionStep<T> =
  | { readonly result: T; readonly commit?: undefined }
  | { readonly result: T; readonly commit: ReadonlyArray<UserMemoryRecord> };

export type FactTransactionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * The same `O_EXCL` test-and-set the permission ledger uses
 * (`adapters/permission-store/lock.ts`). Duplicated rather than imported because
 * that module's error vocabulary belongs to approval consumption and importing it
 * here would couple two unrelated owners. It is the one deliberate copy in this
 * package; extract it when the permission store is next in scope.
 *
 * A lock left by a crashed process is a refusal, not something to steal: the
 * caller is told the path so a human can clear it, and never guesses whether an
 * interrupted append happened.
 */
export function acquireFactLock(lockPath: string): { readonly ok: true; readonly release: () => void } | { readonly ok: false } {
  let fd: number;

  try {
    fd = openSync(lockPath, "wx");
  } catch {
    return { ok: false };
  }

  return {
    ok: true,

    release() {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // The lock may already be gone (crash cleanup by a human). Releasing is
        // still complete: the descriptor is closed either way.
      }
    },
  };
}

export function createFileFactStore(root: string): FileFactStore {
  const file = path.join(root, USER_FACTS_FILE);
  const lock = path.join(root, USER_FACTS_LOCK);
  let prepared = false;

  function prepare(): void {
    if (prepared) return;
    mkdirSync(root, { recursive: true });
    prepared = true;
  }

  function appendNow(records: ReadonlyArray<UserMemoryRecord>): FactAppendResult {
    if (records.length === 0) return { ok: true, appended: 0 };
    try {
      const current = readFacts(file);
      if (!current.ok) return current;

      if (current.unreadable > 0) return { ok: false, reason: "facts_corrupt" };

      if (current.records.length + records.length > USER_FACTS_MAX_RECORDS) return capacityFailure("records");

      const serialized = serializeFacts(records);
      if (!serialized.ok) return serialized;

      const existing = readBoundedFacts(file);
      if (!existing.ok) return existing;

      if (Buffer.byteLength(existing.text, "utf8") + Buffer.byteLength(serialized.text, "utf8") > USER_FACTS_MAX_BYTES) return capacityFailure("bytes");

      prepare();
      appendFileSync(file, serialized.text, "utf8");

      return { ok: true, appended: records.length };
    } catch (error) {
      // 目录可能在两次写之间被删掉，所以下一次写还要再试一次建目录。
      prepared = false;
      return { ok: false, reason: `fact_write_failed:${codeOf(error) ?? "unknown"}` };
    }
  }

  const store: FileFactStore = {
    read: () => readFacts(file),

    append(records) {
      if (records.length === 0) return { ok: true, appended: 0 };
      const committed = store.transact(() => ({ result: records.length, commit: records }));
      return committed.ok ? { ok: true, appended: committed.value } : committed;
    },

    compact() {
      try { prepare(); }
      catch (error) { return { ok: false, reason: `fact_write_failed:${codeOf(error) ?? "unknown"}` }; }

      const held = acquireFactLock(lock);
      if (!held.ok) return { ok: false, reason: `facts_locked:${lock}` };

      try {
        const current = readFacts(file);
        if (!current.ok) return current;

        if (current.unreadable > 0) return { ok: false, reason: "facts_corrupt" };

        const next = compactMemoryRecords(current.records);
        const serialized = serializeFacts(next);
        if (!serialized.ok) return serialized;

        const committed = replaceFacts(file, serialized.text);

        return committed.ok ? { ok: true, before: current.records.length, after: next.length } : committed;
      } finally { held.release(); }
    },

    transact(step) {
      try {
        prepare();
      } catch (error) {
        return { ok: false, reason: `fact_write_failed:${codeOf(error) ?? "unknown"}` };
      }

      const held = acquireFactLock(lock);
      if (!held.ok) return { ok: false, reason: `facts_locked:${lock}` };

      try {
        const current = readFacts(file);
        if (!current.ok) return { ok: false, reason: current.reason };

        if (current.unreadable > 0) return { ok: false, reason: "facts_corrupt" };

        const next = step(current.records);
        if (next.commit !== undefined && next.commit.length > 0) {
          const written = appendNow(next.commit);
          if (!written.ok) return { ok: false, reason: written.reason };
        }

        return { ok: true, value: next.result };
      } finally {
        held.release();
      }
    },
  };

  return store;
}

function readFacts(file: string): FactReadResult {
  const bounded = readBoundedFacts(file);
  if (!bounded.ok) return bounded;

  const records: UserMemoryRecord[] = [];
  let unreadable = 0;

  for (const line of bounded.text.split("\n")) {
    if (line.trim().length === 0) continue;
    if (records.length + unreadable >= USER_FACTS_MAX_RECORDS) return capacityFailure("records");
    if (Buffer.byteLength(line, "utf8") > USER_FACTS_MAX_LINE_BYTES) return capacityFailure("line_bytes");
    const decoded = decodeFact(line);
    if (decoded === undefined) unreadable += 1;
    else records.push(decoded);
  }

  return { ok: true, records, unreadable };
}

type SerializedFacts = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

function capacityFailure(dimension: "bytes" | "records" | "line_bytes"): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason: `facts_capacity_exceeded:${dimension}` };
}

/** Descriptor stat and a size+1 buffer bound allocations even if another process grows the file. */
function readBoundedFacts(file: string): SerializedFacts {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    if (size > USER_FACTS_MAX_BYTES) return capacityFailure("bytes");

    const bytes = Buffer.alloc(size + 1);
    let used = 0, count = 0;

    do {
      count = readSync(fd, bytes, used, bytes.length - used, null);
      used += count;
    } while (count > 0 && used < bytes.length);

    if (used > size) return { ok: false, reason: "facts_changed_during_read" };

    return { ok: true, text: bytes.subarray(0, used).toString("utf8") };
  } catch (error) {
    const code = codeOf(error);
    return code === "ENOENT" ? { ok: true, text: "" } : { ok: false, reason: code ?? "read_failed" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function serializeFacts(records: ReadonlyArray<UserMemoryRecord>): SerializedFacts {
  if (records.length > USER_FACTS_MAX_RECORDS) return capacityFailure("records");

  const lines: string[] = [];
  let total = 0;

  for (const record of records) {
    if (record.formatVersion !== undefined && record.formatVersion !== 1 && record.formatVersion !== 2) {
      return { ok: false, reason: "facts_invalid_record" };
    }

    // v2 is deliberately incompatible with old writers: ignoring consumed keys
    // could turn a stale retry into a new fact after compaction.
    const line = JSON.stringify({ ...record, formatVersion: 2 });
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > USER_FACTS_MAX_LINE_BYTES) return capacityFailure("line_bytes");

    total += bytes + 1;

    if (total > USER_FACTS_MAX_BYTES) return capacityFailure("bytes");

    if (decodeFact(line) === undefined) return { ok: false, reason: "facts_invalid_record" };

    lines.push(`${line}\n`);
  }

  return { ok: true, text: lines.join("") };
}

/** Single lock owner; temp is never reused. Rename is the only commit point. */
function replaceFacts(file: string, text: string): FactAppendResult {
  const temporary = path.join(path.dirname(file), USER_FACTS_COMPACT_FILE);
  let fd: number | undefined;
  let owned = false;

  try {
    fd = openSync(temporary, "wx");
    owned = true;
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    owned = false;

    return { ok: true, appended: 0 };
  } catch (error) {
    return { ok: false, reason: `facts_compact_failed:${codeOf(error) ?? "unknown"}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owned) {
      try { unlinkSync(temporary); }
      catch { /* Only our temporary file is cleanup-owned; an OS cleanup failure is not a committed transaction. */ }
    }
  }
}

/**
 * 无版本/v1 旧行兼容读；v2 标记消费键语义。未知版本显式拒绝，不按空档。
 *
 * 读边界做运行时守卫而不是盲转：坏行会计 `unreadable` 并让调用方降级，而不是
 * 把一个伪合法对象送进折叠——折叠会立刻让假版本变成"当前有效"。
 */
function decodeFact(line: string): UserMemoryRecord | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const fields = parsed as Record<string, unknown>;
  if (fields["formatVersion"] !== undefined && fields["formatVersion"] !== 1 && fields["formatVersion"] !== 2) return undefined;

  if (fields["record"] === "memory_proposal") return decodeProposal(fields);

  if (fields["record"] !== "user_fact") return undefined;

  if (typeof fields["id"] !== "string" || fields["id"].length === 0) return undefined;

  if (typeof fields["version"] !== "number" || !Number.isInteger(fields["version"]) || fields["version"] < 1) return undefined;

  if (typeof fields["status"] !== "string" || !(MEMORY_FACT_STATUSES as readonly string[]).includes(fields["status"])) return undefined;

  if (typeof fields["factKind"] !== "string" || !(MEMORY_FACT_KINDS as readonly string[]).includes(fields["factKind"])) return undefined;

  if (typeof fields["subject"] !== "string" || typeof fields["statement"] !== "string") return undefined;

  if (typeof fields["commandId"] !== "string" || fields["commandId"].length === 0) return undefined;

  const previous = fields["previousCommandIds"];
  if ((previous !== undefined || fields["commandAliases"] !== undefined) && fields["formatVersion"] !== 2) return undefined;

  if (previous !== undefined && (!Array.isArray(previous)
    || previous.some((key: unknown) => typeof key !== "string" || key.length === 0)
    || new Set(previous).size !== previous.length || previous.includes(fields["commandId"]))) return undefined;

  const aliases = fields["commandAliases"];
  if (aliases !== undefined) {
    if (!Array.isArray(aliases)) return undefined;

    const keys = new Set<string>();

    for (const raw of aliases) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

      const alias = raw as Record<string, unknown>;
      const key = alias["commandId"], digest = alias["requestDigest"];
      if (typeof key !== "string" || key.length === 0 || keys.has(key) || key === fields["commandId"]
        || (Array.isArray(previous) && previous.includes(key))
        || typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) return undefined;

      keys.add(key);
    }
  }

  if (typeof fields["createdAt"] !== "number" || !Number.isFinite(fields["createdAt"])) return undefined;

  if (scopeOf(fields["scope"]) === undefined || sourceOf(fields["source"]) === undefined) return undefined;

  if (fields["supersedes"] !== undefined
    && (typeof fields["supersedes"] !== "number" || !Number.isInteger(fields["supersedes"]))) return undefined;

  return parsed as UserFactRecord;
}

/**
 * 提案行的运行时守卫：与事实共用 id/正文/作用域，但没有版本与撤回状态。
 *
 * 逐字段校验后**显式构造**，不做 `as unknown as` 的整包断言：提案是被写进账本
 * 的对象，靠断言把它变成合法类型，等于让任何一行坏 JSON 都能当记录入库。
 */
function decodeProposal(fields: Record<string, unknown>): UserMemoryRecord | undefined {
  const id = fields["id"], status = fields["status"], factKind = fields["factKind"];
  const subject = fields["subject"], statement = fields["statement"];
  const commandId = fields["commandId"], createdAt = fields["createdAt"];
  const scope = scopeOf(fields["scope"]), source = sourceOf(fields["source"]);

  if (typeof id !== "string" || id.length === 0) return undefined;

  if (!isProposalStatus(status) || !isFactKind(factKind)) return undefined;

  if (typeof subject !== "string" || typeof statement !== "string") return undefined;

  if (typeof commandId !== "string" || commandId.length === 0) return undefined;

  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;

  if (scope === undefined || source === undefined) return undefined;

  return { record: "memory_proposal", id, status, factKind, subject, statement, scope, source, commandId, createdAt };
}

function isProposalStatus(value: unknown): value is MemoryProposalStatus {
  return typeof value === "string" && (MEMORY_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

function isFactKind(value: unknown): value is MemoryFactKind {
  return typeof value === "string" && (MEMORY_FACT_KINDS as readonly string[]).includes(value);
}

function scopeOf(value: unknown): MemoryScope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const scope = value as Record<string, unknown>;
  if (scope["kind"] === "user") {
    return typeof scope["userId"] === "string" && scope["userId"].length > 0
      ? { kind: "user", userId: scope["userId"] }
      : undefined;
  }

  if (scope["kind"] === "project") {
    return typeof scope["workspaceId"] === "string" && scope["workspaceId"].length > 0
      ? { kind: "project", workspaceId: scope["workspaceId"] }
      : undefined;
  }

  return undefined;
}

function sourceOf(value: unknown): MemorySource | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  if (typeof source["eventId"] !== "string" || source["eventId"].length === 0) return undefined;

  if (source["kind"] === "user_statement") return { kind: "user_statement", eventId: source["eventId"] };

  if (source["kind"] === "user_confirmation") {
    return typeof source["confirmsEventId"] === "string" && source["confirmsEventId"].length > 0
      ? { kind: "user_confirmation", eventId: source["eventId"], confirmsEventId: source["confirmsEventId"] }
      : undefined;
  }

  return undefined;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
