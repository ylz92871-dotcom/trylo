import type {
  ResultRunStatus,
  StoredFileSignature,
  StoredWorkArtifact,
  StoredWorkRunDelta,
  WorkArtifactTarget,
} from './conversation-result-types';

/** In-memory projection keeps absent turn identities absent. Persistence alone
 * normalizes them to the existing on-disk string representation. */
export type ArtifactRecord = Omit<StoredWorkArtifact, 'lastTurnId' | 'verification'> & {
  readonly lastTurnId: string | undefined;
};

export type ArtifactRunDelta = Omit<StoredWorkRunDelta, 'turnId'> & {
  readonly turnId: string | undefined;
};

export interface ArtifactResult {
  readonly latestRun?: ArtifactRunDelta;
  readonly artifacts: readonly ArtifactRecord[];
  readonly artifactCountTotal: number;
  readonly truncated: boolean;
}

export type ArtifactRunOutcome = Exclude<ResultRunStatus, 'collecting' | 'degraded'>;
export type ArtifactRunTerminalState = 'finished' | 'degraded';

/** Result attribution belongs to the originating run, never the selected tab. */
export interface ArtifactRunScope {
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly conversationId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly turnId: string | undefined;
  readonly startedAt: number;
}

export interface ScannedArtifact {
  readonly target: WorkArtifactTarget;
  readonly id: string;
  readonly displayName: string;
  readonly artifactKind: StoredWorkArtifact['artifactKind'];
  readonly absolutePath: string;
  readonly signature: StoredFileSignature;
}

export interface ArtifactScanResult {
  readonly artifacts: readonly ScannedArtifact[];
  readonly truncated: boolean;
  readonly observedChanges?: ReadonlyMap<string, 'created' | 'updated'>;
}

export interface ArtifactUpsert {
  readonly rawPath: string;
  readonly artifactKind?: string;
  readonly at: number;
  readonly runId: string;
  readonly turnId: string | undefined;
}
