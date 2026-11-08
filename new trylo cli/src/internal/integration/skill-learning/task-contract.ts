import type { ProviderPort } from "../../ports/provider.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { SkillCorrection, SkillEpisode } from "../../learning/domains/skill/types.js";
import type { TaskFamily } from "../../learning/domains/shared/types.js";
import type { SkillExperience } from "./runtime-contract.js";

/** Owned by the runtime's checker or explicit user channel, never by the model. */
export type SkillTaskQualification =
  | { readonly kind: "external_check"; readonly ref: string; readonly outcome: "success" | "failure";
      readonly checks: readonly { readonly label: string; readonly eventId: string }[] }
  | { readonly kind: "execution_failure"; readonly ref: string; readonly outcome: "failure"; readonly failureMode: string }
  | { readonly kind: "explicit_correction"; readonly ref: string; readonly outcome: "failure"; readonly correction: SkillCorrection };

export type SkillModelAllowance = {
  readonly maxModelCalls: number;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
};

/** Missing provider usage remains unknown, including after a cancelled call. */
export type SkillModelUsage = {
  readonly calls: number;
  readonly inputBytes: number;
  readonly usageStatus: "reported" | "missing";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type SkillTaskExtractionInput = {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly taskText: string;
  readonly transcript: Transcript;
  readonly events: readonly Envelope[];
  readonly fromSequence?: number;
  readonly qualification?: SkillTaskQualification;
  readonly usedSkill?: SkillExperience["usedSkill"];
  readonly priorFamilies?: readonly TaskFamily[];
  readonly priorEpisodes?: readonly SkillEpisode[];
  readonly facts?: Partial<Pick<TaskFamily, "checkKind" | "language" | "repoKind" | "checkSchema">>;
  /** A frozen runtime checker family; the model may not rename or broaden it. */
  readonly expectedFamily?: TaskFamily;
  readonly validatedAfterCorrectionIds?: readonly string[];
};

/** Source coordinates justify the summary; this is not hidden reasoning. */
export type SkillTaskDerivation = {
  readonly inputDigest: string;
  readonly stepSources: readonly { readonly step: string; readonly sequences: readonly number[] }[];
  readonly checkSources: readonly { readonly check: string; readonly eventIds: readonly string[] }[];
};

export type SkillModelIssue = {
  readonly kind: "waiting" | "failed" | "cancelled" | "disabled";
  readonly reason: string;
  readonly usage: SkillModelUsage;
};

export type SkillTaskExtractionResult =
  | { readonly kind: "experience"; readonly experience: SkillExperience; readonly derivation: SkillTaskDerivation; readonly usage: SkillModelUsage }
  | SkillModelIssue;

export type SkillTaskSelectionInput = {
  readonly workspaceId: string;
  readonly currentTaskText: string;
  readonly candidates: readonly { readonly familyId: string; readonly taskFamily: TaskFamily }[];
  /** Runtime-observed facts. Unknown fields cannot become broad matching rules. */
  readonly facts?: Partial<Pick<TaskFamily, "checkKind" | "language" | "repoKind" | "checkSchema">>;
};

export type SkillTaskSelectionResult =
  | { readonly kind: "selected"; readonly familyId: string; readonly taskFamily: TaskFamily; readonly usage: SkillModelUsage }
  | { readonly kind: "none"; readonly reason: string; readonly usage: SkillModelUsage }
  | SkillModelIssue;

export type SkillTaskCorrectionInput = {
  readonly workspaceId: string;
  /** Only the current actual user input. Tool output is never a substitute. */
  readonly currentUserText: string;
  readonly priorEpisodes: readonly SkillEpisode[];
};

/** Interpretation only. The runtime must still bind an actual user source. */
export type SkillTaskCorrectionResult =
  | { readonly kind: "correction"; readonly quote: string; readonly correction: SkillCorrection; readonly usage: SkillModelUsage }
  | { readonly kind: "none"; readonly reason: string; readonly usage: SkillModelUsage }
  | SkillModelIssue;

export type SkillTaskModelOptions = {
  readonly provider: ProviderPort;
  readonly model: string;
  readonly collection: () => "enabled" | "disabled";
  readonly timeoutMs?: number;
};
