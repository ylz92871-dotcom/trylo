import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowLearningRequest, WorkflowTrace } from "./trace-contracts.js";
import { compileWorkflow, learnWorkflow } from "./trace-learn.js";
import { parseWorkflowLearningArtifact, parseWorkflowLearningRequest, parseWorkflowTrace } from "./trace-parse.js";

const task = { scope: "project:reports", taskFamily: { id: "report", intentClass: "build_report", checkKind: "acceptance" as const } };

function trace(id: string, format: string, check: string, outcome: "success" | "failure" = "success"): WorkflowTrace {
  return Object.assign({ ...task, schemaVersion: 1 as const, traceId: id, source: "imported" as const, outcome,
    steps: [{ nodeId: "read", input: "input", output: "rows", dependsOn: [], check: "node check-read.cjs", status: "passed" as const, evidenceRefs: [`${id}:read`] },
      { nodeId: "build", input: "rows", output: "report", dependsOn: ["read"], check, status: outcome === "success" ? "passed" as const : "failed" as const, evidenceRefs: [`${id}:build`] }] },
    { conditions: { format }, conditionEvidenceRefs: [`${id}:format`] });
}

function request(traces: readonly WorkflowTrace[]): WorkflowLearningRequest {
  return { ...task, requestId: "v2", subsystem: "workflow", collect: true,
    budget: { maxEpisodes: 32, maxSteps: 256, maxTokens: 30000 }, traces };
}

test("condition branches preserve supported graphs and reject unknown task premises", () => {
  const learned = learnWorkflow(request([trace("csv", "csv", "node check-csv.cjs"), trace("json", "json", "node check-json.cjs")]));

  assert.ok(learned.ok);
  assert.equal(learned.value.schemaVersion, 2);
  assert.equal(learned.value.branches?.length, 2);
  assert.equal(compileWorkflow(learned.value, Object.assign({ ...task }, { conditions: { format: "xml" } }), 30000).ok, false);
  const csv = compileWorkflow(learned.value, Object.assign({ ...task }, { conditions: { format: "csv" } }), 30000);

  assert.ok(csv.ok);
  assert.match(csv.value, /check-csv/);
  assert.doesNotMatch(csv.value, /check-json/);
});

test("measured failure feedback replaces the latest costly candidate with a supported better graph", () => {
  const good = trace("good", "csv", "node fast.cjs");
  const slow = trace("slow", "csv", "node slow.cjs");
  const failed = trace("failed", "csv", "node slow.cjs", "failure");
  const learned = learnWorkflow(request([good, failed, slow]));

  assert.ok(learned.ok);
  assert.equal(learned.value.nodes.find(node => node.id === "build")?.check, "node fast.cjs");
  assert.equal(learned.value.learning?.stopReason, "stable");
});

test("learning nomination bounds internal rounds rather than silently ignoring them", () => {
  const raw = request([trace("s", "csv", "node check-csv.cjs")]);
  assert.equal(parseWorkflowLearningRequest({ ...raw, budget: { ...raw.budget, maxRounds: 0 } }).ok, false);
});

test("a declared upstream artifact binding cannot disagree with the passed output", () => {
  const original = trace("binding", "csv", "node check-csv.cjs");
  const step = original.steps[1]!;
  assert.equal(parseWorkflowTrace({ ...original, steps: [original.steps[0], { ...step, inputBindings: { read: "unrelated-output" } }] }).ok, false);
});

test("measured lower cost selects a different supported topology", () => {
  const good = { ...trace("short", "csv", "node build.cjs"), cost: { tokens: 100, wallMs: 10 } };
  const original = trace("long", "csv", "node build.cjs");
  const slow: WorkflowTrace = { ...original, cost: { tokens: 800, wallMs: 80 }, steps: [original.steps[0]!,
    { nodeId: "normalize", input: "rows", output: "normalized", dependsOn: ["read"], check: "node normalize.cjs", status: "passed", evidenceRefs: ["long:normalize"] },
    { ...original.steps[1]!, dependsOn: ["normalize"], input: "normalized" }] };
  const learned = learnWorkflow(request([good, slow]));

  assert.ok(learned.ok);
  assert.equal(learned.value.nodes.length, 2);
  assert.equal(learned.value.branches?.[0]?.statistics.totalTokens, 100);
  assert.equal(learned.value.learning?.changes.some(change => change.round === 2), true);
});

test("a condition counterexample blocks the superficial generic resemblance", () => {
  const learned = learnWorkflow(request([trace("csv", "csv", "node csv.cjs"), trace("json-fail", "json", "node json.cjs", "failure")]));
  assert.ok(learned.ok);
  assert.equal(compileWorkflow(learned.value, { ...task, conditions: { format: "json" } }, 30000).ok, false);
  assert.equal(compileWorkflow(learned.value, { ...task, conditions: { format: "csv" } }, 30000).ok, true);
});

test("explicit correction changes only its evidenced condition scope", () => {
  const learned = learnWorkflow({ ...request([trace("csv", "csv", "node csv.cjs"), trace("json", "json", "node json.cjs")]),
    parentVersionId: "previous", correction: { reason: "CSV needs UTF8 check", nodeId: "build", check: "node csv-utf8.cjs", when: { format: "csv" } } });

  assert.ok(learned.ok);
  const csv = compileWorkflow(learned.value, { ...task, conditions: { format: "csv" } }, 30000);
  const json = compileWorkflow(learned.value, { ...task, conditions: { format: "json" } }, 30000);

  assert.ok(csv.ok && json.ok);
  assert.match(csv.value, /csv-utf8/);
  assert.match(json.value, /node json.cjs/);
  assert.doesNotMatch(json.value, /csv-utf8/);
});

test("resumed cumulative snapshots count as one execution, with superseded evidence retained", () => {
  const first: WorkflowTrace = { ...trace("partial", "csv", "node csv.cjs", "failure"), source: "runtime", sessionId: "same", workflowVersionId: "v1" };
  const latest: WorkflowTrace = { ...trace("finished", "csv", "node csv.cjs"), source: "runtime", sessionId: "same", workflowVersionId: "v1", cost: { tokens: 250, wallMs: 25 } };
  const learned = learnWorkflow(request([first, latest]));

  assert.ok(learned.ok);
  assert.equal(learned.value.branches?.[0]?.statistics.samples, 1);
  assert.equal(learned.value.branches?.[0]?.statistics.totalTokens, 250);
  assert.deepEqual(learned.value.learning?.supersededTraceIds, ["partial"]);
  assert.equal(learned.value.traces.length, 2);
});

test("persisted branch statistics cannot be changed without execution evidence", () => {
  const learned = learnWorkflow(request([trace("s", "csv", "node csv.cjs")]));
  assert.ok(learned.ok);
  assert.equal(parseWorkflowLearningArtifact({ ...learned.value, branches: [] }).ok, false);
});

test("one allowed internal round stops visibly with a supported provisional candidate", () => {
  const raw = request([trace("s", "csv", "node csv.cjs")]);
  const learned = learnWorkflow({ ...raw, budget: { ...raw.budget, maxRounds: 1 } });
  assert.ok(learned.ok);
  assert.equal(learned.value.learning?.rounds, 1);
  assert.equal(learned.value.learning?.stopReason, "round_limit");
});

test("conditions require a source reference and supported bindings survive normalization", () => {
  const original = trace("bound", "csv", "node csv.cjs");

  assert.equal(parseWorkflowTrace({ ...original, conditionEvidenceRefs: [] }).ok, false);
  const digest = "a".repeat(64);
  const parsed = parseWorkflowTrace({ ...original, steps: [original.steps[0], { ...original.steps[1], inputBindings: { read: "rows" }, outputDigest: digest }] });

  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.steps[1]?.inputBindings, { read: "rows" });
  assert.equal(parsed.value.steps[1]?.outputDigest, digest);
});

test("cheap incomplete attempts cannot lower the cost of an expensive path", () => {
  const good = { ...trace("good", "csv", "node fast.cjs"), cost: { tokens: 100, wallMs: 10 } };
  const expensive = { ...trace("expensive", "csv", "node slow.cjs"), cost: { tokens: 200, wallMs: 20 } };
  const partial: WorkflowTrace = { ...trace("unfinished", "csv", "node slow.cjs"), outcome: "unknown", cost: { tokens: 0, wallMs: 0 } };
  const learned = learnWorkflow(request([good, expensive, partial]));
  assert.ok(learned.ok);
  assert.equal(learned.value.nodes.find(node => node.id === "build")?.check, "node fast.cjs");
});

test("an old trace missing a newly discovered condition cannot bypass the exception", () => {
  const old = trace("old", "csv", "node csv.cjs");
  const { conditions: _conditions, conditionEvidenceRefs: _refs, ...generic } = old;
  const learned = learnWorkflow(request([generic, trace("json-fail", "json", "node json.cjs", "failure")]));
  assert.ok(learned.ok);
  assert.equal(compileWorkflow(learned.value, task, 30000).ok, false);
  assert.equal(compileWorkflow(learned.value, { ...task, conditions: { format: "xml" } }, 30000).ok, false);
});
