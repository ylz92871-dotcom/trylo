import type { JsonValue } from "../../../../../protocol/envelope.js";
import type { NpmInstallPlan } from "../../../../../tooling/contract/npm-install.js";
import type { CandidateExecution } from "../domain/evolution/execution.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolLearningAllowance } from "../domain/evolution/learning-plan.js";
import type { NpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import type { NpmLearningGrounding } from "../domain/evolution/npm-learning.js";
import type { ToolJobAdmission } from "./evolution-archive.js";
import type { ToolRuntimeDescriptor } from "../../../../../tooling/contract/descriptor.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { ToolNpmResearchReferences } from "../domain/evolution/research.js";

/** A generated tool can be replaced by an approved dependency without discarding its contract. */
export type NpmAdaptationPredecessor = { readonly versionId: string; readonly contentHash: string; readonly scope: string;
  readonly capability: string; readonly descriptor: ToolRuntimeDescriptor; readonly checks: ToolEvolutionRequest;
  readonly source: string; readonly feedback: string };

export type NpmAdaptationServices = {
  readonly complete: (prompt: string, signal: AbortSignal, phase: "contract" | "implementation") => Promise<unknown>;
  readonly allowance: () => Promise<ToolLearningAllowance | undefined>;
  readonly execute?: (plan: NpmToolProductionPlan, input: JsonValue, signal: AbortSignal) => Promise<CandidateExecution>;
};

export type NpmAdaptationInput = {
  readonly boardRoot: string; readonly workspaceId: string; readonly plan: ToolLearningPlan; readonly installation: NpmInstallPlan;
  readonly installationRoot: string; readonly adaptation: string; readonly admission: ToolJobAdmission; readonly services: NpmAdaptationServices;
  readonly requirements?: NpmLearningGrounding["requirements"];
  readonly acquisition?: { readonly jobId: string; readonly decisionVersionId: string };
  readonly signal: AbortSignal; readonly now: () => number;
  readonly parent?: { readonly versionId: string; readonly plan: NpmToolProductionPlan; readonly feedback: string };
  readonly predecessor?: NpmAdaptationPredecessor;
  readonly researchReferences?: ToolNpmResearchReferences;
};
