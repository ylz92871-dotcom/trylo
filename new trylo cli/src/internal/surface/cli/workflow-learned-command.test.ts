import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkflow } from "./args-workflow.js";
import { createWorkflowExecution } from "../../integration/workflow-learning/execution.js";
import type { WorkflowLearningArtifact } from "../../learning/domains/workflow/trace-contracts.js";
import { wirePorts } from "./wiring.js";
import { createDenyAllPermission } from "./permission.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";
import { parseRun } from "./args-run.js";

test("workflow learning dispatch owns its bounded request while legacy markdown parsing stays compatible", () => {
  for (const args of [["learn", "request.json"], ["learned", "--json"], ["inspect", "wfl_id"], ["feedback", "wfl_id"]]) {
    assert.deepEqual(parseWorkflow(args), { kind: "workflow_learning", args });
  }

  const learned = parseWorkflow(["run", "wfl_id", "--task", "task.json", "--", "--provider", "fixture"]);

  assert.equal(learned.kind, "workflow_run");

  if (learned.kind === "workflow_run") {
    assert.equal(learned.options.task, "task.json");
    assert.equal(learned.options.run.provider, "fixture");
  }

  assert.equal(parseWorkflow(["run", "wfl_id", "--", "--provider", "fixture"]).kind, "error");
  assert.equal(parseWorkflow(["run", "old-markdown", "--task", "task.json"]).kind, "error");
  assert.equal(parseWorkflow(["run", "old-markdown", "--", "--provider", "fixture"]).kind, "workflow_run");
  const automatic = parseRun(["--workflow-learning", "--workflow-learning-budget", "2048", "task"]);

  assert.equal(automatic.kind, "run");

  if (automatic.kind === "run") assert.equal(automatic.options.workflowLearningBudget, 2048);

  const refill = parseRun(["--resume", "daily", "--workflow-refill-tokens", "1000", "--workflow-budget-grant", "grant-1", "continue"]);

  assert.equal(refill.kind, "run");

  if (refill.kind === "run") assert.equal(refill.options.workflowRefillTokens, 1000);

  assert.equal(parseRun(["--workflow-refill-tokens", "1000", "--workflow-budget-grant", "grant-1", "task"]).kind, "error");
  assert.equal(parseRun(["--workflow-collection", "unknown", "task"]).kind, "error");
});

test("learned observation tools pass through the existing deny policy and closed tool selection", async () => {
  const artifact: WorkflowLearningArtifact = { schemaVersion: 1, type: "workflow_learning", requestId: "r", scope: "s",
    taskFamily: { id: "f", intentClass: "i", checkKind: "acceptance" }, mode: "path",
    nodes: [], recovery: [], positiveEvidenceRefs: ["e"], negativeEvidenceRefs: [], traces: [] };
  for (const toolSelection of [undefined, []]) {
    const execution = createWorkflowExecution({ artifact, versionId: "wfl_id", traceId: "trace" });
    const wiring = wirePorts({ providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
      workspaceRoot: process.cwd(), permission: createDenyAllPermission(), additionalTools: execution.tools,
      ...(toolSelection === undefined ? {} : { toolSelection }) });

    assert.equal("code" in wiring, false);

    if ("code" in wiring) continue;

    try {
      assert.deepEqual(wiring.ports.tools.snapshot().filter(item => item.name === "workflow_record_step").map(item => item.sideEffect),
        toolSelection === undefined ? ["read_only"] : []);
      assert.equal(wiring.ports.tools.snapshot().find(item => item.name === "run_shell")?.needsApproval,
        toolSelection === undefined ? true : undefined);
      const ticket = await wiring.ports.permission.request(buildPermissionAction("checker", "run_shell", { command: "node check.mjs" }));
      assert.equal((await wiring.ports.permission.awaitDecision(ticket.ticketId)).resolution, "denied");
    } finally { await wiring.close(); }
  }
});
