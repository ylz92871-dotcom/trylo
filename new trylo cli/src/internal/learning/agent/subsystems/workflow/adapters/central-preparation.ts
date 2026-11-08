import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovementOpportunityRecord, WorkflowImprovementStorePort } from "../runtime/improvement-contracts.js";
import { prepareWorkflowImprovement } from "../runtime/improvement-preparation.js";
import { workflowImprovementPrompt } from "./improvement-prompt.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";
import { workflowResearchPrompt } from "./research-model.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { WorkflowResearchObservation } from "../improvement/research-contracts.js";
import type { WorkflowResearchHead } from "../runtime/research-state.js";
import { workflowResearchObservations } from "../runtime/research-state.js";

/** Read-only feasibility of the exact original proposal program before central investment.
 * Source/lineage and the original prompt/token projection remain authoritative; no model instance is created here.
 */
export async function prepareWorkflowCentralProgram(input: {
  readonly store: WorkflowImprovementStorePort;
  readonly record: WorkflowImprovementOpportunityRecord;
  readonly allowance: number;
  readonly maxPromptChars: number;
  readonly publicData: (value: unknown) => boolean;
  readonly contextPublicData?: (value: unknown) => boolean;
  readonly centralContent?: CentralLearningSourceContext;
  readonly research?: { readonly observations: readonly WorkflowResearchObservation[]; readonly records?: readonly WorkflowResearchHead[] };
}) {
  const prepared = await prepareWorkflowImprovement({ store: input.store }, input.record);
  if (!prepared.ok) return prepared;

  const { parent, evidence, history, feedback } = prepared.value;
  const material = { opportunity: input.record.opportunity, evidence,
    ...(parent === undefined ? {} : { parent: parent.artifact }), history, feedback,
    ...(input.centralContent === undefined ? {} : { centralContent: input.centralContent }) };
  if (!(input.contextPublicData ?? input.publicData)(material)) return workflowFailure("workflow_private_report", "Private context cannot be dispatched to the workflow researcher");

  const contextRef = `workflow-research-context:${contentHashOf(material)}`;
  const observations = input.research?.records === undefined ? input.research?.observations ?? []
    : workflowResearchObservations(input.research.records, contextRef);
  const projected = input.research === undefined ? workflowImprovementPrompt(material, input.allowance, input.maxPromptChars)
    : workflowResearchPrompt({ ...material, observations }, input.allowance, input.maxPromptChars);

  return !projected.ok ? projected : { ok: true as const, value: {
    promptChars: projected.value.instruction.length + projected.value.prompt.length,
    contextRef } };
}
