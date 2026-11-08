import type { ToolEvolutionRequest, ToolEvolutionRequirement } from "../domain/evolution/contracts.js";
import type { ToolRuntimeDescriptor } from "../../../../../tooling/contract/descriptor.js";
import type { ToolLearningAllowance, ToolLearningContext } from "../domain/evolution/learning-plan.js";
import type { ToolDiscoverySummary, ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolEvolutionOutcome } from "./evolution-runtime.js";
import type { ToolJobAdmission } from "./evolution-archive.js";
import type { ToolInspectionRequest, ToolInspectionReport } from "../domain/evolution/research.js";
import type { PipelineFailure } from "./pipeline-assets.js";
import type { ToolLibraryInvestigation } from "../domain/evolution/reuse-retrieval.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";

export type ToolPlanningSupplement = Pick<ToolLearningContext, "availableTools" | "requirements"> & {
  readonly groundedSamples?: ToolLearningContext["groundedSamples"];
};

export type ToolPipelineServices = {
  readonly centralSourceContext?: CentralLearningSourceContext;
  /** Host can archive exact inherited production checks outside generation inputs. */
  readonly productionRegression?: "preserve";
  readonly executionAuthorized?: boolean;
  readonly search: (capability: string, signal: AbortSignal) => Promise<ToolDiscoverySummary>;
  readonly inspect?: (request: ToolInspectionRequest, signal: AbortSignal) => Promise<ToolInspectionReport>;
  readonly lookup?: (query: string, plan: ToolLearningPlan, signal: AbortSignal) => Promise<ToolLibraryInvestigation>;
  readonly evolve: (request: ToolEvolutionRequest, signal: AbortSignal, feedback: string, admission: ToolJobAdmission,
    requirements?: readonly ToolEvolutionRequirement[]) => Promise<ToolEvolutionOutcome>;
  readonly plan?: (context: ToolLearningContext, signal: AbortSignal) => Promise<unknown>;
  readonly allowance?: (plan: ToolLearningPlan, signal: AbortSignal) => Promise<ToolLearningAllowance | undefined>;
  readonly context?: (plan: ToolLearningPlan, signal: AbortSignal) => Promise<ToolPlanningSupplement>;
  readonly compose?: (request: ToolEvolutionRequest, descriptor: ToolRuntimeDescriptor, signal: AbortSignal,
    feedback: string, admission: ToolJobAdmission) => Promise<ToolEvolutionOutcome>;
  readonly adapt?: (plan: ToolLearningPlan, parentVersionId: string, adaptation: string, signal: AbortSignal,
    admission: ToolJobAdmission) => Promise<{ readonly ok: true; readonly versionId: string } | PipelineFailure>;
  readonly releaseAllowance?: () => Promise<void>;
};
