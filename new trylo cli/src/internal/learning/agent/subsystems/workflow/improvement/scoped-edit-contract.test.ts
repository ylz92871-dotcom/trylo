import assert from "node:assert/strict";
import test from "node:test";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import type { WorkflowImprovement, WorkflowImprovementModelPort, WorkflowImprovementProposal, WorkflowProcedureStep, WorkflowProcessChange } from "./contracts.js";
import { applyWorkflowImprovementPatch, buildWorkflowImprovement, parseWorkflowImprovementResponse,
  workflowImprovementEditScope } from "./index.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { record } from "../domain/trace-parse.js";
import { workflowImprovementPrompt } from "../adapters/improvement-prompt.js";
import { createWorkflowImprovementModel } from "../adapters/improvement-model.js";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";

function value<T>(result: WorkflowLearningResult<T>): T {
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.value;
}

function parentWorkflow(): WorkflowImprovement {
  const fixture = searchImprovementFixture();
  const extra = (id: string, action: string, dependsOn: readonly string[] = []): WorkflowProcedureStep => ({
    id, action, inputs: ["current task context"], outputs: [id + ":output"], dependsOn,
    verify: "The result belongs to the current task.",
    onFailure: { action: "replan", reason: "Inspect the current task facts before continuing." },
  });
  const steps: readonly WorkflowProcedureStep[] = [
    extra("capture-goal", "Capture the user's current output contract."),
    { ...fixture.proposal.procedure.steps[0]!, dependsOn: ["capture-goal"] },
    fixture.proposal.procedure.steps[1]!,
    { ...extra("render-summary", "Render the checked source evidence into the required summary.", ["scoped-search"]),
      when: { fact: "owner_confirmed", equals: "yes" } },
    { ...extra("archive-metadata", "Preserve the current audit metadata."),
      when: { fact: "metadata_enabled", equals: "yes" },
      onFailure: { action: "goto", target: "capture-goal", maxAttempts: 1, reason: "Reconcile metadata with the frozen task once." } },
    extra("finalize", "Publish the completion note after its checks."),
  ];

  return value(buildWorkflowImprovement({ ...fixture,
    proposal: { ...fixture.proposal, procedure: { ...fixture.proposal.procedure, steps } } }));
}

function probe(): WorkflowProcedureStep {
  return { id: "probe-owner", action: "Probe ambiguous owner candidates before committing the search scope.",
    inputs: ["current owner directory", "candidate roots"], outputs: ["confirmed search root"], dependsOn: ["confirm-owner"],
    verify: "The current owner evidence identifies one search root.",
    onFailure: { action: "goto", target: "confirm-owner", maxAttempts: 2, reason: "Inspect changed owner evidence before one bounded retry." } };
}

function change(kind: WorkflowProcessChange["kind"], stepIds: readonly string[]): WorkflowProcessChange {
  return { kind, stepIds, before: "Search the owner without first resolving ambiguous candidate roots.",
    after: "Probe the current candidate roots before selecting and searching one owner.",
    rationale: "The repeated searches discarded a known ambiguity.", evidenceRefs: ["receipt:search-2"],
    expectedEffect: "Avoid repeating an unchanged search over an ambiguous scope." };
}

function wire(parent: WorkflowImprovement, operations: readonly unknown[], changes: readonly WorkflowProcessChange[] = [change("replace", ["scoped-search"])],
  controls?: Record<string, unknown>) {
  return { diagnosis: parent.proposal.diagnosis, changes,
    procedurePatch: { operations, ...(controls === undefined ? {} : { controls }) } };
}

function proposedRevision(parent: WorkflowImprovement, proposal: WorkflowImprovementProposal, affectedStepIds: readonly string[] = ["scoped-search"]) {
  return buildWorkflowImprovement({ opportunity: { ...parent.opportunity, opportunityId: "opportunity:local-revision", affectedStepIds },
    evidence: parent.evidence, proposal, parent, parentVersionId: "workflow:local-parent" });
}

test("a scoped insert rewires the search while unexposed steps and quality remain byte-for-field equivalent", () => {
  const parent = parentWorkflow(), oldSearch = parent.proposal.procedure.steps.find(step => step.id === "scoped-search")!;
  const replacement = { ...oldSearch, action: "Search only the root confirmed by the fresh ambiguity probe.",
    inputs: ["confirmed search root", "requested symbols"], dependsOn: ["probe-owner"] };
  const patch = wire(parent, [{ op: "insert", before: oldSearch.id, step: probe() }, { op: "replace", step: replacement }],
    [change("insert", ["probe-owner"]), change("replace", [oldSearch.id])]);
  const proposal = value(parseWorkflowImprovementResponse(patch, parent, [oldSearch.id]));
  const revised = value(proposedRevision(parent, proposal));

  assert.deepEqual(revised.proposal.procedure.steps.find(step => step.id === oldSearch.id)?.dependsOn, ["probe-owner"]);
  assert.deepEqual(revised.proposal.procedure.steps.find(step => step.id === "probe-owner")?.dependsOn, ["confirm-owner"]);
  const exposed = new Set(value(workflowImprovementEditScope(parent, [oldSearch.id])).map(step => step.id));

  for (const step of parent.proposal.procedure.steps.filter(item => !exposed.has(item.id))) {
    assert.deepEqual(revised.proposal.procedure.steps.find(item => item.id === step.id), step);
  }

  assert.deepEqual(revised.proposal.procedure.qualityInvariants, parent.proposal.procedure.qualityInvariants);
  assert.equal(parent.proposal.procedure.steps.some(step => step.id === "probe-owner"), false);
});

test("local rewriting requires an improvement parent and real current step IDs", () => {
  const parent = parentWorkflow();
  const patch = wire(parent, [{ op: "replace", step: parent.proposal.procedure.steps[2] }]);
  const noParent = parseWorkflowImprovementResponse(patch, undefined, ["scoped-search"]);

  assert.equal(noParent.ok, false);
  if (!noParent.ok) assert.equal(noParent.code, "improvement_edit_parent_required");

  for (const ids of [[], ["scoped-search", "scoped-search"], ["legacy-checkpoint-verify"]]) {
    const result = workflowImprovementEditScope(parent, ids);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "improvement_edit_target_invalid");
  }

  const noParentBuild = buildWorkflowImprovement({ opportunity: { ...parent.opportunity, affectedStepIds: ["scoped-search"] },
    evidence: parent.evidence, proposal: parent.proposal });

  assert.equal(noParentBuild.ok, false);
  if (!noParentBuild.ok) assert.equal(noParentBuild.code, "improvement_edit_parent_required");
});

test("a local patch cannot alter any field of an unexposed existing step", () => {
  const parent = parentWorkflow(), outside = parent.proposal.procedure.steps.find(step => step.id === "archive-metadata")!;
  const mutations: readonly Partial<WorkflowProcedureStep>[] = [
    { action: "Replace the unrelated audit policy." }, { inputs: ["different input"] }, { outputs: ["different output"] },
    { dependsOn: ["capture-goal"] }, { when: { fact: "different_guard", equals: "yes" } },
    { verify: "Use a different acceptance criterion." }, { onFailure: { action: "stop", reason: "A different failure response." } },
  ];

  for (const mutation of mutations) {
    const result = applyWorkflowImprovementPatch(wire(parent, [{ op: "replace", step: { ...outside, ...mutation } }],
      [change("replace", [outside.id])]), parent, ["scoped-search"]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "improvement_edit_outside_scope");
  }
});

test("neighbor visibility does not permit removing it or reordering unrelated controls", () => {
  const parent = parentWorkflow();
  const removedNeighbor = applyWorkflowImprovementPatch(wire(parent,
    [{ op: "remove", stepId: "render-summary" }], [change("remove", ["render-summary"])]), parent, ["scoped-search"]);

  assert.equal(removedNeighbor.ok, false);

  if (!removedNeighbor.ok) assert.equal(removedNeighbor.code, "improvement_edit_outside_scope");

  const reordered = applyWorkflowImprovementPatch(wire(parent, [{ op: "reorder", stepIds: [
    "archive-metadata", "capture-goal", "confirm-owner", "scoped-search", "render-summary", "finalize",
  ] }], [change("reorder", ["archive-metadata"])]), parent, ["scoped-search"]);

  assert.equal(reordered.ok, false);

  if (!reordered.ok) assert.equal(reordered.code, "improvement_edit_outside_scope");
});

test("local controls cannot replace quality requirements and the core still rejects a weakened revision", () => {
  const parent = parentWorkflow(), search = parent.proposal.procedure.steps[2]!;
  const replaced = { ...search, action: "Search only after examining a fresh owner receipt." };
  const unauthorized = applyWorkflowImprovementPatch(wire(parent, [{ op: "replace", step: replaced }], undefined,
    { qualityInvariants: ["A weaker standard"] }), parent, [search.id]);

  assert.equal(unauthorized.ok, false);

  if (!unauthorized.ok) assert.equal(unauthorized.code, "invalid_workflow_process_patch");

  const proposal = value(applyWorkflowImprovementPatch(wire(parent, [{ op: "replace", step: replaced }]), parent, [search.id]));
  const weakened = proposedRevision(parent, { ...proposal,
    procedure: { ...proposal.procedure, qualityInvariants: proposal.procedure.qualityInvariants.slice(1) } });

  assert.equal(weakened.ok, false);
  if (!weakened.ok) assert.equal(weakened.code, "improvement_quality_weakened");
});

test("changing only a local title remains unchanged behavior at the core revision boundary", () => {
  const parent = parentWorkflow(), search = parent.proposal.procedure.steps[2]!;
  const proposal = value(applyWorkflowImprovementPatch(wire(parent, [{ op: "replace", step: search }], undefined,
    { name: "A polished title for the same unchanged process" }), parent, [search.id]));
  const revision = proposedRevision(parent, proposal);
  assert.equal(revision.ok, false);
  if (!revision.ok) assert.equal(revision.code, "improvement_unchanged");
});

test("inserted recovery branches require a positive bounded maxAttempts", () => {
  const parent = parentWorkflow(), inserted = probe();

  for (const onFailure of [
    { action: "goto", target: "confirm-owner", reason: "No attempt bound." },
    { action: "goto", target: "confirm-owner", maxAttempts: 0, reason: "Zero attempts is not a retry contract." },
    { action: "goto", target: "confirm-owner", maxAttempts: 17, reason: "This exceeds the bounded retry limit." },
  ]) {
    const result = parseWorkflowImprovementResponse(wire(parent,
      [{ op: "insert", before: "scoped-search", step: { ...inserted, onFailure } }], [change("insert", [inserted.id])]), parent, ["scoped-search"]);
    assert.equal(result.ok, false);
  }

  const accepted = value(parseWorkflowImprovementResponse(wire(parent,
    [{ op: "insert", before: "scoped-search", step: inserted }], [change("insert", [inserted.id])]), parent, ["scoped-search"]));

  assert.deepEqual(accepted.procedure.steps.find(step => step.id === inserted.id)?.onFailure, inserted.onFailure);
});

test("local scope exposes complete incoming and outgoing recovery neighbors of the target", () => {
  const original = parentWorkflow();
  const parent: WorkflowImprovement = { ...original, proposal: { ...original.proposal, procedure: { ...original.proposal.procedure,
    steps: original.proposal.procedure.steps.map(step => step.id === "scoped-search"
      ? { ...step, onFailure: { action: "goto" as const, target: "archive-metadata", maxAttempts: 1, reason: "Reconcile the audit source before retrying this search." } }
      : step.id === "finalize" ? { ...step, onFailure: { action: "goto" as const, target: "scoped-search", maxAttempts: 1, reason: "Recheck source evidence before finalizing." } } : step) } } };
  const scope = value(workflowImprovementEditScope(parent, ["scoped-search"]));
  const context = researchContext(parent);
  const prompt = value(workflowImprovementPrompt({ ...context, opportunity: { ...context.opportunity, affectedStepIds: ["scoped-search"] } }, 24000));
  const body: unknown = JSON.parse(prompt.prompt);
  assert.ok(record(body) && record(body.parent) && record(body.parent.procedure));
  const editable = body.parent.procedure.editableSteps;
  assert.ok(Array.isArray(editable));

  for (const id of ["archive-metadata", "finalize"]) {
    const actual = parent.proposal.procedure.steps.find(step => step.id === id);
    assert.deepEqual(scope.find(step => step.id === id), actual, "recovery IO, check and failure semantics must be fully exposed");
    assert.deepEqual(editable.find(step => record(step) && step.id === id), actual);
  }
});

test("a local rewrite rejects a new dependency on an unexposed parent step", () => {
  const parent = parentWorkflow(), search = parent.proposal.procedure.steps.find(step => step.id === "scoped-search")!;
  const exposed = value(workflowImprovementEditScope(parent, [search.id]));

  assert.equal(exposed.some(step => step.id === "capture-goal"), false);
  const operations = [
    { op: "replace", step: { ...search, dependsOn: [...search.dependsOn, "capture-goal"] } },
    { op: "insert", before: search.id, step: { ...probe(), dependsOn: ["capture-goal"] } },
  ];

  for (const operation of operations) {
    const result = applyWorkflowImprovementPatch(wire(parent, [operation],
      [change(operation.op === "insert" ? "insert" : "replace", [operation.step.id])]), parent, [search.id]);
    assert.equal(result.ok, false, "an outline ID does not expose the remote input/output contract");
    if (!result.ok) assert.equal(result.code, "improvement_edit_unexposed_edge");
  }
});

test("a local rewrite rejects a new recovery jump to an unexposed parent step", () => {
  const parent = parentWorkflow(), search = parent.proposal.procedure.steps.find(step => step.id === "scoped-search")!;

  assert.equal(value(workflowImprovementEditScope(parent, [search.id])).some(step => step.id === "archive-metadata"), false);
  const recovery = { action: "goto" as const, target: "archive-metadata", maxAttempts: 1, reason: "This remote recovery was not supplied in full." };
  const operations = [
    { op: "replace", step: { ...search, onFailure: recovery } },
    { op: "insert", before: search.id, step: { ...probe(), onFailure: recovery } },
  ];

  for (const operation of operations) {
    const result = applyWorkflowImprovementPatch(wire(parent, [operation],
      [change(operation.op === "insert" ? "insert" : "replace", [operation.step.id])]), parent, [search.id]);
    assert.equal(result.ok, false, "a bounded retry cannot justify guessing the hidden destination semantics");
    if (!result.ok) assert.equal(result.code, "improvement_edit_unexposed_edge");
  }
});

test("an editable consumer may retain its existing hidden dependency and recovery edge unchanged", () => {
  const original = parentWorkflow();
  const parent: WorkflowImprovement = { ...original, proposal: { ...original.proposal, procedure: { ...original.proposal.procedure,
    steps: original.proposal.procedure.steps.map(step => step.id !== "render-summary" ? step : { ...step,
      dependsOn: [...step.dependsOn, "capture-goal"], onFailure: { action: "goto" as const, target: "archive-metadata", maxAttempts: 1,
        reason: "Use the existing audit reconciliation path when the summary check fails." } }) } } };
  const consumer = parent.proposal.procedure.steps.find(step => step.id === "render-summary")!;
  const scope = value(workflowImprovementEditScope(parent, ["scoped-search"]));

  assert.ok(scope.some(step => step.id === consumer.id));
  assert.ok(["capture-goal", "archive-metadata"].every(id => !scope.some(step => step.id === id)));
  const proposal = value(applyWorkflowImprovementPatch(wire(parent,
    [{ op: "replace", step: { ...consumer, action: "Render the summary using the fresh checked search evidence." } }],
    [change("replace", [consumer.id])]), parent, ["scoped-search"]));
  const preserved = proposal.procedure.steps.find(step => step.id === consumer.id)!;

  assert.deepEqual(preserved.dependsOn, consumer.dependsOn);
  assert.deepEqual(preserved.onFailure, consumer.onFailure);

  for (const id of ["capture-goal", "archive-metadata"]) assert.deepEqual(proposal.procedure.steps.find(step => step.id === id),
    parent.proposal.procedure.steps.find(step => step.id === id));
});

test("new local nodes may connect to fully exposed neighbors and other nodes inserted in the same patch", () => {
  const parent = parentWorkflow(), search = parent.proposal.procedure.steps.find(step => step.id === "scoped-search")!;
  const first = { ...probe(), id: "probe-current-owner" }, second: WorkflowProcedureStep = { ...probe(), id: "probe-current-snapshot",
    dependsOn: [first.id], onFailure: { action: "goto", target: first.id, maxAttempts: 1, reason: "Repeat only the new owner probe if snapshot evidence changed." } };
  const proposal = value(applyWorkflowImprovementPatch(wire(parent, [
    { op: "insert", before: search.id, step: first }, { op: "insert", before: search.id, step: second },
    { op: "replace", step: { ...search, dependsOn: [second.id] } },
  ], [change("insert", [first.id, second.id]), change("replace", [search.id])]), parent, [search.id]));
  const revised = value(proposedRevision(parent, proposal));

  assert.deepEqual(revised.proposal.procedure.steps.find(step => step.id === first.id)?.dependsOn, ["confirm-owner"]);
  assert.deepEqual(revised.proposal.procedure.steps.find(step => step.id === second.id)?.dependsOn, [first.id]);
  assert.deepEqual(revised.proposal.procedure.steps.find(step => step.id === search.id)?.dependsOn, [second.id]);
  assert.deepEqual(revised.proposal.procedure.steps.find(step => step.id === second.id)?.onFailure, second.onFailure);
});

test("missing local facts may produce abstention without inventing a replacement workflow", () => {
  const result = parseWorkflowImprovementResponse({ abstain: true }, parentWorkflow(), ["scoped-search"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "learning_abstained");
});

function largeChineseParent(): WorkflowImprovement {
  const parent = parentWorkflow(), editable = new Set(value(workflowImprovementEditScope(parent, ["scoped-search"])).map(step => step.id));
  const steps = parent.proposal.procedure.steps.map(step => editable.has(step.id) ? step : { ...step,
    action: "当前无关流程的详细操作与边界说明必须保持不变。".repeat(130) + `UNEXPOSED_END_${step.id}` });

  return value(buildWorkflowImprovement({ opportunity: parent.opportunity, evidence: parent.evidence,
    proposal: { ...parent.proposal, procedure: { ...parent.proposal.procedure, steps,
      qualityInvariants: [...parent.proposal.procedure.qualityInvariants,
        "不得以节省调用为由删除当前质量约束。".repeat(60) + "QUALITY_REQUIREMENT_END"] } } }));
}

function researchContext(parent: WorkflowImprovement): Parameters<WorkflowImprovementModelPort["propose"]>[0] {
  return { opportunity: parent.opportunity, parent, feedback: [],
    evidence: [...parent.evidence, { ref: "receipt:current-context", kind: "context",
      summary: "The task's current owner and output requirements remain authoritative; preserve this complete current fact." }] };
}

function responseModel(response: unknown) {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "response", text: JSON.stringify(response) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };

  return { requests, model: createWorkflowImprovementModel({ provider, model: "test" }) };
}

test("a large Chinese parent fits local wire without copying unrelated bodies or truncating required quality and facts", () => {
  const parent = largeChineseParent(), fullContext = researchContext(parent);
  const localContext = { ...fullContext, opportunity: { ...fullContext.opportunity, affectedStepIds: ["scoped-search"] } };
  const full = workflowImprovementPrompt(fullContext, 24000);
  const local = value(workflowImprovementPrompt(localContext, 24000));

  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.code, "learning_budget_exhausted");

  const body: unknown = JSON.parse(local.prompt);

  assert.ok(record(body) && record(body.parent) && record(body.parent.procedure));
  const procedure = body.parent.procedure;

  assert.equal("steps" in procedure, false);
  assert.deepEqual(procedure.editableSteps, value(workflowImprovementEditScope(parent, ["scoped-search"])));
  assert.deepEqual(procedure.qualityInvariants, parent.proposal.procedure.qualityInvariants);
  assert.deepEqual(procedure.assumptions, parent.proposal.procedure.assumptions);
  assert.deepEqual(procedure.requiredConditions, parent.proposal.procedure.requiredConditions);
  assert.deepEqual(procedure.invalidationSignals, parent.proposal.procedure.invalidationSignals);
  assert.deepEqual(procedure.stopRules, parent.proposal.procedure.stopRules);
  assert.deepEqual(body.evidence, fullContext.evidence);
  assert.deepEqual(local.visibleEvidenceRefs, fullContext.evidence.map(fact => fact.ref));
  assert.ok(Array.isArray(procedure.stepsOutline));
  assert.deepEqual(procedure.stepsOutline.map(step => {
    assert.ok(record(step));
    return step.id;
  }),
    parent.proposal.procedure.steps.map(step => step.id));
  assert.equal(local.prompt.includes("UNEXPOSED_END_"), false);
  assert.ok(local.prompt.includes("QUALITY_REQUIREMENT_END"));
  assert.match(local.instruction, /abstain/);
});

test("a researcher may abstain on the local context and full-parent overflow never starts a provider call", async () => {
  const parent = largeChineseParent(), context = researchContext(parent), fx = responseModel({ abstain: true });
  const full = await fx.model.propose(context, new AbortController().signal, 24000);

  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.code, "learning_budget_exhausted");

  assert.equal(fx.requests.length, 0);
  const scoped = await fx.model.propose({ ...context, opportunity: { ...context.opportunity, affectedStepIds: ["scoped-search"] } },
    new AbortController().signal, 24000);

  assert.equal(scoped.ok, false);
  if (!scoped.ok) assert.equal(scoped.code, "learning_abstained");

  assert.equal(fx.requests.length, 1);
  assert.equal(fx.model.usage().uncertain, false);
});

test("a local wire response cannot cite a fact absent from the supplied visible evidence", async () => {
  const parent = parentWorkflow(), context = researchContext(parent), inserted = probe();
  const patch = wire(parent, [{ op: "insert", before: "scoped-search", step: inserted }], [change("insert", [inserted.id])]);
  const fx = responseModel({ ...patch, diagnosis: { ...parent.proposal.diagnosis, supportingRefs: ["receipt:unexposed-history-detail"] } });
  const result = await fx.model.propose({ ...context, opportunity: { ...context.opportunity, affectedStepIds: ["scoped-search"] } },
    new AbortController().signal, 24000);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "improvement_evidence_unexposed");

  assert.equal(fx.requests.length, 1);
});
