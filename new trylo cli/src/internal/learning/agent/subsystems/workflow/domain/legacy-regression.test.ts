import assert from "node:assert/strict";
import test from "node:test";
import { editWorkflow, induceWorkflow, type WorkflowDraft, type WorkflowEpisode } from "./inducer.js";
import { applyWorkflowMutation } from "./mutate.js";

function episode(id: string, outcome: "success" | "failure"): WorkflowEpisode {
  return {
    id,
    taskFamily: { id: "report-export", intentClass: "export_report", checkKind: "acceptance" },
    trajectory: {
      nodeIds: ["read", "render", "check"],
      stepCount: 3,
      hadFailureRecovery: true,
      hadChecks: true,
    },
    nodeInputs: { read: "source", render: "rows", check: "artifact" },
    nodeOutputs: { read: "rows", render: "artifact", check: "verdict" },
    fallback: "render",
    outcome,
  };
}

function draft(): WorkflowDraft {
  const result = induceWorkflow([episode("success", "success"), episode("failure", "failure")]);
  assert.equal(result.kind, "draft");
  if (result.kind !== "draft") {
    throw new Error("expected fixture draft");
  }
  return result.draft;
}

test("all failed episodes cannot create recommended transitions", () => {
  const result = induceWorkflow([episode("f1", "failure"), episode("f2", "failure")]);
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(result.code, "needs_more_evidence");
  }
});

test("identical node names cannot pool distinct task families", () => {
  const other = episode("other", "failure");
  const result = induceWorkflow([
    episode("s1", "success"),
    { ...other, taskFamily: { ...other.taskFamily, id: "database-export" } },
  ]);
  assert.equal(result.kind, "failure");
});

test("same family id with different prerequisites cannot pool evidence", () => {
  const other = episode("other", "failure");
  const result = induceWorkflow([
    episode("s1", "success"),
    { ...other, taskFamily: { ...other.taskFamily, checkSchema: "different-format" } },
  ]);
  assert.equal(result.kind, "failure");
});

test("recommended node contracts come from the successful trace", () => {
  const failed = episode("failure", "failure");
  const result = induceWorkflow([
    { ...failed, nodeOutputs: { ...failed.nodeOutputs, render: "broken artifact" } },
    episode("success", "success"),
  ]);

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.nodes.find((node) => node.id === "render")?.output, "artifact");
  }
});

test("positive and negative claims retain separate supporting observations", () => {
  const value = draft();
  assert.deepEqual(Reflect.get(value, "supportingObservationRefs"), ["success"]);
  assert.deepEqual(Reflect.get(value, "failureObservationRefs"), ["failure"]);
});

test("a workflow mutation gets a new draft and command identity", () => {
  const original = draft();
  const result = applyWorkflowMutation(original, { field: "budget.maxSteps", value: 8 });

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.version, original.version + 1);
    assert.notEqual(result.draft.id, original.id);
    assert.notEqual(result.draft.command.commandId, original.command.commandId);
    assert.equal(result.draft.command.payloadId, result.draft.id);
    assert.equal(original.budget.maxSteps, 5);
  }
});

test("workflow mutation rejects unusable budgets", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(applyWorkflowMutation(draft(), { field: "budget.maxSteps", value }).kind, "failure");
    assert.equal(applyWorkflowMutation(draft(), { field: "budget.maxTokens", value }).kind, "failure");
  }
});

test("workflow mutation rejects dangling or authority-bearing recovery paths", () => {
  for (const value of [
    [],
    [{ on: "node_failure", goto: "missing" }],
    [{ on: "skip_approval", goto: "render" }],
    [{ on: "", goto: "render" }],
  ]) {
    assert.equal(applyWorkflowMutation(draft(), { field: "failureFallback", value }).kind, "failure");
  }
});

test("a corrected recovery path is reflected in the next version rules", () => {
  const result = applyWorkflowMutation(draft(), {
    field: "failureFallback", value: [{ on: "node_failure", goto: "read" }],
  });

  assert.equal(result.kind, "draft");

  if (result.kind === "draft") {
    assert.equal(result.draft.negativeRules.some((rule) => rule.includes("goto read")), true);
    assert.equal(result.draft.negativeRules.some((rule) => rule.includes("goto render")), false);
  }
});

test("the legacy edit convenience API cannot bypass budget validation", () => {
  assert.throws(() => editWorkflow(draft(), {
    budget: { maxSteps: -1, maxTokens: 100, maxWallMs: 1000 },
  }), /positive safe integers/);
});

test("the legacy edit convenience API cannot bypass recovery validation", () => {
  assert.throws(() => editWorkflow(draft(), {
    failureFallback: [{ on: "skip_approval", goto: "read" }],
  }), /authority claims/);
});
