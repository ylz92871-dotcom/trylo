import type { WorkflowImprovementModelPort } from "../improvement/contracts.js";
import { parseWorkflowImprovementResponse } from "../improvement/scoped-edit.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { workflowImprovementPrompt } from "./improvement-prompt.js";
import { WORKFLOW_IMPROVEMENT_LIMITS } from "../runtime/improvement-contracts.js";
import { createWorkflowResearchModel, readWorkflowResearchStream, type WorkflowResearchModelOptions } from "./research-model.js";

/** Legacy proposals and resumable research share transport, but retain separate usage receipts. */
export function createWorkflowImprovementModel(input: WorkflowResearchModelOptions): WorkflowImprovementModelPort {
  let calls = 0, tokens = 0, observedTokens = 0, uncertain = false;
  const research = createWorkflowResearchModel(input);

  return {
    usage: () => ({ calls, tokens, observedTokens, uncertain }),
    research: research.research,
    researchUsage: research.usage,
    async propose(context, signal, allowance) {
      const projected = workflowImprovementPrompt(context, allowance,
        input.maxPromptChars ?? WORKFLOW_IMPROVEMENT_LIMITS.maxPromptChars, input.maxOutputTokens);
      if (!projected.ok) return projected;

      const response = await readWorkflowResearchStream(input, projected.value, signal, allowance, `workflow-improvement:${calls + 1}`);

      calls += response.usage.calls;
      tokens += response.usage.tokens;
      observedTokens += response.usage.observedTokens;
      uncertain ||= response.usage.uncertain;

      if (!response.result.ok) return response.result;

      let value: unknown;

      try { value = JSON.parse(response.result.value.trim()); }
      catch { return workflowFailure("learning_invalid_json", "Workflow researcher did not return JSON"); }

      const parsed = parseWorkflowImprovementResponse(value, context.parent, context.opportunity.affectedStepIds);
      if (!parsed.ok) return parsed;

      const cited = [...parsed.value.diagnosis.supportingRefs, ...parsed.value.diagnosis.counterEvidenceRefs,
        ...parsed.value.changes.flatMap(change => change.evidenceRefs)];

      return cited.every(ref => projected.value.visibleEvidenceRefs.includes(ref)) ? parsed
        : workflowFailure("improvement_evidence_unexposed", "The proposal cites facts that were not supplied in this bounded research context");
    },
  };
}
