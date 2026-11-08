import type { WorkflowTrace } from "../../learning/domains/workflow/trace-contracts.js";
import type { WorkflowStreamEvent } from "../../protocol/workflow-stream.js";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args-primitives.js";

/** Stream facts from the same journal projection used for checkpoint recovery. */
export function emitWorkflowSnapshot(ctx: CliContext, options: RunCommandOptions, trace: WorkflowTrace): void {
  if (trace.workflowVersionId === undefined || trace.sessionId === undefined) return;

  const event: WorkflowStreamEvent = { type: "workflow_state", version: 1, workflowVersionId: trace.workflowVersionId,
    traceId: trace.traceId, sessionId: trace.sessionId, state: trace.runState ?? "interrupted", outcome: trace.outcome,
    steps: trace.steps.map(step => ({ nodeId: step.nodeId, status: step.status, input: step.input, output: step.output, evidenceRefs: step.evidenceRefs,
      dependsOn: step.dependsOn, ...(step.inputBindings === undefined ? {} : { inputBindings: step.inputBindings }),
      ...(step.outputDigest === undefined ? {} : { outputDigest: step.outputDigest }), ...(step.recoveryTo === undefined ? {} : { recoveryTo: step.recoveryTo }) })),
    ...(trace.executionId === undefined ? {} : { executionId: trace.executionId }),
    ...(trace.adoptedBranchId === undefined ? {} : { branchId: trace.adoptedBranchId }),
    ...(trace.cost === undefined ? {} : { cost: trace.cost }),
    ...(trace.budgetReceipt === undefined ? {} : { budgetReceipt: trace.budgetReceipt }) };

  if (options.format === "stream-json") ctx.stdout(`${JSON.stringify(event)}\n`);
  else ctx.stderr(`workflow ${event.workflowVersionId} ${event.state}, ${event.steps.length} checkpoints\n`);
}
