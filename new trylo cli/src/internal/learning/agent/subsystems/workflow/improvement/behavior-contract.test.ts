import assert from "node:assert/strict";
import test from "node:test";
import { hostCompleteSearchProcessEvidence, improvementFeedbackFixture, searchImprovementFixture,
  sourceNavigationProcess } from "../testing/improvement-fixtures.js";
import { buildWorkflowImprovement, compileWorkflowImprovement, parseWorkflowImprovement, parseWorkflowImprovementFeedback } from "./index.js";
import type { WorkflowImprovement, WorkflowProcessTask } from "./contracts.js";

function proposedSearch(): WorkflowImprovement {
  const result = buildWorkflowImprovement(searchImprovementFixture());
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result.value;
}

test("cold-start improvement can prescribe an unobserved procedure while retaining its unproven diagnosis", () => {
  const artifact = proposedSearch();

  assert.equal(artifact.claim, "proposed_improvement");
  assert.equal(artifact.evidence.some(item => item.kind === "tool_success"), false);
  const dispatch = compileWorkflowImprovement(artifact, artifact.opportunity.task, 32_768);
  if (!dispatch.ok) assert.fail(dispatch.message);

  assert.match(dispatch.value, /Search independent symbols together within the confirmed owner directory/);
  assert.match(dispatch.value, /Cause hypothesis \(unproven\)/);
  assert.match(dispatch.value, /owner_confirmed/);
  assert.match(dispatch.value, /Unknown or contradicted premises require a fresh probe or replan/);
});

test("one explicit user correction can seed a procedure without pretending it has successful executions", () => {
  const fixture = searchImprovementFixture(), correctionRef = "user:batch-independent-searches";
  const result = buildWorkflowImprovement({
    opportunity: { ...fixture.opportunity, trigger: "user_correction", evidenceRefs: [correctionRef],
      problem: "The user corrected repeated whole-repository searches.",
      desiredOutcome: "Confirm the owner, then batch independent searches while keeping complete evidence." },
    evidence: [{ ref: correctionRef, kind: "user_correction",
      summary: "After finding the owner, batch independent symbol queries there and preserve the source-evidence checks." }],
    proposal: { ...fixture.proposal,
      diagnosis: { ...fixture.proposal.diagnosis, supportingRefs: [correctionRef] },
      changes: fixture.proposal.changes.map(change => ({ ...change, evidenceRefs: [correctionRef] })) },
  });
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);

  assert.equal(result.value.claim, "proposed_improvement");
  assert.equal(result.value.evidence.length, 1);
  assert.equal(result.value.evidence[0]!.kind, "user_correction");
  const dispatch = compileWorkflowImprovement(result.value, result.value.opportunity.task, 32_768);
  if (!dispatch.ok) assert.fail(dispatch.message);

  assert.match(dispatch.value, /observed quality 0 passed\/0 failed/);
  assert.match(dispatch.value, /Results are complete and support the requested conclusion/);
});

test("retitling, renaming steps and rewriting a diagnosis do not count as changing the workflow", () => {
  const parent = proposedSearch(), fixture = searchImprovementFixture();
  const ids = new Map([["confirm-owner", "renamed-a"], ["scoped-search", "renamed-b"]]);
  const cosmetic = {
    ...fixture.proposal,
    diagnosis: { ...fixture.proposal.diagnosis, hypothesis: "This is a more polished explanation of the same problem." },
    procedure: { ...fixture.proposal.procedure, name: "An impressive new workflow name",
      steps: fixture.proposal.procedure.steps.map(step => ({ ...step, id: ids.get(step.id)!,
        dependsOn: step.dependsOn.map(id => ids.get(id)!) })) },
    changes: fixture.proposal.changes.map(change => ({ ...change, stepIds: change.stepIds.map(id => ids.get(id)!) })),
  };
  const result = buildWorkflowImprovement({ ...fixture, proposal: cosmetic, parent, parentVersionId: "workflow:parent" });

  assert.equal(result.ok, false);

  if (!result.ok) assert.equal(result.code, "improvement_unchanged");
});

test("a refuted search explanation can lead to a different diagnostic action without inventing proof", () => {
  const parent = proposedSearch(), fixture = searchImprovementFixture();
  const probe = { ...fixture.proposal.procedure.steps[0]!,
    action: "Check the current generator receipt before searching for an output that may not exist yet.",
    inputs: ["generator receipt", "requested output"], outputs: ["whether the requested output exists"],
    verify: "The current generator receipt establishes that the output was created." };
  const search = { ...fixture.proposal.procedure.steps[1]!,
    action: "Locate symbols in the requested output after its existence is established.",
    inputs: ["whether the requested output exists", "requested symbols"], dependsOn: [probe.id],
    when: { fact: "output_created", equals: "yes" } };
  const result = buildWorkflowImprovement({ ...fixture, parent, parentVersionId: "workflow:parent",
    evidence: [...fixture.evidence,
      { ref: "receipt:not-created", kind: "tool_failure", summary: "The searched output is absent after a generator failure." },
      { ref: "receipt:creation-report", kind: "tool_success", summary: "An earlier generator receipt reports that output creation succeeded." }],
    proposal: { ...fixture.proposal,
      diagnosis: { hypothesis: "The repeated search is caused by an output that was never created.",
        supportingRefs: ["receipt:not-created"], counterEvidenceRefs: ["receipt:creation-report"],
        alternatives: ["A generated output may have moved after creation."],
        discriminateBy: ["Inspect the current generator receipt and output existence before selecting a search scope."] },
      procedure: { ...fixture.proposal.procedure, steps: [probe, search] },
      changes: [{ ...fixture.proposal.changes[0]!, kind: "replace", stepIds: [probe.id, search.id],
        before: fixture.proposal.procedure.steps[0]!.action, after: probe.action, evidenceRefs: ["receipt:not-created"] }] } });
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);

  assert.deepEqual(result.value.proposal.diagnosis.counterEvidenceRefs, ["receipt:creation-report"]);
  assert.equal(result.value.claim, "proposed_improvement");
  const dispatch = compileWorkflowImprovement(result.value, result.value.opportunity.task, 32_768);
  if (!dispatch.ok) assert.fail(dispatch.message);

  assert.match(dispatch.value, /Check the current generator receipt before searching/);
  assert.match(dispatch.value, /Cause hypothesis \(unproven\)/);
  assert.match(dispatch.value, /An earlier generator receipt reports that output creation succeeded/);
});

test("a speed-oriented revision cannot silently delete a parent's necessary quality invariant", () => {
  const parent = proposedSearch(), fixture = searchImprovementFixture();
  const result = buildWorkflowImprovement({ ...fixture, parent, parentVersionId: "workflow:parent",
    proposal: { ...fixture.proposal,
      procedure: { ...fixture.proposal.procedure,
        qualityInvariants: [fixture.proposal.procedure.qualityInvariants[0]!],
        steps: fixture.proposal.procedure.steps.map(step => step.id === "scoped-search"
          ? { ...step, action: "Return the first available search hit immediately." } : step) },
      changes: [{ ...fixture.proposal.changes[0]!, kind: "replace", stepIds: ["scoped-search"],
        before: "Gather complete evidence for the conclusion.", after: "Return the first hit to reduce time.",
        expectedEffect: "Lower the number of search calls." }] } });

  assert.equal(result.ok, false);
});

test("reuse requires the supported scope, complete family and observed applicability conditions", () => {
  const artifact = proposedSearch(), task = artifact.opportunity.task;
  const { process: sourceProcess, ...legacyTask } = task;

  assert.ok(sourceProcess);
  const compatible = compileWorkflowImprovement(artifact, { ...task,
    conditions: { evidenceMode: "read_only", repoLayout: "monorepo-v1" } }, 32_768);

  assert.equal(compatible.ok, true);
  const incompatible = [
    { ...task, conditions: { evidenceMode: "read_only" } },
    { ...task, conditions: { ...task.conditions, repoLayout: "moved-layout-v2" } },
    { ...task, conditions: { ...task.conditions, taskSize: "unknown-scale" } },
    { ...task, scope: "repo:other-project" },
    { ...legacyTask, taskFamily: { ...task.taskFamily, language: "python" } },
    { ...legacyTask, taskFamily: { ...task.taskFamily, checkSchema: "different-evidence-standard" } },
  ];

  for (const current of incompatible) {
    const result = compileWorkflowImprovement(artifact, current, 32_768);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "improvement_not_applicable");
  }
});

test("the same read-only process can support another business family without crossing effect or check contracts", () => {
  const artifact = proposedSearch(), task = artifact.opportunity.task, process = sourceNavigationProcess();
  const otherBusiness: WorkflowProcessTask = { ...task,
    taskFamily: { id: "api-change", intentClass: "change_api", checkKind: "unit_test", language: "typescript" }, process };
  const reuse = compileWorkflowImprovement(artifact, otherBusiness, 32_768);

  assert.equal(reuse.ok, true);
  const incompatible: readonly WorkflowProcessTask[] = [
    { ...otherBusiness, scope: "repo:another-workspace" },
    { ...otherBusiness, process: { ...process, inputContract: "remote project not present in this snapshot" } },
    { ...otherBusiness, process: { ...process, outputContract: "modified source files rather than evidence" } },
    { ...otherBusiness, process: { ...process, sideEffects: "local_artifact" } },
    { ...otherBusiness, process: { ...process, sideEffects: "external" } },
    { ...otherBusiness, process: { ...process, checkContract: "compile succeeds without completeness evidence" } },
  ];

  for (const current of incompatible) assert.equal(compileWorkflowImprovement(artifact, current, 32_768).ok, false);

  const { process: omitted, ...noProcess } = otherBusiness;

  assert.ok(omitted);
  assert.equal(compileWorkflowImprovement(artifact, noProcess, 32_768).ok, false);
});

test("a new proposal cannot silently discard a current condition to look more general", () => {
  const fixture = searchImprovementFixture();
  const result = buildWorkflowImprovement({ ...fixture, proposal: { ...fixture.proposal,
    procedure: { ...fixture.proposal.procedure, requiredConditions: { evidenceMode: "read_only" } } } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "improvement_conditions_weakened");
});

test("opportunities and explanations bind host evidence instead of fabricating repetition or user corrections", () => {
  const fixture = searchImprovementFixture();
  const invented = buildWorkflowImprovement({ ...fixture, proposal: { ...fixture.proposal,
    diagnosis: { ...fixture.proposal.diagnosis, supportingRefs: ["receipt:invented-success"] } } });

  assert.equal(invented.ok, false);
  const noCorrection = buildWorkflowImprovement({ ...fixture,
    opportunity: { ...fixture.opportunity, trigger: "user_correction" } });

  assert.equal(noCorrection.ok, false);
  const oneObservation = buildWorkflowImprovement({ ...fixture,
    opportunity: { ...fixture.opportunity, evidenceRefs: ["receipt:search-1"] } });

  assert.equal(oneObservation.ok, false);
  const duplicateFact = parseWorkflowImprovement({ ...proposedSearch(), evidence: [...fixture.evidence, fixture.evidence[0]!] });

  assert.equal(duplicateFact.ok, false);
});

test("enumerating all model-reported step IDs cannot replace a host process checker and actual receipts", () => {
  const complete = hostCompleteSearchProcessEvidence();
  for (const processEvidence of [
    { kind: "complete", checkedStepIds: ["confirm-owner", "scoped-search"], skippedStepIds: [] },
    { ...complete, checkerRef: "" },
    { ...complete, evidenceRefs: [] },
    { ...complete, checkedStepIds: [], skippedStepIds: ["confirm-owner", "scoped-search"] },
  ]) {
    const report = { ...improvementFeedbackFixture(), processEvidence };
    assert.equal(parseWorkflowImprovementFeedback(report).ok, false);
  }
});
