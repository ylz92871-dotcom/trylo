import type { CompleteInputTokenObservation } from "./provider.js";

/** Fixed-size commitments, never prompt or adapter-private text. */
export type PromptInputCommitment = { readonly count: number; readonly digest: string };

export type StoredPromptInputBasisV1 = {
  readonly version: 1;
  readonly model: string;
  readonly input: CompleteInputTokenObservation;
  readonly inputBindingDigest: string;
  readonly settingsDigest: string;
  readonly toolDigest: string;
  readonly windowDigest: string;
  readonly nativeMode: "none" | "measured";
  readonly nonSystem: PromptInputCommitment;
  readonly systems: PromptInputCommitment & { readonly nativeDigest: string };
};

/** Private extension committed beside exactly one canonical stream_end. */
export type PromptInputCheckpoint = {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly streamIndex: number;
  readonly basis: StoredPromptInputBasisV1;
};

/** Adapter proof and input projection captured with one prepared measurement. */
export type PersistablePromptInputIdentity = {
  readonly inputBindingDigest: string;
  readonly settingsDigest: string;
  readonly windowDigest: string;
};
