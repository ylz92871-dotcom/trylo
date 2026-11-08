import { createHash } from "node:crypto";
import type { UserFactStore } from "./facts-file.js";
import {
  activeFacts,
  isFactRecord,
  sameFact,
  type MemoryFactKind,
  type MemoryScope,
  type UserFactRecord,
} from "../../learning/domains/user/memory-fact.js";

/**
 * 旧面板数据的幂等导入（WP-CL / B17）。
 *
 * 这条路径只做一件事：把**有可靠用户来源**的旧记录搬进正式账，并给出
 * `oldId → recordId` 的稳定映射。它不做三件事，且每一件都是故意的：
 *
 *  - **不猜来源。** 只有 `provenance === "user_stated"` 的条目会被导入；assistant
 *    推断出来的、来源不明的、以及仍是候选的条目一律留在旧处，结果里写清原因。
 *    把模型猜的东西升格成"用户明说"，比不导入严重得多。
 *  - **不覆盖。** 每条记录的 `commandId` 是 `legacy:<oldId>`，重试命中同一条，
 *    返回 `already` 而不是再写一份。映射因此天然幂等。
 *  - **不删旧数据。** 导入是单向搬运，旧 snapshot 由面板自己决定何时清理。
 *
 * 输入是**面板导出的窄文档**，不是原始 localStorage：CLI 不应该知道渲染层的
 * snapshot schema，否则两端的类型会互相牵制着改。
 */

export type LegacyProvenance = "user_stated" | "assistant_inferred" | "unknown";

export type LegacyStatus = "active" | "retracted" | "candidate";

export type LegacyFactEntry = {
  readonly legacyId: string;
  readonly subject: string;
  readonly statement: string;
  readonly factKind: MemoryFactKind;
  readonly scope: MemoryScope;
  readonly provenance: LegacyProvenance;
  readonly status: LegacyStatus;
  readonly createdAt: number;
};

export type LegacyDocument = { readonly version: 1; readonly facts: ReadonlyArray<LegacyFactEntry> };

export type LegacyDecision =
  | { readonly legacyId: string; readonly outcome: "imported"; readonly recordId: string; readonly version: number }
  | { readonly legacyId: string; readonly outcome: "already"; readonly recordId: string; readonly version: number }
  | { readonly legacyId: string; readonly outcome: "skipped"; readonly reason: string };

export type LegacyDecode =
  | { readonly ok: true; readonly value: LegacyDocument }
  | { readonly ok: false; readonly reason: string };

const PROVENANCES: ReadonlyArray<string> = ["user_stated", "assistant_inferred", "unknown"];
const STATUSES: ReadonlyArray<string> = ["active", "retracted", "candidate"];
const KINDS: ReadonlyArray<string> = ["identity_fact", "preference", "project_fact"];

export function decodeLegacyDocument(raw: unknown): LegacyDecode {
  return decodeDocument(raw, 0);
}

function decodeDocument(raw: unknown, depth: number): LegacyDecode {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "legacy_document_not_an_object" };
  }

  const document = raw as Record<string, unknown>;

  // A panel backup carries the same document under `cliImport`. Exactly one
  // level of unwrapping: this is a packaging convenience, not a schema, and a
  // nested chain would just be a document pretending to be another document.
  if (document["version"] !== 1 && typeof document["cliImport"] === "object" && document["cliImport"] !== null) {
    return depth >= 1
      ? { ok: false, reason: "legacy_document_nested_too_deep" }
      : decodeDocument(document["cliImport"], depth + 1);
  }

  if (document["version"] !== 1) return { ok: false, reason: "legacy_document_version_unsupported" };

  if (!Array.isArray(document["facts"])) return { ok: false, reason: "legacy_document_facts_missing" };

  const facts: LegacyFactEntry[] = [];

  for (const [index, entry] of document["facts"].entries()) {
    const decoded = decodeEntry(entry);
    if (decoded === undefined) return { ok: false, reason: `legacy_fact_invalid:${index}` };
    facts.push(decoded);
  }

  return { ok: true, value: { version: 1, facts } };
}

function decodeEntry(raw: unknown): LegacyFactEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const entry = raw as Record<string, unknown>;
  const legacyId = entry["legacyId"], subject = entry["subject"], statement = entry["statement"];
  const factKind = entry["factKind"], provenance = entry["provenance"], status = entry["status"];
  const createdAt = entry["createdAt"];

  if (typeof legacyId !== "string" || legacyId.length === 0) return undefined;

  if (typeof subject !== "string" || typeof statement !== "string" || statement.trim().length === 0) return undefined;

  if (typeof factKind !== "string" || !KINDS.includes(factKind)) return undefined;

  if (typeof provenance !== "string" || !PROVENANCES.includes(provenance)) return undefined;

  if (typeof status !== "string" || !STATUSES.includes(status)) return undefined;

  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;

  const scope = decodeScope(entry["scope"]);

  return scope === undefined ? undefined : {
    legacyId, subject, statement: statement.trim(), factKind: factKind as MemoryFactKind,
    scope, provenance: provenance as LegacyProvenance, status: status as LegacyStatus, createdAt,
  };
}

function decodeScope(raw: unknown): MemoryScope | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const scope = raw as Record<string, unknown>;
  if (scope["kind"] === "user" && typeof scope["userId"] === "string" && scope["userId"].length > 0) {
    return { kind: "user", userId: scope["userId"] };
  }

  if (scope["kind"] === "project" && typeof scope["workspaceId"] === "string" && scope["workspaceId"].length > 0) {
    return { kind: "project", workspaceId: scope["workspaceId"] };
  }

  return undefined;
}

/** 稳定映射：同一个 `legacyId` 永远得到同一个 `recordId`。 */
export function legacyRecordId(legacyId: string): string {
  return `fact-${createHash("sha256").update(`legacy:${legacyId}`).digest("hex").slice(0, 12)}`;
}

/**
 * 执行导入。返回逐条结果，调用方据此显示"搬了几条、留了几条、为什么"。
 *
 * 一条被导入的旧记录**不经过 grounding**：grounding 校验的是"这一轮用户说了
 * 什么"，而旧记录没有那一轮。它能被导入的唯一依据是 `provenance`——这正是
 * 为什么 `assistant_inferred` 与 `unknown` 被拒绝，而不是宽松放行。
 */
export function importLegacyFacts(
  store: UserFactStore,
  entries: ReadonlyArray<LegacyFactEntry>,
  now: () => number,
): ReadonlyArray<LegacyDecision> {
  const decisions: LegacyDecision[] = [];

  for (const entry of entries) {
    if (entry.provenance !== "user_stated") {
      decisions.push({ legacyId: entry.legacyId, outcome: "skipped", reason: `provenance_${entry.provenance}` });
      continue;
    }

    if (entry.status !== "active") {
      decisions.push({ legacyId: entry.legacyId, outcome: "skipped", reason: `status_${entry.status}` });
      continue;
    }

    const commandId = `legacy:${entry.legacyId}`;
    const recordId = legacyRecordId(entry.legacyId);
    const outcome = store.transact<{ readonly kind: "already" | "imported"; readonly recordId: string; readonly version: number }>((records) => {
      const replay = records.find((record): record is UserFactRecord => isFactRecord(record)
        && (record.commandId === commandId || record.previousCommandIds?.includes(commandId) === true));
      if (replay !== undefined) {
        return { result: { kind: "already" as const, recordId: replay.id, version: replay.version } };
      }

      // 同义事实已经存在（用户此前在对话里存过一次）→ 只建立映射，不再写。
      const existing = activeFacts(records).find((record) => sameFact(entry, record));
      if (existing !== undefined) {
        // Consume the migration key even when no new fact is needed. Otherwise
        // this old panel row could be imported again after the fact is retracted.
        return { result: { kind: "already" as const, recordId: existing.id, version: existing.version },
          commit: [{ ...existing, previousCommandIds: [...(existing.previousCommandIds ?? []), commandId] }] };
      }

      const record: UserFactRecord = {
        record: "user_fact", id: recordId, version: 1, status: "active",
        factKind: entry.factKind, subject: entry.subject, statement: entry.statement,
        scope: entry.scope,
        source: { kind: "user_statement", eventId: `legacy:${entry.legacyId}` },
        commandId, createdAt: entry.createdAt > 0 ? entry.createdAt : now(),
      };

      return {
        result: { kind: "imported" as const, recordId: record.id, version: record.version },
        commit: [record],
      };
    });
    if (!outcome.ok) {
      decisions.push({ legacyId: entry.legacyId, outcome: "skipped", reason: outcome.reason });
      continue;
    }

    decisions.push({
      legacyId: entry.legacyId,
      outcome: outcome.value.kind,
      recordId: outcome.value.recordId,
      version: outcome.value.version,
    });
  }

  return decisions;
}
