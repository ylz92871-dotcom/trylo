import { createCentralWorkflowExecution } from "../../integration/central-learning/workflow.js";
import { createWorkflowImprovementModel } from "../../learning/agent/subsystems/workflow/adapters/improvement-model.js";
import { workflowImprovementPublicData, workflowImprovementContextPublicData } from "../../learning/agent/subsystems/workflow/adapters/improvement-evidence.js";
import { workflowFailure } from "../../learning/agent/subsystems/workflow/domain/trace-parse.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralRuntimeDomainsInput } from "./central-runtime-domains-contracts.js";

/** Research resumes original saved opportunities. This scope-owned worker never
 * manufactures a business session or journals nonexistent execution receipts. */
export function createCentralRuntimeWorkflow(input: CentralRuntimeDomainsInput) {
  const secrets = input.connection.apiKey === undefined ? [] : [input.connection.apiKey];
  return createCentralWorkflowExecution({ boardRoot: input.boardRoot, scope: input.workspaceId, centralScope: input.scope,
    budgetId: `central-workflow:${contentHashOf(input.scope)}`, sessionId: input.ctx.newId("central-workflow-research"),
    allowance: input.allowance.maxTokens, nominationAllowance: input.allowance, now: input.ctx.now, enabled: input.enabled, research: true,
    modelRef: `workflow-model:${input.modelRef}`, contextForIssue: input.contextForIssue,
    publicData: value => input.enabled() && workflowImprovementPublicData(value, secrets),
    contextPublicData: value => input.enabled() && workflowImprovementContextPublicData(value, secrets),
    warn: code => input.ctx.stderr(`warning: workflow_learning:${code}\n`),
    readEvidence: async () => workflowFailure("workflow_business_session_required", "New business evidence must come from its original persisted session; the research owner only resumes saved sources"),

    newModel: maxPromptChars => {
      const provider = input.provider.fork?.([]);
      if (provider === undefined || provider === input.provider) throw new Error("central_workflow_provider_isolation_required");
      return createWorkflowImprovementModel({ provider, model: input.model, maxPromptChars,
        ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }) });
    },
  });
}
