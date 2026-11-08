import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { releaseLock, tryAcquireLock, type LockHandle } from "../../adapters/learning-store/lock.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { parseSkillEpisode } from "../../learning/domains/skill/parse-episode.js";
import type { SkillExperience, SkillOpportunity } from "./runtime-contract.js";

export const SKILL_EXPERIENCES_FILE = "skill-experiences.ndjson";
export const SKILL_EXPERIENCES_LOCK = "skill-experiences.lock";
const HARD_LIMITS = { maxBytes: 4 * 1024 * 1024, maxRecords: 4096, maxRecordBytes: 65_536 };
const ARCHIVE_LIMITS = { maxBytes: 64 * 1024 * 1024, maxRecords: 65536, maxSegments: 256 };
const ARCHIVE_NAME = /^skill-experiences\.segment-(\d{6})-([a-f0-9]{64})\.ndjson$/;

type Limits = typeof HARD_LIMITS;

export type SkillExperienceFailure = { readonly ok: false; readonly code: string; readonly message: string };

type Failure = SkillExperienceFailure;

export type SkillExperienceParseResult = { readonly ok: true; readonly value: SkillExperience } | Failure;

type ParsedExperience = SkillExperienceParseResult;

type History = { readonly ok: true; readonly experiences: readonly SkillExperience[]; readonly bytes: number } | Failure;

export type ExperienceAppendResult = { readonly ok: true; readonly status: "appended" | "duplicate" | "disabled" } | Failure;

export type ExperienceReadResult = { readonly ok: true; readonly opportunity: SkillOpportunity } | Failure;

export type SkillExperienceFileOptions = {
  readonly root: string;
  readonly workspaceId: string;
  readonly collection: () => "enabled" | "disabled";
  /** Callers may narrow storage caps; they cannot increase them. */
  readonly limits?: Partial<Limits>;
  /** Explicit opt-in preserves v1 single-file capacity behavior. Archives are never deleted. */
  readonly retention?: "single_file" | "segmented";
};

/**
 * Runtime facts only. Skill versions, eligibility and active pointers remain in
 * the Board. O_EXCL serializes read/validate/append; a crashed writer's lock is
 * never stolen and an incomplete final record is never silently discarded.
 */
export function createSkillExperienceFile(options: SkillExperienceFileOptions) {
  const limits = limitsFor(options.limits);
  const file = path.join(options.root, SKILL_EXPERIENCES_FILE);
  const lock = path.join(options.root, SKILL_EXPERIENCES_LOCK);

  return {
    append(raw: unknown): ExperienceAppendResult {
      if (options.collection() === "disabled") return { ok: true, status: "disabled" };

      if (!nonEmpty(options.workspaceId)) return failure("experience_invalid", "workspace identity is required");

      const parsed = parseSkillExperience(raw, options.workspaceId);
      if (!parsed.ok) return parsed;

      const payload = { schemaVersion: 1, experience: parsed.value };
      const serialized = `${canonicalJson({ ...payload, checksum: sha256Hex(canonicalJson(payload)) })}\n`;
      if (Buffer.byteLength(serialized, "utf8") > limits.maxRecordBytes) return capacity("record_bytes");

      let held: LockHandle;

      try {
        mkdirSync(options.root, { recursive: true });
        const acquired = tryAcquireLock(lock);
        if ("ok" in acquired) return failure("experience_locked", acquired.detail);
        held = acquired;
      } catch (error) { return ioFailure("write", error); }

      let result: ExperienceAppendResult;

      try {
        // Recheck after acquiring the writer lock: a settings change cannot
        // leave an already-queued append writing after collection is disabled.
        result = options.collection() === "disabled" ? { ok: true, status: "disabled" }
          : appendLocked(file, parsed.value, serialized, options.workspaceId, limits, options.retention ?? "single_file");
      } catch (error) { result = ioFailure("write", error); }

      try { releaseLock(held); }
      catch (error) {
        // An append may already be durable. Surface the uncertain cleanup;
        // retrying the same episode is safe because content identity is checked.
        return ioFailure("lock_release", error);
      }

      return result;
    },

    read(opportunityId: string): ExperienceReadResult {
      const collection = options.collection();
      if (collection === "disabled") return { ok: true, opportunity: {
        opportunityId, workspaceId: options.workspaceId, collection, experiences: [],
      } };

      if (!nonEmpty(opportunityId) || !nonEmpty(options.workspaceId)) return failure("experience_invalid", "opportunity and workspace identities are required");

      const history = readAllHistory(file, options.workspaceId, limits, options.retention ?? "single_file");
      if (!history.ok) return history;

      return { ok: true, opportunity: { opportunityId, workspaceId: options.workspaceId, collection, experiences: history.experiences } };
    },
  };
}

function appendLocked(file: string, experience: SkillExperience, serialized: string, workspaceId: string, limits: Limits, retention: "single_file" | "segmented"): ExperienceAppendResult {
  const current = readAllHistory(file, workspaceId, limits, retention);
  if (!current.ok) return current;

  const previous = current.experiences.find(item => item.episode.id === experience.episode.id);
  if (previous !== undefined) return canonicalJson(previous) === canonicalJson(experience)
    ? { ok: true, status: "duplicate" } : failure("experience_conflict", experience.episode.id);

  if (Buffer.byteLength(serialized, "utf8") > limits.maxBytes) return capacity("bytes");

  const segments = archiveFiles(file);
  if (!segments.ok) return segments;

  let writable = retention === "segmented" ? segments.files[segments.files.length - 1]?.path ?? file : file;
  const active = retention === "segmented" ? readHistory(writable, workspaceId, limits) : current;
  if (!active.ok) return active;

  if (retention === "segmented" && (current.experiences.length >= ARCHIVE_LIMITS.maxRecords
    || current.bytes + Buffer.byteLength(serialized, "utf8") > ARCHIVE_LIMITS.maxBytes)) return capacity("archive_total");

  const countOverflow = active.experiences.length >= limits.maxRecords;
  const byteOverflow = active.bytes + Buffer.byteLength(serialized, "utf8") > limits.maxBytes;
  if (countOverflow || byteOverflow) {
    if (retention === "single_file") return capacity(countOverflow ? "records" : "bytes");
    if (segments.files.length >= ARCHIVE_LIMITS.maxSegments) return capacity("archive_segments");
    const raw = readBounded(writable, limits.maxBytes);
    if (!raw.ok) return raw;
    const sequence = String(segments.files.length + 1).padStart(6, "0");
    writable = path.join(path.dirname(file), `skill-experiences.segment-${sequence}-${sha256Hex(raw.text)}.ndjson`);
  }

  // Older segments are never renamed, overwritten or deleted. The next file's
  // name commits the predecessor hash before any fact is appended to it.
  appendFileSync(writable, serialized, "utf8");

  return { ok: true, status: "appended" };
}

function archiveFiles(file: string): { readonly ok: true; readonly files: readonly { path: string; hash: string }[] } | Failure {
  let names: string[];

  try { names = readdirSync(path.dirname(file)); }
  catch (error) { return hasCode(error, "ENOENT") ? { ok: true, files: [] } : ioFailure("archive_list", error); }

  const entries = names.flatMap(name => {
    const match = ARCHIVE_NAME.exec(name);
    return match === null ? [] : [{ name, index: Number(match[1]), hash: match[2]! }];
  }).sort((a, b) => a.index - b.index);

  if (names.some(name => name.startsWith("skill-experiences.segment-") && ARCHIVE_NAME.exec(name) === null)) return failure("experience_corrupt", "malformed archive segment identity");

  if (entries.length > ARCHIVE_LIMITS.maxSegments) return capacity("archive_segments");

  if (entries.some((entry, index) => entry.index !== index + 1)) return failure("experience_corrupt", "archive segment sequence is incomplete");

  return { ok: true, files: entries.map(entry => ({ path: path.join(path.dirname(file), entry.name), hash: entry.hash })) };
}

function readAllHistory(file: string, workspaceId: string, limits: Limits, retention: "single_file" | "segmented"): History {
  const archives = archiveFiles(file);
  if (!archives.ok) return archives;

  if (retention === "single_file") return archives.files.length === 0 ? readHistory(file, workspaceId, limits)
    : failure("experience_retention_mismatch", "segmented history cannot be read as a single legacy file");

  const experiences: SkillExperience[] = [], identities = new Set<string>();
  let bytes = 0;
  let previousHash: string | undefined;

  for (const segment of [{ path: file, hash: undefined }, ...archives.files]) {
    const raw = readBounded(segment.path, limits.maxBytes);
    if (!raw.ok) return raw;

    if (segment.hash !== undefined && previousHash !== segment.hash) return failure("experience_corrupt", "archive predecessor checksum mismatch");

    previousHash = sha256Hex(raw.text);
    const history = readHistory(segment.path, workspaceId, limits);
    if (!history.ok) return history;

    bytes += history.bytes;

    if (bytes > ARCHIVE_LIMITS.maxBytes || experiences.length + history.experiences.length > ARCHIVE_LIMITS.maxRecords) return capacity("archive_total");

    for (const fact of history.experiences) {
      if (identities.has(fact.episode.id)) return failure("experience_corrupt", "duplicate archived episode identity");
      identities.add(fact.episode.id);
      experiences.push(fact);
    }
  }

  return { ok: true, experiences, bytes };
}

function readHistory(file: string, workspaceId: string, limits: Limits): History {
  const raw = readBounded(file, limits.maxBytes);
  if (!raw.ok) return raw;

  if (raw.text.length > 0 && !raw.text.endsWith("\n")) return failure("experience_corrupt", "incomplete final record");

  const lines = raw.text.length === 0 ? [] : raw.text.slice(0, -1).split("\n");
  if (lines.length > limits.maxRecords) return capacity("records");

  const experiences: SkillExperience[] = [], identities = new Set<string>();

  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") + 1 > limits.maxRecordBytes) return capacity("record_bytes");
    const decoded = decodeRecord(line, workspaceId);
    if (!decoded.ok) return decoded;
    if (identities.has(decoded.value.episode.id)) return failure("experience_corrupt", "duplicate persisted episode identity");
    identities.add(decoded.value.episode.id);
    experiences.push(decoded.value);
  }

  return { ok: true, experiences, bytes: raw.bytes };
}

/** Stat the open descriptor, then read at most size+1 bytes to bound allocation and detect growth. */
function readBounded(file: string, maxBytes: number): { readonly ok: true; readonly text: string; readonly bytes: number } | Failure {
  let fd: number | undefined;
  let result: { readonly ok: true; readonly text: string; readonly bytes: number } | Failure;

  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd), size = stat.size;
    if (!stat.isFile()) result = failure("experience_io_failed", "history is not a regular file");
    else if (size > maxBytes) result = capacity("bytes");
    else {
      const bytes = Buffer.alloc(size + 1);
      let used = 0, count: number;
      do {
        count = readSync(fd, bytes, used, bytes.length - used, null);
        used += count;
      }
      while (count > 0 && used < bytes.length);
      result = used !== size ? failure("experience_changed_during_read", "history changed during read")
        : { ok: true, text: bytes.subarray(0, used).toString("utf8"), bytes: used };
    }
  } catch (error) { result = hasCode(error, "ENOENT") ? { ok: true, text: "", bytes: 0 } : ioFailure("read", error); }

  if (fd !== undefined) {
    try { closeSync(fd); }
    catch (error) { return ioFailure("read_close", error); }
  }

  return result;
}

function decodeRecord(line: string, workspaceId: string): ParsedExperience {
  let value: unknown;

  try { value = JSON.parse(line); }
  catch { return failure("experience_corrupt", "invalid JSON record"); }

  if (!record(value) || value.schemaVersion !== 1 || !nonEmpty(value.checksum)
    || !onlyKeys(value, ["schemaVersion", "experience", "checksum"])) return failure("experience_corrupt", "invalid record envelope");

  const parsed = parseSkillExperience(value.experience, workspaceId);
  if (!parsed.ok) return failure("experience_corrupt", parsed.message);

  const hash = sha256Hex(canonicalJson({ schemaVersion: 1, experience: parsed.value }));

  return value.checksum === hash ? parsed : failure("experience_corrupt", "record checksum mismatch");
}

/** Shared runtime boundary: file intake and standalone opportunities use identical eligibility. */
export function parseSkillExperience(raw: unknown, workspaceId: string): SkillExperienceParseResult {
  if (!record(raw) || !onlyKeys(raw, ["workspaceId", "runId", "sourceRef", "episode", "qualification", "usedSkill"])
    || raw.workspaceId !== workspaceId || !nonEmpty(raw.runId) || !nonEmpty(raw.sourceRef)) return failure("experience_invalid", "invalid runtime identity or unexpected fields");

  const episode = parseSkillEpisode(raw.episode);
  if (!episode.ok) return failure("experience_invalid", episode.reason);

  const qualification = raw.qualification;
  if (!record(qualification) || !onlyKeys(qualification, ["kind", "ref"]) || !nonEmpty(qualification.ref)) return failure("experience_invalid", "qualification reference is required");

  const correction = episode.value.correction !== undefined;
  const kind = qualification.kind;
  if (correction ? kind !== "explicit_correction" : episode.value.outcome === "success"
    ? kind !== "external_check" : kind !== "external_check" && kind !== "execution_failure") {
    return failure("experience_unqualified", "success needs an external check; corrections need explicit user evidence; failures need an execution or external check");
  }

  let usedSkill: SkillExperience["usedSkill"];
  if (raw.usedSkill !== undefined) {
    const used = raw.usedSkill;
    if (!record(used) || !onlyKeys(used, ["versionId", "variantId", "contentHash"])
      || !nonEmpty(used.versionId) || !nonEmpty(used.variantId) || !nonEmpty(used.contentHash)) return failure("experience_invalid", "usedSkill needs exact version, variant and hash");
    usedSkill = { versionId: used.versionId, variantId: used.variantId, contentHash: used.contentHash };
  }

  // The qualification union is established above; never persist arbitrary
  // caller fields or original user messages through this facts boundary.
  if (kind !== "external_check" && kind !== "explicit_correction" && kind !== "execution_failure") return failure("experience_invalid", "unknown qualification");

  return { ok: true, value: { workspaceId, runId: raw.runId, sourceRef: raw.sourceRef, episode: episode.value,
    qualification: { kind, ref: qualification.ref }, ...(usedSkill === undefined ? {} : { usedSkill }) } };
}

function limitsFor(input: Partial<Limits> | undefined): Limits {
  const bounded = (value: number | undefined, cap: number) => {
    if (value === undefined) return cap;
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error("experience capacity must be a positive integer within the hard cap");
    return value;
  };
  return { maxBytes: bounded(input?.maxBytes, HARD_LIMITS.maxBytes), maxRecords: bounded(input?.maxRecords, HARD_LIMITS.maxRecords),
    maxRecordBytes: bounded(input?.maxRecordBytes, HARD_LIMITS.maxRecordBytes) };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }

function failure(code: string, message: string): Failure { return { ok: false, code, message }; }

function capacity(dimension: string): Failure { return failure("experience_capacity", dimension); }

function hasCode(error: unknown, code: string): boolean { return record(error) && error.code === code; }

function ioFailure(operation: string, error: unknown): Failure {
  return failure("experience_io_failed", `${operation}:${record(error) && typeof error.code === "string" ? error.code : "unknown"}`);
}
