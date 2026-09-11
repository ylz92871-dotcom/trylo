import { createUserLearningStore, emptySnapshot, migrateSnapshot, type UserLearningStore } from './store';
import type { EvidenceRecord, UserDecisionTrace, UserLearningSnapshot } from './types';

export interface RepositoryLoadResult {
  readonly snapshot: UserLearningSnapshot;
  readonly readOnly: boolean;
  readonly persistFailed: boolean;
}

export interface UserLearningRepository {
  load(): RepositoryLoadResult;
  persist(): void;
  snapshot(): UserLearningSnapshot;
  appendTrace(trace: UserDecisionTrace): void;
  appendEvidence(evidence: readonly EvidenceRecord[]): void;
  exportForUser(): unknown;
  deleteUserData(): void;
}

export function createJsonRepository(store: UserLearningStore = createUserLearningStore()): UserLearningRepository {
  return {
    load() {
      const snapshot = store.load();
      return {
        snapshot,
        readOnly: snapshot.diagnostics?.readOnly === true,
        persistFailed: snapshot.diagnostics?.persistFailed === true,
      };
    },
    persist: () => store.persist(),
    snapshot: () => store.snapshot(),
    appendTrace(trace) {
      store.update((snap) => ({
        ...snap,
        traces: [...snap.traces.filter((item) => item.id !== trace.id), trace],
      }));
    },
    appendEvidence(evidence) {
      if (evidence.length === 0) return;
      store.update((snap) => ({ ...snap, evidence: [...snap.evidence, ...evidence] }));
    },
    exportForUser() {
      const snap = store.snapshot();
      return {
        schemaVersion: snap.schemaVersion,
        userId: snap.userId,
        evidence: snap.evidence,
        conclusions: snap.conclusions,
        userModels: snap.userModels,
        policyRules: snap.policyRules,
        policyDecisions: snap.policyDecisions,
        profileFacts: snap.profileFacts,
      };
    },
    deleteUserData() {
      store.replace(emptySnapshot());
    },
  };
}

export { migrateSnapshot };
