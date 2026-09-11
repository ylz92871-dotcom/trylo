// Trylo Desktop — Learning facade over the Service Host.
//
// The only renderer-side implementation of `LearningPort`. It is transport
// only: one typed request per Hermes method (spec §7.5), no retries, no
// caching, no policy. Degrade decisions belong to the callers.
//
// Failure policy:
//   - A degrade answer from the host (`ok:false`) resolves normally — Hermes
//     missing is not an error for Code/Work.
//   - A transport failure rejects with `ServiceRequestError`, which the
//     callers treat as "Service Host down" (spec §7.3).
//   - `applyPending` also fails closed locally: without `expectedHash` the
//     request never leaves the renderer, so a stale UI cannot commit content
//     the user did not review (arch §6.3).

import type { ServicesClient } from '../services-host/services-client';
import { ServiceRequestError } from '../services-host/services-client';
import type {
  HermesMcpProfile,
  LearningExplicitParams,
  LearningGraphSummaryResult,
  LearningHealthResult,
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
  LegacyImportCommitParams,
  LegacyImportCommitResult,
  LegacyImportPlanResult,
  LearningMemorySnapshotResult,
  LearningMcpArgsResult,
  LearningPendingApplyParams,
  LearningPendingBackupsResult,
  LearningCopyTemplateParams,
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
} from '../services-host/methods';
import type { LearningPort } from './learning-port';

export class LearningUnavailableError extends Error {
  constructor(method: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`learning.${method} unavailable: ${detail}`);
    this.name = 'LearningUnavailableError';
  }
}

export function createLearningFacade(client: ServicesClient): LearningPort {
  return {
    async health() {
      return client.request('learning.health');
    },

    async mcpArgs(profile: HermesMcpProfile) {
      return client.request('learning.mcpArgs', { profile });
    },

    async memorySnapshot() {
      return client.request('learning.memorySnapshot');
    },

    async skills(params: LearningSkillsParams) {
      return client.request('learning.skills', params);
    },

    async syncSession(session: LearningSessionProjection) {
      return client.request('session.sync', { session });
    },

    async rebuildSessions(sessions: readonly LearningSessionProjection[]) {
      return client.request('session.rebuild', { sessions: [...sessions] });
    },

    async flushSessions() {
      return client.request('session.flush');
    },

    async listPending() {
      return client.request('learning.pendingList');
    },

    async pendingDetail(params: LearningPendingDetailParams) {
      return client.request('learning.pendingDetail', params);
    },

    async applyPending(params: LearningPendingApplyParams) {
      // Fail closed before the request leaves the renderer.
      if (params?.subsystem !== 'memory' && params?.subsystem !== 'skills') {
        throw new LearningUnavailableError('pendingApply', 'a valid pending subsystem is required');
      }
      if (!params?.id) {
        throw new LearningUnavailableError('pendingApply', 'a pendingId is required');
      }
      if (!params?.expectedHash) {
        throw new LearningUnavailableError(
          'pendingApply',
          'expectedHash is required — review the proposal again before applying',
        );
      }
      return client.request('learning.pendingApply', params);
    },

    async discardPending(params: LearningPendingDiscardParams) {
      return client.request('learning.pendingDiscard', params);
    },

    async listPendingBackups() {
      return client.request('learning.pendingBackupList');
    },

    async rollbackPending(params: LearningPendingRollbackParams) {
      if (!params?.snapshotId) {
        throw new LearningUnavailableError('pendingRollback', 'a snapshotId from listPendingBackups is required');
      }
      return client.request('learning.pendingRollback', params);
    },

    async copyTemplateUnderOut(params: LearningCopyTemplateParams) {
      if (!params?.workspaceRoot || !params?.sourceRel || !params?.destAbs) {
        throw new LearningUnavailableError('copyTemplateUnderOut', 'workspaceRoot, sourceRel and destAbs are required');
      }
      return client.request('learning.copyTemplateUnderOut', params);
    },

    // ── 3C learning loop (spec §7.6) ────────────────────────────────
    async reviewImplicit(params: LearningReviewParams) {
      return client.request('learning.reviewImplicit', params);
    },

    async learnExplicit(params: LearningExplicitParams) {
      if (!params?.learnRequest) {
        throw new LearningUnavailableError('learnExplicit', 'a /learn request is required');
      }
      return client.request('learning.learnExplicit', params);
    },

    async runStatus(params: LearningRunStatusParams = {}) {
      return client.request('learning.runStatus', params);
    },

    async searchHistory(params: LearningHistorySearchParams) {
      return client.request('learning.historySearch', params);
    },

    // ── upstream journey / L4 / L5 / L6 ────────────────────────────
    async graphSummary() {
      return client.request('learning.graphSummary');
    },

    async scanQuality(params: LearningQualityScanParams = {}) {
      return client.request('learning.qualityScan', params);
    },

    async mineHistory(params: LearningHistoryMineParams) {
      return client.request('learning.historyMine', params);
    },

    async manageJobs(params: LearningJobsParams = {}) {
      return client.request('learning.jobs', params);
    },

    async planLegacyImport() {
      return client.request('learning.importPlan');
    },

    async commitLegacyImport(params: LegacyImportCommitParams) {
      if (!params?.source) {
        throw new LearningUnavailableError('importCommit', 'a source path from planLegacyImport is required');
      }
      return client.request('learning.importCommit', params);
    },
  };
}

/** Narrow helper for the run path: CLI args for one profile, or `[]` when
 *  Hermes is unavailable. Used by trylo-runner's `extraCliArgs` seam. */
export async function resolveHermesMcpArgs(
  port: LearningPort,
  profile: HermesMcpProfile,
): Promise<readonly string[]> {
  try {
    const result: LearningMcpArgsResult = await port.mcpArgs(profile);
    return result.ok ? result.arg : [];
  } catch (err) {
    if (err instanceof ServiceRequestError) return [];
    throw err;
  }
}

export type {
  LegacyImportPlanResult,
  LegacyImportCommitResult,
  LearningReviewResult,
  LearningRunStatusResult,
  LearningHistorySearchResult,
  LearningGraphSummaryResult,
  LearningQualityScanResult,
  LearningHistoryMineResult,
  LearningJobsResult,
  LearningHealthResult,
  LearningMemorySnapshotResult,
  LearningMcpArgsResult,
  LearningSessionSyncResult,
  LearningSessionRebuildResult,
  LearningSkillsResult,
  LearningPendingListResult,
  LearningPendingDetailResult,
  LearningPendingMutationResult,
  LearningPendingBackupsResult,
};
