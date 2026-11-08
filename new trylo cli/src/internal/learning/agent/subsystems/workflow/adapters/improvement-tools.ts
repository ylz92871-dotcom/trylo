import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ToolBinding, ToolOutcome, ToolPort } from "../../../../../ports/tools.js";
import type { WorkflowImprovementRuntime } from "../runtime/improvement-runtime.js";
import { record } from "../domain/trace-parse.js";
import { WORKFLOW_IMPROVEMENT_PARAMETERS } from "./improvement-tool-schema.js";

export const WORKFLOW_IMPROVEMENT_HOOK = [
  "Workflow learning: at a meaningful handoff, call workflow_learning operation=context report={} for current evidence and applicable workflow inventory.",
  "An inventory researchTarget is a proposed purpose, not an observed task. Reuse its family/process only when the current intent, input/output, effects and checks match, after probing unknown assumptions; copying a research identifier does not establish business facts.",
  "If repeated inefficiency or an actual user correction suggests a process change, operation=opportunity nominates the problem with actual evidence refs; business continues while a separately funded researcher works.",
  "At a later phase boundary call context with current task premises and boundary to obtain a frozen procedure. Probe unknown assumptions; retain current user instructions and required quality.",
  "Pending, unavailable, budget-limited or abstained learning is non-blocking. Continue the business task; do not poll for a proposal or retry an unchanged nomination. Reconsider only at a relevant later handoff or after new observations.",
  "After genuinely using it, call feedback once with its useId and followedStepIds. Omit evidenceRefs to let the host bind this feedback call's actual post-use execution receipts, or cite explicit refs. A model report is not independent quality or causal evidence.",
  "Inventory/not_applicable has no adopted useId: do not invent feedback for it. Context exposes actual no-match observations as research evidence, separate from post-use business receipts; nominate a revision with those real refs when warranted.",
  "task.conditions declares the prerequisites a reusable process truly depends on. Keep incidental paths, source snapshots and artifact values in evidence; do not turn them into permanent applicability gates unless exact identity is semantically required. Unknown premises need observable probes. Never remove user requirements or execution permissions to obtain a match.",
  "For adoption, inventory task.process and requiredConditions are canonical contract assertions: their identities use exact keys and string values, not paraphrase similarity. First judge whether the complete published process and each prerequisite hold for the actual current sources. Only after verifying them, reuse those canonical assertions unchanged in task.process/task.conditions; retain concrete current observations in their original execution evidence. A different assertion is a different premise, not a confirmation. Do not copy an assertion that is false or unknown just to obtain guidance.",
].join("\n");

const BINDING: ToolBinding = {
  name: "workflow_learning",
  description: [
    "Model hook for workflow improvement; never grants execution permission. report must be an actual JSON object inside the tool arguments, never a JSON-encoded string. operation=context report={} lists bounded current journal evidence, workflow versions and this session's uses.",
    "context report={task:{taskFamily:{id,intentClass,checkKind,language?,repoKind?,checkSchema?},conditions?,process?:{key,inputContract,outputContract,sideEffects:read_only|local_artifact|external,checkContract}},boundary,versionId?,issueKey?} adopts the latest applicable frozen procedure only at a handoff; checkKind is unit_test|compile|lint|acceptance. All process fields are required when supplied. Reuse an inventory process contract only if its input/output/effect/check semantics actually match the current operation; this can span business task families without carrying prior-family quality credit.",
    "opportunity report={issueKey,task:{taskFamily,conditions?,process?},trigger:repeated_inefficiency|user_correction,problem,desiredOutcome,evidenceRefs,affectedStepIds?} queues a bounded background proposal. Optional affectedStepIds names at most eight existing steps in the current improvement parent for a local rewrite; cold learning has no step target. Use inventory stepIds or inspect the referenced version rather than inventing IDs. Cite actual evidence from context, including accurately attributed operator feedback; same evidence cannot be repeatedly funded by renaming a problem. report={resumeOpportunityId} may resume only previously unclaimed/unreserved work using this run's fresh allowance; paid/unknown attempts require new facts or an explicit operator grant. Reuse recentIssues issueKey rather than naming the same failure again. Do not report every success.",
    "feedback report={useId,exposure:reported_used|skipped,evidenceRefs?,followedStepIds,explanation} records one final model feedback per frozen use. Omit evidenceRefs to bind actual business receipts after this use in the execution of this durably recorded feedback call; reported_used needs at least one such receipt. Ambiguous/missing call identity fails rather than guessing a turn. Explicit IDs still must name actual post-use receipts; explicit [] keeps an unverified report. followedStepIds are self-reported. Omit quality/comparison/processEvidence/userAssessment; only independent host/user channels can admit them. Product quality passing does not prove the whole workflow was followed. If the procedure is unsuitable, nominate a revision using new evidence.",
  ].join(" "),
  sideEffect: "read_only", needsApproval: false, parallelSafe: false, timeoutMs: 10_000,
  outputLimits: { maxBytes: 32_768, maxLines: 140 },
  parameters: WORKFLOW_IMPROVEMENT_PARAMETERS,
};

/** These operations write learning data only; the asynchronous researcher has no tool port. */
export function createWorkflowImprovementTools(runtime: WorkflowImprovementRuntime): ToolPort {
  return { snapshot: () => [structuredClone(BINDING)], cancel: async () => {}, async execute(call, signal): Promise<ToolOutcome> {
    if (signal.aborted) return { outcome: "cancelled" };

    if (call.name !== BINDING.name || Object.keys(call.arguments).some(key => key !== "operation" && key !== "report")) return failure("invalid_workflow_hook");

    if (call.arguments.report !== undefined && !record(call.arguments.report)) return failure("invalid_workflow_hook",
      "report must be a JSON object, not a string or array. Keep the same intended report fields and send them directly as the report object; do not JSON.stringify the report. Example: {\"operation\":\"context\",\"report\":{}}.");

    try {
      const operation = call.arguments.operation, report = call.arguments.report ?? {};
      const result = operation === "context" ? await runtime.context(call.toolCallId, report, signal)
        : operation === "opportunity" ? await runtime.opportunity(call.toolCallId, report, signal)
        : operation === "feedback" ? await runtime.feedback(call.toolCallId, report, signal) : undefined;

      if (signal.aborted) return { outcome: "cancelled" };

      if (result === undefined) return failure("invalid_workflow_hook");

      if (!result.ok) return failure(result.code, result.message);

      // Runtime results are parsed JSON-domain values; serialize once at this tool boundary.
      const value: JsonObject = { result: JSON.parse(JSON.stringify(result.value)) };

      return { outcome: "result", value, output: JSON.stringify(value), truncated: false };
    } catch {
      return failure("workflow_hook_unavailable");
    }
  } };
}

function failure(code: string, message = code): ToolOutcome { return { outcome: "error", code, message }; }
