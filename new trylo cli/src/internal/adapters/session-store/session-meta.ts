import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isRuntimeFingerprint, type RuntimeFingerprint } from "../../ports/session.js";

/**
 * Session sidecar (`<id>.meta.json` next to `<id>.ndjson`).
 *
 * Carries everything about a session that is *not* the durable journal:
 * display names (rename), archive flags, fork provenance and migration
 * facts. Owned by the Session management service, written only through this
 * module, and never read by the journal recovery path — so a corrupt sidecar
 * fails its own readers without ever endangering the journal.
 *
 * Pure core (guard, serialize, normalize) stays testable without the disk;
 * the thin `node:fs` wrappers at the bottom are the only place that touches
 * files, mirroring `journal-io.ts`.
 */

export const SESSION_META_VERSION = 1;

export const META_FILE_SUFFIX = ".meta.json";

/** The journal filename suffix, owned here so the sidecar can derive its own path from a journal path. */
export const SESSION_JOURNAL_SUFFIX = ".ndjson";

export type ForkSnapshotKind = "settled-prefix" | "interrupted" | "before-user-message";

export type ForkProvenance = {
  readonly parentSessionId: string;
  readonly parentLastSequence: number;
  readonly snapshot: ForkSnapshotKind;
  readonly at: string;
  readonly droppedPending: number;
  readonly droppedPartials: number;
  readonly copiedRecords: number;
  readonly beforeUserMessage?: number;
};

export type MigrationScope = "provider" | "model" | "catalog";

export type MigrationRecord = {
  readonly at: string;
  readonly from: RuntimeFingerprint;
  readonly to: RuntimeFingerprint;
  readonly scope: ReadonlyArray<MigrationScope>;
};

export type SessionMeta = {
  readonly version: typeof SESSION_META_VERSION;
  readonly displayName?: string;
  readonly archived?: boolean;
  readonly forkedFrom?: ForkProvenance;
  readonly migrations?: ReadonlyArray<MigrationRecord>;
};

export function defaultSessionMeta(): SessionMeta {
  return { version: SESSION_META_VERSION };
}

export type MetaLoadOutcome =
  | { readonly ok: true; readonly meta: SessionMeta; readonly present: boolean }
  | { readonly ok: false; readonly code: "meta_corrupt"; readonly detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isForkProvenance(value: unknown): value is ForkProvenance {
  if (!isRecord(value)) {
    return false;
  }

  const snapshot = value.snapshot;
  if (snapshot !== "settled-prefix" && snapshot !== "interrupted" && snapshot !== "before-user-message") {
    return false;
  }

  if (typeof value.parentSessionId !== "string" || value.parentSessionId.length === 0) {
    return false;
  }

  if (typeof value.at !== "string" || value.at.length === 0) {
    return false;
  }

  if (!isNonNegativeInt(value.parentLastSequence) || !isNonNegativeInt(value.droppedPending) ||
    !isNonNegativeInt(value.droppedPartials) || !isNonNegativeInt(value.copiedRecords)) {
    return false;
  }

  if (value.beforeUserMessage !== undefined &&
    (typeof value.beforeUserMessage !== "number" || !Number.isInteger(value.beforeUserMessage) || value.beforeUserMessage < 1)) {
    return false;
  }

  return true;
}

function isMigrationRecord(value: unknown): value is MigrationRecord {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.at !== "string" || value.at.length === 0) {
    return false;
  }

  if (!isRuntimeFingerprint(value.from) || !isRuntimeFingerprint(value.to)) {
    return false;
  }

  if (!Array.isArray(value.scope) || value.scope.length === 0) {
    return false;
  }

  return value.scope.every(entry => entry === "provider" || entry === "model" || entry === "catalog");
}

/**
 * Parses one sidecar file's text. `undefined` means the file is absent, which
 * is the normal state of every session written before sidecars existed — it
 * reads as defaults, never as an error.
 */
export function parseSessionMeta(raw: string | undefined): MetaLoadOutcome {
  if (raw === undefined) {
    return { ok: true, meta: defaultSessionMeta(), present: false };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, code: "meta_corrupt", detail: "sidecar is not JSON" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, code: "meta_corrupt", detail: "sidecar is not an object" };
  }

  if (parsed.version !== SESSION_META_VERSION) {
    return { ok: false, code: "meta_corrupt", detail: `unsupported sidecar version: ${String(parsed.version)}` };
  }

  if (parsed.displayName !== undefined &&
    (typeof parsed.displayName !== "string" || parsed.displayName.length === 0 || parsed.displayName.length > 100)) {
    return { ok: false, code: "meta_corrupt", detail: "displayName must be 1-100 characters" };
  }

  if (parsed.archived !== undefined && typeof parsed.archived !== "boolean") {
    return { ok: false, code: "meta_corrupt", detail: "archived must be a boolean" };
  }

  if (parsed.forkedFrom !== undefined && !isForkProvenance(parsed.forkedFrom)) {
    return { ok: false, code: "meta_corrupt", detail: "forkedFrom is not a fork provenance record" };
  }

  if (parsed.migrations !== undefined &&
    (!Array.isArray(parsed.migrations) || !parsed.migrations.every(isMigrationRecord))) {
    return { ok: false, code: "meta_corrupt", detail: "migrations is not a migration log" };
  }

  const meta: SessionMeta = { version: SESSION_META_VERSION };
  const withName: SessionMeta = parsed.displayName === undefined
    ? meta
    : { ...meta, displayName: parsed.displayName as string };
  const withArchived: SessionMeta = parsed.archived === undefined
    ? withName
    : { ...withName, archived: parsed.archived as boolean };
  const withFork: SessionMeta = parsed.forkedFrom === undefined
    ? withArchived
    : { ...withArchived, forkedFrom: parsed.forkedFrom as ForkProvenance };

  if (parsed.migrations === undefined) {
    return { ok: true, meta: withFork, present: true };
  }

  return { ok: true, meta: { ...withFork, migrations: parsed.migrations as ReadonlyArray<MigrationRecord> }, present: true };
}

export function serializeSessionMeta(meta: SessionMeta): string {
  return `${JSON.stringify(meta)}\n`;
}

/**
 * User-visible session names: one line, at most 100 characters, mirroring the
 * old CLI's first-prompt truncation. Empty input names nothing.
 */
export function normalizeDisplayName(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, " ").trim().slice(0, 100);
  return collapsed.length === 0 ? undefined : collapsed;
}

export function sessionMetaPath(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}${META_FILE_SUFFIX}`;
}

export function loadSessionMeta(sessionsDir: string, sessionId: string): MetaLoadOutcome {
  let raw: string | undefined;

  try {
    raw = readFileSync(sessionMetaPath(sessionsDir, sessionId), "utf8");
  } catch {
    return { ok: true, meta: defaultSessionMeta(), present: false };
  }

  return parseSessionMeta(raw);
}

/** Writes the sidecar atomically enough for its purpose: one small file, one writer (this service). */
export function saveSessionMeta(sessionsDir: string, sessionId: string, meta: SessionMeta): boolean {
  try {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sessionMetaPath(sessionsDir, sessionId), serializeSessionMeta(meta), "utf8");
    return true;
  } catch {
    return false;
  }
}

export type SessionDeleteOutcome =
  | { readonly ok: true; readonly removedJournal: boolean; readonly removedMeta: boolean }
  | { readonly ok: false; readonly code: "missing_session" | "lock_conflict" | "remove_failed"; readonly detail: string };

/**
 * Hard-deletes one session: journal, sidecar, nothing else.
 *
 * A held lock refuses the delete — removing a journal under a live writer
 * would orphan its lock and its facts. A corrupt journal or sidecar does not
 * refuse: an explicit delete names exactly what goes away.
 */
export function deleteSessionFiles(journalPath: string): SessionDeleteOutcome {
  if (existsSync(`${journalPath}.lock`)) {
    return { ok: false, code: "lock_conflict", detail: "a live writer holds this session; retry once it exits" };
  }

  if (!existsSync(journalPath)) {
    return { ok: false, code: "missing_session", detail: journalPath };
  }

  const metaPath = journalPath.endsWith(SESSION_JOURNAL_SUFFIX)
    ? `${journalPath.slice(0, -SESSION_JOURNAL_SUFFIX.length)}${META_FILE_SUFFIX}`
    : `${journalPath}${META_FILE_SUFFIX}`;

  try {
    unlinkSync(journalPath);
  } catch {
    return { ok: false, code: "remove_failed", detail: `cannot remove ${journalPath}` };
  }

  let removedMeta = false;

  if (existsSync(metaPath)) {
    try {
      unlinkSync(metaPath);
      removedMeta = true;
    } catch {
      return { ok: false, code: "remove_failed", detail: `journal removed but cannot remove ${metaPath}` };
    }
  }

  return { ok: true, removedJournal: true, removedMeta };
}
