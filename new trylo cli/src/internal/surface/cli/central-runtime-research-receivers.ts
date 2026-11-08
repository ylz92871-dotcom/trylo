import type { CentralLearningExecutionPort, CentralResearchReception } from "../../integration/central-learning/contracts.js";
import { CentralResearchIntakeError, groundCentralResearch } from "../../integration/central-learning/research-intake-common.js";
import { acceptCentralCollaborationResearch } from "../../integration/central-learning/research-intake-collaboration.js";
import { acceptCentralMethodResearch, createCentralMethodResearchExecution } from "../../integration/central-learning/research-intake-method.js";
import { acceptCentralSkillResearch } from "../../integration/central-learning/research-intake-skill.js";
import { acceptCentralToolResearch } from "../../integration/central-learning/research-intake-tool.js";
import { acceptCentralWorkflowResearch } from "../../integration/central-learning/research-intake-workflow.js";
import type { CentralWorkflowExecution } from "../../integration/central-learning/workflow.js";
import type { CentralRuntimeCollaboration } from "./central-runtime-collaboration.js";
import type { CentralRuntimeDomainsInput } from "./central-runtime-domains-contracts.js";
import { selectCentralResearchEpisode } from "../../integration/central-learning/research-intake-episode.js";
import { recordCentralResearchProgram } from "../../integration/central-learning/research-intake-program-report.js";
import { createCentralRuntimeResearchContinuation } from "./central-runtime-research-continuation.js";

export interface CentralRuntimeResearchOwners {
  readonly workflow: Pick<CentralWorkflowExecution, "queueOpportunity">;
  readonly collaboration: Pick<CentralRuntimeCollaboration["control"], "report">;
}

/** One scope-owned reception entry. Grounding precedes the native producer;
 * focus, the original root investment and actual dispatch stay in the Agent bridge. */
export function attachCentralRuntimeResearchReceivers(input: CentralRuntimeDomainsInput, owners: CentralRuntimeResearchOwners,
  ports: readonly CentralLearningExecutionPort[]): readonly CentralLearningExecutionPort[] {
  const grounded = { boardRoot: input.boardRoot, scope: input.scope, enabled: input.enabled,
    ...(input.readResearchMaterials === undefined ? {} : { readMaterials: input.readResearchMaterials }) };
  const native = { boardRoot: input.boardRoot, scope: input.scope, workspaceId: input.workspaceId,
    now: input.ctx.now, enabled: input.enabled };
  const episodes = { ...grounded, readContinuation: createCentralRuntimeResearchContinuation(input.workspaceId),
    ...(input.compatibleScopes === undefined ? {} : { compatibleScopes: input.compatibleScopes }),
    ...(input.readCompatibleScopes === undefined ? {} : { readCompatibleScopes: input.readCompatibleScopes }),
    ...(input.readResearchFeedback === undefined ? {} : { readOwnerFeedback: input.readResearchFeedback }) };

  return ports.map(original => {
    const port = original.domain !== "prompt" ? original : createCentralMethodResearchExecution({ ...native,
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
      provider: input.provider, model: input.model, modelRef: input.modelRef, contextForIssue: input.contextForIssue }, original);
    const acceptResearch: NonNullable<CentralLearningExecutionPort["acceptResearch"]> = async (signal, cancellation) => {
      try {
        const groundedRequest = await groundCentralResearch(grounded, port.domain, signal, cancellation);
        const request = await selectCentralResearchEpisode(episodes, groundedRequest, cancellation);
        let received: CentralResearchReception;

        switch (port.domain) {
          case "collaboration": received = await acceptCentralCollaborationResearch({ ...grounded, now: input.ctx.now,
            control: owners.collaboration }, request, cancellation);break;
          case "prompt": received = await acceptCentralMethodResearch(native, request, cancellation);break;
          case "tool": received = await acceptCentralToolResearch(native, request, cancellation);break;
          case "skill": received = await acceptCentralSkillResearch({ ...grounded, now: input.ctx.now,
            workspaceRoot: input.scope }, request, cancellation);break;
          case "workflow": received = await acceptCentralWorkflowResearch({ ...native, workflow: owners.workflow }, request, cancellation);break;
        }

        return received.status === "accepted" ? recordCentralResearchProgram(native, request, received, cancellation) : received;
      } catch (error) {
        if (error instanceof CentralResearchIntakeError) return { status: "waiting", reason: error.reason, sourceRefs: error.sourceRefs };
        throw error;
      }
    };

    return { ...port, acceptResearch };
  });
}
