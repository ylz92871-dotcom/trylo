// Trylo Desktop — P2-1 result normalizer (spec §6.6 / §4.6).
//
// Strict whitelist normalisation of persisted `ConversationRecord.results`.
// Unknown / malformed fields are dropped, never passed through to disk.
// Bounds are fixed constants; over-limits keep the most-recently-updated
// entries and preserve the real totals plus `truncated: true`.

import type {
  CodeAttribution,
  CodeCheckKind,
  CodeCheckStatus,
  CodeFileChangeKind,
  OfficeCheckId,
  OfficeCheckStatus,
  OfficeVerificationStatus,
  ResultRunStatus,
  StoredCodeChange,
  StoredCodeCheck,
  StoredCodeRunResult,
  StoredConversationResults,
  StoredFileSignature,
  StoredRunMeta,
  StoredWorkArtifact,
  StoredWorkArtifactCheck,
  StoredWorkArtifactKind,
  StoredWorkArtifactVerification,
  StoredWorkResult,
  StoredWorkRunDelta,
  WorkArtifactChange,
  WorkArtifactSource,
} from './conversation-result-types';

// §6.6 fixed upper bounds (UTF-16 code units / item counts).
export const BOUNDS = {
  codeChanges: 500,
  codeChecks: 50,
  workArtifacts: 200,
  pathLen: 1024,
  labelLen: 240,
  runDeltaIds: 200,
  // PR-5 (§11): the verification verdict is bounded too — a check list is at
  // most five entries and no free-text field may grow without limit.
  verificationChecks: 8,
  verificationDetail: 240,
  verificationCapabilities: 8,
} as const;

const CODE_CHANGE_KINDS: readonly CodeFileChangeKind[] = [
  'added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'unmerged', 'unknown',
];
const CODE_CHECK_KINDS: readonly CodeCheckKind[] = ['test', 'typecheck', 'lint', 'build', 'format'];
const CODE_CHECK_STATUSES: readonly CodeCheckStatus[] = ['passed', 'failed', 'cancelled'];
const RESULT_STATUSES: readonly ResultRunStatus[] = ['collecting', 'completed', 'failed', 'cancelled', 'degraded'];
const CODE_ATTRIBUTIONS: readonly CodeAttribution[] = ['run_delta', 'workspace_only', 'unavailable'];
const ARTIFACT_KINDS: readonly StoredWorkArtifactKind[] = ['document', 'presentation', 'spreadsheet', 'web', 'file'];
const ARTIFACT_CHANGES: readonly WorkArtifactChange[] = ['created', 'updated', 'discovered', 'unchanged'];
const ARTIFACT_SOURCES: readonly WorkArtifactSource[] = ['event', 'scan', 'recovery'];
// PR-5 (§11): the verification vocabulary is a CLOSED set — an unknown id /
// status / reason is dropped, never passed through to disk (§4.6 / §6.6).
const VERIFICATION_STATUSES: readonly OfficeVerificationStatus[] = ['verified', 'partial', 'failed', 'skipped'];
const CHECK_IDS: readonly OfficeCheckId[] = [
  'file-present', 'container-match', 'structure', 'officecli-validate', 'libreoffice-roundtrip',
];
const CHECK_STATUSES: readonly OfficeCheckStatus[] = ['passed', 'failed', 'skipped'];
/** Reason codes are a closed, machine-shaped set (no prose, no paths). */
const REASON_CODE = /^[a-z0-9_]{1,40}$/;

function isOneOf<T extends string>(value: unknown, set: readonly T[]): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

function reasonCode(value: unknown): string | undefined {
  return typeof value === 'string' && REASON_CODE.test(value) ? value : undefined;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** WP-4: a non-negative integer (line counts are never negative). */
function nonnegInt(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
}

function bool(value: unknown): boolean {
  return value === true;
}

function idStr(value: unknown, max: number = BOUNDS.pathLen): string | null {
  return clip(value, max);
}

function normalizeRunMeta(value: unknown): StoredRunMeta | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const runId = idStr(raw.runId, 200);
  const turnId = idStr(raw.turnId, 200) ?? '';
  if (!runId) return null;
  const status = isOneOf(raw.status, RESULT_STATUSES) ? raw.status : 'degraded';
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)
    ? Math.floor(raw.startedAt)
    : 0;
  const finishedAt = typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt)
    ? Math.floor(raw.finishedAt)
    : undefined;
  const warning = clip(raw.warning, BOUNDS.labelLen);
  return {
    runId,
    turnId,
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    status,
    ...(warning ? { warning } : {}),
  };
}

function normalizeCodeChange(value: unknown): StoredCodeChange | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const path = idStr(raw.path, BOUNDS.pathLen);
  if (!path) return null;
  const oldPath = idStr(raw.oldPath, BOUNDS.pathLen) ?? undefined;
  const kind = isOneOf(raw.kind, CODE_CHANGE_KINDS) ? raw.kind : 'unknown';
  const additions = nonnegInt(raw.additions);
  const deletions = nonnegInt(raw.deletions);
  return {
    path,
    ...(oldPath ? { oldPath } : {}),
    kind,
    staged: bool(raw.staged),
    unstaged: bool(raw.unstaged),
    untracked: bool(raw.untracked),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(bool(raw.binary) ? { binary: true } : {}),
  };
}

function normalizeCodeCheck(value: unknown): StoredCodeCheck | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = idStr(raw.id, 240);
  const label = clip(raw.label, BOUNDS.labelLen);
  if (!id || !label) return null;
  const kind = isOneOf(raw.kind, CODE_CHECK_KINDS) ? raw.kind : 'test';
  const status = isOneOf(raw.status, CODE_CHECK_STATUSES) ? raw.status : 'failed';
  const durationMs = num(raw.durationMs);
  return {
    id,
    label,
    kind,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function normalizeCodeRunResult(value: unknown): StoredCodeRunResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const meta = normalizeRunMeta(raw.meta);
  if (!meta) return null;
  const changes = (Array.isArray(raw.changes) ? raw.changes : [])
    .map(normalizeCodeChange)
    .filter((entry): entry is StoredCodeChange => entry !== null);
  const checks = (Array.isArray(raw.checks) ? raw.checks : [])
    .map(normalizeCodeCheck)
    .filter((entry): entry is StoredCodeCheck => entry !== null);
  const changeCountTotal = typeof raw.changeCountTotal === 'number' && Number.isFinite(raw.changeCountTotal)
    ? Math.max(changes.length, Math.floor(raw.changeCountTotal))
    : changes.length;
  const checkCountTotal = typeof raw.checkCountTotal === 'number' && Number.isFinite(raw.checkCountTotal)
    ? Math.max(checks.length, Math.floor(raw.checkCountTotal))
    : checks.length;
  const keptChanges = changes.slice(0, BOUNDS.codeChanges);
  const keptChecks = checks.slice(0, BOUNDS.codeChecks);
  const truncated = bool(raw.truncated)
    || keptChanges.length < changeCountTotal
    || keptChecks.length < checkCountTotal;
  const attribution = isOneOf(raw.attribution, CODE_ATTRIBUTIONS) ? raw.attribution : 'unavailable';
  const additionsTotal = nonnegInt(raw.additionsTotal);
  const deletionsTotal = nonnegInt(raw.deletionsTotal);
  return {
    meta,
    attribution,
    changes: keptChanges,
    checks: keptChecks,
    changeCountTotal,
    checkCountTotal,
    truncated,
    ...(additionsTotal !== undefined ? { additionsTotal } : {}),
    ...(deletionsTotal !== undefined ? { deletionsTotal } : {}),
    ...(bool(raw.statsComplete) ? { statsComplete: true } : {}),
  };
}

function normalizeSignature(value: unknown): StoredFileSignature | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const size = num(raw.size);
  const modifiedMs = num(raw.modifiedMs);
  if (size === undefined || modifiedMs === undefined) return null;
  const contentHash = typeof raw.contentHash === 'string' && raw.contentHash
    ? raw.contentHash.slice(0, 128)
    : undefined;
  return {
    size: Math.floor(size),
    modifiedMs: Math.floor(modifiedMs),
    ...(contentHash ? { contentHash } : {}),
  };
}

function normalizeVerificationCheck(value: unknown): StoredWorkArtifactCheck | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isOneOf(raw.id, CHECK_IDS)) return null;
  if (!isOneOf(raw.status, CHECK_STATUSES)) return null;
  return {
    id: raw.id,
    status: raw.status,
    ...(reasonCode(raw.reasonCode) ? { reasonCode: reasonCode(raw.reasonCode)! } : {}),
    ...(typeof raw.detail === 'string' ? { detail: clip(raw.detail, BOUNDS.verificationDetail) ?? '' } : {}),
  };
}

/**
 * PR-5 (§11): whitelist rebuild of ONE artifact's verification verdict. The
 * vocabulary is closed and every field is bounded — a tampered or
 * hand-edited history file cannot smuggle prose, paths or an invented
 * status into the session record (§4.6 / §6.6).
 */
export function normalizeVerification(value: unknown): StoredWorkArtifactVerification | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isOneOf(raw.status, VERIFICATION_STATUSES)) return null;
  const checks = (Array.isArray(raw.checks) ? raw.checks : [])
    .map(normalizeVerificationCheck)
    .filter((entry): entry is StoredWorkArtifactCheck => entry !== null)
    .slice(0, BOUNDS.verificationChecks);
  const checkedAt = num(raw.checkedAt);
  const skipped = (Array.isArray(raw.skippedCapabilities) ? raw.skippedCapabilities : [])
    .map((entry) => (typeof entry === 'string' ? clip(entry, 80) : null))
    .filter((entry): entry is string => !!entry)
    .slice(0, BOUNDS.verificationCapabilities);
  return {
    status: raw.status,
    checkedAt: checkedAt !== undefined ? Math.floor(checkedAt) : 0,
    checks,
    ...(skipped.length > 0 ? { skippedCapabilities: skipped } : {}),
    ...(reasonCode(raw.reasonCode) ? { reasonCode: reasonCode(raw.reasonCode)! } : {}),
  };
}

function normalizeWorkArtifact(value: unknown): StoredWorkArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const targetRaw = raw.target && typeof raw.target === 'object'
    ? (raw.target as Record<string, unknown>)
    : null;
  let id: string | null = idStr(raw.id, 300);
  if (!targetRaw) return null;
  const kind = targetRaw.kind;
  if (kind === 'file') {
    const relativePath = idStr(targetRaw.relativePath, BOUNDS.pathLen);
    if (!relativePath) return null;
    if (!id) id = relativePath;
  } else if (kind === 'url') {
    const url = typeof targetRaw.url === 'string' ? targetRaw.url : null;
    if (!url) return null;
    if (!id) id = url;
  } else {
    return null;
  }
  const displayName = clip(raw.displayName, 240) ?? 'Artifact';
  const artifactKind = isOneOf(raw.artifactKind, ARTIFACT_KINDS) ? raw.artifactKind : 'file';
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version)
    ? Math.max(1, Math.floor(raw.version))
    : 1;
  const firstSeenAt = num(raw.firstSeenAt) ?? 0;
  const updatedAt = num(raw.updatedAt) ?? firstSeenAt;
  const firstRunId = idStr(raw.firstRunId, 200) ?? '';
  const lastRunId = idStr(raw.lastRunId, 200) ?? firstRunId;
  const lastTurnId = idStr(raw.lastTurnId, 200) ?? '';
  const lastChange = isOneOf(raw.lastChange, ARTIFACT_CHANGES) ? raw.lastChange : 'discovered';
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .map((source) => (isOneOf(source, ARTIFACT_SOURCES) ? source : null))
    .filter((source): source is WorkArtifactSource => source !== null);
  const signature = normalizeSignature(raw.signature) ?? undefined;
  const verification = normalizeVerification(raw.verification) ?? undefined;
  return {
    id,
    target: kind === 'file'
      ? { kind: 'file', relativePath: targetRaw.relativePath as string }
      : { kind: 'url', url: targetRaw.url as string },
    displayName,
    artifactKind,
    version,
    firstSeenAt,
    updatedAt,
    firstRunId,
    lastRunId,
    lastTurnId,
    lastChange,
    // Fixed source order: event, scan, recovery (spec §8.5).
    sources: (['event', 'scan', 'recovery'] as const).filter((source) => sources.includes(source)),
    ...(signature ? { signature } : {}),
    ...(verification ? { verification } : {}),
  };
}

function normalizeRunDelta(value: unknown): StoredWorkRunDelta | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const runId = idStr(raw.runId, 200);
  if (!runId) return null;
  const turnId = idStr(raw.turnId, 200) ?? '';
  const status = isOneOf(raw.status, RESULT_STATUSES) ? raw.status : 'degraded';
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)
    ? Math.floor(raw.startedAt)
    : 0;
  const finishedAt = typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt)
    ? Math.floor(raw.finishedAt)
    : undefined;
  const warning = clip(raw.warning, BOUNDS.labelLen);
  const clean = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [])
      .map((entry) => idStr(entry, 300))
      .filter((entry): entry is string => !!entry)
      .slice(0, BOUNDS.runDeltaIds);
  return {
    runId,
    turnId,
    startedAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    status,
    ...(warning ? { warning } : {}),
    createdIds: clean(raw.createdIds),
    updatedIds: clean(raw.updatedIds),
    discoveredIds: clean(raw.discoveredIds),
  };
}

function normalizeCodeResults(value: unknown): { readonly latestRun?: StoredCodeRunResult } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const latestRun = normalizeCodeRunResult((value as Record<string, unknown>).latestRun);
  if (!latestRun) return undefined;
  return { latestRun };
}

export function normalizeStoredWorkResult(value: unknown): StoredWorkResult {
  if (!value || typeof value !== 'object') return EMPTY_WORK_RESULT;
  const raw = value as Record<string, unknown>;
  const latestRun = normalizeRunDelta(raw.latestRun) ?? undefined;
  const artifacts = (Array.isArray(raw.artifacts) ? raw.artifacts : [])
    .map(normalizeWorkArtifact)
    .filter((artifact): artifact is StoredWorkArtifact => artifact !== null)
    .slice(0, BOUNDS.workArtifacts);
  const artifactCountTotal = typeof raw.artifactCountTotal === 'number' && Number.isFinite(raw.artifactCountTotal)
    ? Math.max(artifacts.length, Math.floor(raw.artifactCountTotal))
    : artifacts.length;
  const truncated = bool(raw.truncated) || artifacts.length < artifactCountTotal;
  return {
    ...(latestRun ? { latestRun } : {}),
    artifacts,
    artifactCountTotal,
    truncated,
  };
}

export const EMPTY_WORK_RESULT: StoredWorkResult = {
  artifacts: [],
  artifactCountTotal: 0,
  truncated: false,
};

export function normalizeConversationResults(value: unknown): StoredConversationResults | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return undefined;
  const code = normalizeCodeResults(raw.code);
  const work = normalizeStoredWorkResult(raw.work);
  const hasWork = work.artifacts.length > 0 || work.artifactCountTotal > 0 || work.latestRun !== undefined;
  if (!code && !hasWork) return undefined;
  return {
    schemaVersion: 1,
    ...(code ? { code } : {}),
    ...(hasWork ? { work } : {}),
  };
}