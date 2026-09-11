// Trylo Desktop — Learning port (renderer side).
//
// The seam between the Desktop app and Hermes (architecture doc §4.3):
// every Hermes call the UI can make goes through this interface, so the
// shell can be tested with a fake and the Service Host stays replaceable.
//
// Ownership: Desktop is the state authority for conversations and decides
// WHAT the user approved; Hermes owns memory/skills and decides HOW a
// staged write is committed. Nothing here re-implements Hermes policy.
//
// Failure policy (spec §7.3 / §7.5):
//   - read-only queries degrade — they resolve `{ ok:false, error }` and
//     never throw for "Hermes missing";
//   - staged writes are fail-closed — `applyPending` requires both the
//     pending id and the reviewed expectedHash;
//   - only a transport failure (host gone) rejects.

import type {
  HermesMcpProfile,
  LearningCopyTemplateParams,
  LearningCopyTemplateResult,
  LearningExplicitParams,
  LearningHealthResult,
  LearningGraphSummaryResult,
  LearningHistoryMineParams,
  LearningHistoryMineResult,
  LearningHistorySearchParams,
  LearningHistorySearchResult,
  LearningJobsParams,
  LearningJobsResult,
  LearningQualityScanParams,
  LearningQualityScanResult,
  LearningReviewParams,
  LearningReviewResult,
  LearningRunStatusParams,
  LearningRunStatusResult,
  LearningMemorySnapshotResult,
  LearningMcpArgsResult,
  LearningPendingApplyParams,
  LearningPendingBackupsResult,
  LearningPendingDetailParams,
  LearningPendingDetailResult,
  LearningPendingDiscardParams,
  LearningPendingListResult,
  LearningPendingMutationResult,
  LearningPendingRollbackParams,
  LearningSessionProjection,
  LearningSessionRebuildResult,
  LearningSessionSyncResult,
  LearningSkillsParams,
  LearningSkillsResult,
  LegacyImportCommitParams,
  LegacyImportCommitResult,
  LegacyImportPlanResult,
} from '../services-host/methods';

export type { LearningSessionProjection };

export interface LearningPort {
  // ── 3A read-only ─────────────────────────────────────────────────
  /** Can a Hermes-backed run start right now? Never throws. */
  health(): Promise<LearningHealthResult>;
  /** CLI args for one MCP profile. `ok:false` → run without Hermes. */
  mcpArgs(profile: HermesMcpProfile): Promise<LearningMcpArgsResult>;
  /** Memory snapshot for the Learning UI (opaque payload). */
  memorySnapshot(): Promise<LearningMemorySnapshotResult>;
  /** Read-only Skills list / view. */
  skills(params: LearningSkillsParams): Promise<LearningSkillsResult>;

  // ── session mirror (spec §7.4) ───────────────────────────────────
  /** Mirror one committed conversation. False = nothing needed mirroring. */
  syncSession(session: LearningSessionProjection): Promise<LearningSessionSyncResult>;
  /** Rebuild the whole recall index (migration / repair path). */
  rebuildSessions(sessions: readonly LearningSessionProjection[]): Promise<LearningSessionRebuildResult>;
  /** Bounded flush on exit. */
  flushSessions(): Promise<unknown>;

  // ── 3B staged write ──────────────────────────────────────────────
  listPending(): Promise<LearningPendingListResult>;
  pendingDetail(params: LearningPendingDetailParams): Promise<LearningPendingDetailResult>;
  /** Fail-closed: rejects locally when `expectedHash` is missing. */
  applyPending(params: LearningPendingApplyParams): Promise<LearningPendingMutationResult>;
  discardPending(params: LearningPendingDiscardParams): Promise<LearningPendingMutationResult>;
  listPendingBackups(): Promise<LearningPendingBackupsResult>;
  rollbackPending(params: LearningPendingRollbackParams): Promise<LearningPendingMutationResult>;
  /** PR-6: apply-time privileged copy of a deliverable into the Skill tree.
   *  Reads the review-time copyPlan (source/mtime/size) — never re-scans
   *  `.trylo/out` as the source of truth. */
  copyTemplateUnderOut(params: LearningCopyTemplateParams): Promise<LearningCopyTemplateResult>;

  // ── 3C learning loop (spec §7.6) ─────────────────────────────────
  /** Implicit review after a stable task turn. Produces STAGED proposals. */
  reviewImplicit(params: LearningReviewParams): Promise<LearningReviewResult>;
  /** Explicit /learn. */
  learnExplicit(params: LearningExplicitParams): Promise<LearningReviewResult>;
  /** Single-flight visibility for the Learning UI. */
  runStatus(params?: LearningRunStatusParams): Promise<LearningRunStatusResult>;
  /** History mining search (validated DTOs only). */
  searchHistory(params: LearningHistorySearchParams): Promise<LearningHistorySearchResult>;

  // ── upstream journey / L4 / L5 / L6 ─────────────────────────────
  /** Safe learning graph projection; Memory bodies never enter the renderer. */
  graphSummary(): Promise<LearningGraphSummaryResult>;
  /** Deterministic quality signals and merge candidates; never applies writes. */
  scanQuality(params?: LearningQualityScanParams): Promise<LearningQualityScanResult>;
  /** Mine validated session history through the isolated history profile. */
  mineHistory(params: LearningHistoryMineParams): Promise<LearningHistoryMineResult>;
  /** Inspect and operate the persisted Desktop maintenance scheduler. */
  manageJobs(params?: LearningJobsParams): Promise<LearningJobsResult>;

  // ── legacy data import (spec §7.5) ────────────────────────────────
  /** Read-only discovery of importable legacy Hermes data. */
  planLegacyImport(): Promise<LegacyImportPlanResult>;
  /** Non-destructive copy + mark. Re-runnable, never deletes the source. */
  commitLegacyImport(params: LegacyImportCommitParams): Promise<LegacyImportCommitResult>;
}

/** No-op port used before the Service Host is up and in tests. Hermes is
 *  non-essential: every answer is an explicit degrade, never a thrown error
 *  and never a silent success (spec §7.3). */
export function createNullLearningPort(): LearningPort {
  const unavailable = (what: string) => ({ ok: false, error: `learning port unavailable (${what})` });
  return {
    health: async () => ({ ok: false, available: false, reason: 'learning port unavailable' }),
    mcpArgs: async (profile) => ({ ok: false, profile, arg: [], warning: 'learning port unavailable' }),
    memorySnapshot: async () => unavailable('memorySnapshot'),
    skills: async (params) => ({ ok: false, error: 'learning port unavailable', op: params.op ?? 'list' }),
    syncSession: async () => ({ ok: false, mirrored: false, error: 'learning port unavailable' }),
    rebuildSessions: async () => ({ ok: false, error: 'learning port unavailable' }),
    flushSessions: async () => ({ ok: false, error: 'learning port unavailable' }),
    listPending: async () => ({ ok: false, pending: [], count: 0, error: 'learning port unavailable' }),
    pendingDetail: async () => ({ ok: false, error: 'learning port unavailable' }),
    applyPending: async () => ({ ok: false, error: 'learning port unavailable' }),
    discardPending: async () => ({ ok: false, error: 'learning port unavailable' }),
    copyTemplateUnderOut: async () => ({ ok: false, error: 'learning port unavailable' }),
    listPendingBackups: async () => ({ ok: false, backups: [], error: 'learning port unavailable' }),
    rollbackPending: async () => ({ ok: false, error: 'learning port unavailable' }),
    reviewImplicit: async () => ({ ok: false, status: 'skipped', reason: 'learning port unavailable' }),
    learnExplicit: async () => ({ ok: false, status: 'skipped', reason: 'learning port unavailable' }),
    runStatus: async () => ({ ok: false, active: false, run: null }),
    searchHistory: async () => ({ ok: false, error: 'learning port unavailable' }),
    graphSummary: async () => unavailable('graphSummary'),
    scanQuality: async () => ({ ok: false, signals: 0, candidates: [], error: 'learning port unavailable' }),
    mineHistory: async () => ({ ok: false, status: 'skipped', candidates: [], errors: [{ code: 'UNAVAILABLE', message: 'learning port unavailable' }] }),
    manageJobs: async () => unavailable('jobs'),
    planLegacyImport: async () => ({
      ok: false,
      error: 'learning port unavailable',
      candidates: [],
      target: { hermesHome: '', files: 0, bytes: 0 },
      alreadyImported: null,
    }),
    commitLegacyImport: async () => ({ ok: false, error: 'learning port unavailable' }),
  };
}
