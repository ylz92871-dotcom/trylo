import type { TaskFamily } from "../../learning/domains/shared/types.js";
import type { SkillTaskQualification } from "./task-contract.js";
import type { SkillExperience } from "./runtime-contract.js";

/** Recovery coordinates only. The session journal owns task text and transcript. */
export type SkillTaskQueueInput = {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly fromSequence: number;
  readonly sourceSequence: number;
  readonly qualification: SkillTaskQualification;
  readonly expectedFamily: TaskFamily;
  readonly checker: { readonly id: string; readonly command: string; readonly verifierFiles: Readonly<Record<string, string>> };
  readonly usedSkill?: SkillExperience["usedSkill"];
  readonly derivationKey?: string;
};

export type SkillTaskQueueOutcome =
  | { readonly kind: "processed"; readonly experienceId: string; readonly experienceHash?: string }
  | { readonly kind: "extraction_failure" | "cancelled"; readonly reason: string };

export type SkillTaskQueueEntry = {
  readonly key: string;
  readonly task: SkillTaskQueueInput;
  readonly state: "queued" | "running" | SkillTaskQueueOutcome["kind"];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly lastRevision?: string;
  readonly lastFailure?: string;
  readonly experienceId?: string;
  readonly experienceHash?: string;
};

export type SkillTaskQueueEvent =
  | { readonly kind: "enqueue"; readonly key: string; readonly task: SkillTaskQueueInput; readonly maxAttempts: number }
  | { readonly kind: "claim"; readonly key: string; readonly attempt: number; readonly retryRevision: string }
  | { readonly kind: "settle"; readonly key: string; readonly attempt: number; readonly retryRevision: string; readonly result: SkillTaskQueueOutcome };

export type SkillTaskQueueFailure = { readonly ok: false; readonly code: string; readonly message: string };

export type SkillTaskQueueResult<T> = { readonly ok: true } & T | SkillTaskQueueFailure;

export type SkillTaskQueueOptions = {
  readonly root: string;
  readonly workspaceId: string;
  readonly collection: () => "enabled" | "disabled";
  readonly maxAttempts?: number;
  readonly limits?: { readonly maxBytes?: number; readonly maxRecords?: number; readonly maxRecordBytes?: number };
};
