import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowObservedTurn } from "./model-port.js";
import { bindWorkflowProposal, observeWorkflowTurn, workflowObservationWatermark } from "./raw-facts.js";

const task = { scope: "project-a", taskFamily: { id: "bundle", intentClass: "build", checkKind: "acceptance" as const } };

function envelope(sequence: number, kind: string, payload: JsonObject, identity: JsonObject = {}): SessionRecord {
  return { formatVersion: "1", sequence, type: "envelope", sessionId: "s", turnId: "t", at: "2026-11-03T00:00:00.000Z",
    payload: { envelope: { sessionId: "s", turnId: "t", producerId: "loop", ...identity, kind, payload } } };
}

const observed: WorkflowObservedTurn = { sessionId: "s", turnId: "t", terminal: "completed", tokens: 20, wallMs: 5,
  checks: [{ toolCallId: "a", command: "node check-a.cjs", status: "passed", evidenceRef: "receipt-a", sequence: 3 },
    { toolCallId: "b", command: "node check-b.cjs", status: "passed", evidenceRef: "receipt-b", sequence: 6 }],
  mutations: [{ toolCallId: "wa", path: "a.json", evidenceRef: "write-a", sequence: 1 },
    { toolCallId: "wb", path: "b.json", evidenceRef: "write-b", sequence: 4 }] };

test("model dependencies cannot claim an unrelated input as the upstream product", () => {
  const result = bindWorkflowProposal(task, observed, { steps: [
    { nodeId: "a", input: "source.csv", output: "a.json", dependsOn: [], checkToolCallId: "a" },
    { nodeId: "b", input: "unrelated.json", output: "b.json", dependsOn: ["a"], checkToolCallId: "b" },
  ] });
  assert.equal(result.ok, false);
});

test("foreign envelope identities cannot manufacture a current session checker", () => {
  const result = observeWorkflowTurn([
    envelope(0, "tool_use", { toolCallId: "c", name: "run_shell", arguments: { command: "node check.cjs" } }, { turnId: "foreign" }),
    envelope(1, "tool_result", { toolCallId: "c", status: "succeeded", value: { exitCode: 0 } }, { turnId: "foreign" }),
  ], "t");
  assert.ok(result.ok);
  assert.equal(result.value.checks.length, 0);
});

test("old envelopes may recover arguments only from the same transcript tool name", () => {
  const item: SessionRecord = { formatVersion: "1", sequence: 0, type: "transcript_item", sessionId: "s", turnId: "t",
    at: "2026-11-03T00:00:00.000Z", payload: { kind: "tool_call", sequence: 0, toolCallId: "c", name: "read_file", arguments: { command: "node spoof.cjs" } } };
  const result = observeWorkflowTurn([item,
    envelope(1, "tool_use", { toolCallId: "c", name: "run_shell" }),
    envelope(2, "tool_result", { toolCallId: "c", status: "succeeded", value: { exitCode: 0 } }),
  ], "t");

  assert.ok(result.ok);
  assert.equal(result.value.checks.length, 0);
});

test("inspection commands need no fabricated product while failed operations remain negative evidence", () => {
  const inspect = { toolCallId: "inspect", command: "node --version", status: "passed" as const, evidenceRef: "inspection", sequence: 0 };
  const actual = { ...observed, checks: [inspect, observed.checks[0]!] };
  const proposal = { steps: [{ nodeId: "a", input: "source.csv", output: "a.json", dependsOn: [], checkToolCallId: "a" }],
    excludedCalls: [{ toolCallId: "inspect", role: "inspection" as const, reason: "identify the installed runtime" }] };
  const accepted = bindWorkflowProposal(task, actual, proposal);

  assert.ok(accepted.ok);
  assert.equal(accepted.value.outcome, "success");
  const failed = bindWorkflowProposal(task, { ...actual, checks: [{ ...inspect, status: "failed" }, observed.checks[0]!] }, proposal);

  assert.ok(failed.ok);
  assert.equal(failed.value.outcome, "failure");
  assert.equal(failed.value.otherFailures?.[0]?.toolCallId, "inspect");
});

test("a shell-created output can be grounded by a real readback before its check", () => {
  const result = bindWorkflowProposal(task, { ...observed, mutations: [], checks: [observed.checks[0]!],
    artifacts: [{ toolCallId: "readback", path: "a.json", evidenceRef: "readback-ref", sequence: 2 }] },
  { steps: [{ nodeId: "a", input: "source.csv", output: "a.json", dependsOn: [], checkToolCallId: "a" }] });
  assert.ok(result.ok);
  assert.equal(result.value.outcome, "success");
});

test("a new interrupted turn never borrows a previous completed task's facts", () => {
  const prior: SessionRecord = { formatVersion: "1", sequence: 0, type: "terminal", sessionId: "s", turnId: "old", at: "2026-11-03T00:00:00.000Z", payload: { reason: "completed" } };
  const current: SessionRecord = { ...prior, sequence: 1, type: "turn_start", turnId: "new", payload: {} };
  const result = observeWorkflowTurn([prior, current]);
  assert.ok(result.ok);
  assert.equal(result.value.turnId, "new");
  assert.equal(result.value.terminal, "unknown");
  assert.equal(workflowObservationWatermark([prior, current], "old"), 0);
});

test("post-terminal learning metadata does not move the source evidence watermark", () => {
  const terminal: SessionRecord = { formatVersion: "1", sequence: 10, type: "terminal", sessionId: "s", turnId: "t", at: "2026-11-03T00:00:00.000Z", payload: { reason: "completed" } };
  const metadata: SessionRecord = { ...terminal, sequence: 11, type: "execution_extension", payload: {} };
  assert.equal(workflowObservationWatermark([terminal, metadata], "t"), 10);
  const later = { ...metadata, at: "2026-11-03T01:00:00.000Z" };
  const before = observeWorkflowTurn([terminal]), after = observeWorkflowTurn([terminal, later]);
  assert.ok(before.ok && after.ok);
  assert.deepEqual(after.value, before.value);
});

test("missing terminal usage is unknown evidence, while an explicit zero usage remains a measured zero", () => {
  const record: SessionRecord = { formatVersion: "1", sequence: 0, type: "terminal", sessionId: "s", turnId: "t", at: "2026-11-03T00:00:00.000Z", payload: { reason: "completed" } };
  const missing = observeWorkflowTurn([record]);
  assert.ok(missing.ok);
  assert.equal(missing.value.usageUncertain, true);
  const known = observeWorkflowTurn([{ ...record, payload: { reason: "completed", usage: { totalTokens: 0 } } }]);

  assert.ok(known.ok);
  assert.equal(known.value.usageUncertain, undefined);
  assert.equal(known.value.tokens, 0);
  const proposal = { steps: [{ nodeId: "a", input: "source.csv", output: "a.json", dependsOn: [], checkToolCallId: "a" }] };
  const unknown = bindWorkflowProposal(task, { ...observed, checks: [observed.checks[0]!], usageUncertain: true }, proposal);
  const zero = bindWorkflowProposal(task, { ...observed, checks: [observed.checks[0]!], tokens: 0 }, proposal);

  assert.ok(unknown.ok && zero.ok);
  assert.equal(unknown.value.cost, undefined);
  assert.equal(zero.value.cost?.tokens, 0);
});
