import type { spawn } from 'node:child_process';

/** Original adapter inputs and JSON envelopes pass through without a new asset schema. */
export type HermesParameters = Readonly<Record<string, unknown>>;
export type HermesEnvelope = Readonly<Record<string, unknown>> & {
  readonly ok: boolean;
  readonly error?: unknown;
};

export interface HermesSkillCompatibilityOptions {
  readonly storageRoot?: string;
  readonly capabilitiesDir?: string;
  readonly timeoutMs?: number;
  /** Existing wrapper test seams; production leaves them absent. */
  readonly spawn?: typeof spawn | null;
  readonly resolver?: (() => string) | null;
  readonly admin?: Readonly<Record<string, unknown>> | null;
}

export interface HermesSkillCompatibility {
  skillsQuery(params?: HermesParameters): Promise<HermesEnvelope>;
  list(): Promise<HermesEnvelope>;
  view(name: unknown): Promise<HermesEnvelope>;
  pendingProposeSkill(params?: HermesParameters): Promise<HermesEnvelope>;
  pendingList(): Promise<HermesEnvelope & { readonly pending: readonly unknown[]; readonly count: number }>;
  pendingDetail(params?: HermesParameters): Promise<HermesEnvelope>;
  pendingApply(params?: HermesParameters): Promise<HermesEnvelope>;
  pendingDiscard(params?: HermesParameters): Promise<HermesEnvelope>;
  pendingBackupList(): Promise<HermesEnvelope & { readonly backups: readonly unknown[] }>;
  pendingRollback(params?: HermesParameters): Promise<HermesEnvelope>;
}

export function createHermesSkillCompatibility(options?: HermesSkillCompatibilityOptions): HermesSkillCompatibility;

export interface HermesFileMemento {
  get(key: string, defaultValue?: unknown): unknown;
  update(key: string, value: unknown): Promise<void>;
  readonly filePath: string;
}

export function createFileMemento(options?: {
  readonly storageRoot?: string;
  readonly log?: ((message: string) => void) | null;
  readonly corruptionPolicy?: 'legacy_reset' | 'fail_closed';
}): HermesFileMemento;
