import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { projectWorkflowImprovementEvidence, workflowImprovementPublicData, workflowImprovementContextPublicData } from "./improvement-evidence.js";
import { workflowCheckStatus } from "../runtime/check-receipt.js";
import { contentHashOf } from "../../../../control/hash.js";

const sessionId = "session:projection";

test("canonical central workspace identity is readable without allowing private model reports", () => {
  const frame = (text: string) => ({ ref: `content-issue-context:${contentHashOf(text)}`, text });
  const text = JSON.stringify({ role: "original_problem_content_and_public_model_results_not_verification_or_permissions", scope: "D:\\CC\\project" });
  const context = { opportunity: { task: { scope: "workspace:public" } }, evidence: [], history: [], feedback: [], centralContent: frame(text) };

  assert.equal(workflowImprovementPublicData(context, []), false, "the original native context was rejected as an absolute path");
  assert.equal(workflowImprovementContextPublicData(context, []), true);
  assert.equal(workflowImprovementContextPublicData({ ...context, centralContent: { ref: "content-issue-context:wrong", text } }, []), false);
  assert.equal(workflowImprovementContextPublicData({ ...context, centralContent: frame("password=secret-value") }, []), false);
  assert.equal(workflowImprovementContextPublicData({ ...context, centralContent: frame("private-credential-value") }, ["private-credential-value"]), false);
  assert.equal(workflowImprovementContextPublicData({ ...context, evidence: [{ summary: "D:\\private\\document" }] }, []), false);
  assert.equal(workflowImprovementPublicData({ proposal: { action: "Read D:\\private\\document" } }, []), false);
});

function transcript(sequence: number, turnId: string, payload: JsonObject): SessionRecord {
  return { formatVersion: "1", sequence, type: "transcript_item", sessionId, turnId,
    at: "2026-11-04T00:00:00.000Z", payload: { sequence, ...payload } };
}

function envelope(sequence: number, turnId: string, kind: string, payload: JsonObject, identity: JsonObject = {}): SessionRecord {
  return { formatVersion: "1", sequence, type: "envelope", sessionId, turnId, at: "2026-11-04T00:00:00.000Z",
    payload: { envelope: { sessionId, turnId, producerId: "loop", ...identity, kind, payload } } };
}

function issued(sequence: number, turnId: string, toolCallId: string, name = "run_shell", args: JsonObject = { command: "node check.cjs" }) {
  return envelope(sequence, turnId, "tool_use", { toolCallId, name, arguments: args });
}

test("pending workflow hooks bind only actual unpaired same-turn root issuances and retain repeated IDs across turns", () => {
  const args = { operation: "feedback", report: { useId: "use:actual" } };
  const facts = [
    transcript(1, "unissued", { kind: "tool_call", toolCallId: "phantom", name: "workflow_learning", arguments: args }),
    transcript(2, "old", { kind: "tool_call", toolCallId: "shared", name: "workflow_learning", arguments: args }),
    envelope(3, "old", "tool_use", { toolCallId: "shared", name: "workflow_learning" }),
    issued(4, "current", "shared", "workflow_learning", args),
    envelope(5, "current", "tool_use", { toolCallId: "child", name: "workflow_learning", arguments: args }, { producerId: "child" }),
  ];
  const ambiguous = projectWorkflowImprovementEvidence(facts, sessionId);
  assert.ok(ambiguous.ok);
  assert.deepEqual(ambiguous.value.pendingHooks, [
    { toolCallId: "shared", executionId: `${sessionId}/old`, operation: "feedback", useId: "use:actual" },
    { toolCallId: "shared", executionId: `${sessionId}/current`, operation: "feedback", useId: "use:actual" },
  ]);
  assert.deepEqual(ambiguous.value.evidence, []);
  assert.deepEqual(ambiguous.value.receipts, []);
  const settledOld = projectWorkflowImprovementEvidence([...facts,
    envelope(6, "current", "tool_result", { toolCallId: "shared", status: "succeeded" }, { turnId: "old" }),
    envelope(7, "old", "tool_result", { toolCallId: "shared", status: "succeeded" }),
  ], sessionId);
  assert.ok(settledOld.ok);
  assert.deepEqual(settledOld.value.pendingHooks, [ambiguous.value.pendingHooks?.[1]]);
  assert.deepEqual(settledOld.value.receipts, [], "workflow results never become business receipts");
});

test("shell command failure is distinct from successful transport and never becomes tool-success evidence", () => {
  const projected = projectWorkflowImprovementEvidence([
    issued(1, "turn:a", "check"),
    envelope(2, "turn:a", "tool_result", { toolCallId: "check", status: "succeeded", value: { exitCode: 7 } }),
  ], sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.receipts.length, 1);
  assert.equal(projected.value.receipts[0]?.outcome, "succeeded");
  assert.equal(projected.value.receipts[0]?.checkStatus, "failed");
  assert.equal(projected.value.evidence[0]?.kind, "tool_failure");
  assert.equal(workflowCheckStatus({ status: "succeeded", value: { exitCode: 7 } }), "failed");
  assert.equal(workflowCheckStatus({ status: "failed" }), "failed", "existing workflow consumers retain negative transport evidence");
});

test("unknown exits, cancellation and transport errors do not mint an observed checker verdict", () => {
  const records: SessionRecord[] = [
    issued(1, "turn:a", "missing-exit"),
    envelope(2, "turn:a", "tool_result", { toolCallId: "missing-exit", status: "succeeded", value: {} }),
    issued(3, "turn:a", "cancelled"),
    envelope(4, "turn:a", "tool_result", { toolCallId: "cancelled", status: "cancelled", value: { exitCode: 0 } }),
    issued(5, "turn:a", "unknown"),
    envelope(6, "turn:a", "tool_result", { toolCallId: "unknown", status: "unknown", value: { exitCode: 0 } }),
    issued(7, "turn:a", "transport-error"),
    envelope(8, "turn:a", "tool_result", { toolCallId: "transport-error", status: "failed", message: "shell unavailable" }),
  ];
  const projected = projectWorkflowImprovementEvidence(records, sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.receipts.length, 4);
  assert.ok(projected.value.receipts.every(item => item.checkStatus === undefined));

  for (const id of ["cancelled", "unknown"]) {
    assert.equal(projected.value.evidence.find(item => item.ref.endsWith(`/tool:${id}`))?.kind, "context");
  }

  assert.equal(projected.value.evidence.find(item => item.ref.endsWith("/tool:transport-error"))?.kind, "tool_failure");
});

test("reused call IDs in different turns bind only their own actual tool issuance", () => {
  const projected = projectWorkflowImprovementEvidence([
    issued(1, "turn:old", "shared", "read_file", { path: "old-owner.ts" }),
    issued(2, "turn:new", "shared", "run_shell", { command: "node current-check.cjs" }),
    envelope(3, "turn:old", "tool_result", { toolCallId: "shared", status: "succeeded", output: "old read" }),
    envelope(4, "turn:new", "tool_result", { toolCallId: "shared", status: "succeeded", value: { exitCode: 7 } }),
  ], sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.receipts.length, 2);
  assert.deepEqual(projected.value.receipts.map(item => [item.executionId, item.tool, item.checkStatus]), [
    [`${sessionId}/turn:old`, "read_file", undefined], [`${sessionId}/turn:new`, "run_shell", "failed"],
  ]);
  assert.equal(projected.value.executionId, `${sessionId}/turn:new`);
});

test("late mismatched or foreign results cannot settle or consume the current call", () => {
  const projected = projectWorkflowImprovementEvidence([
    transcript(1, "turn:old", { kind: "tool_call", toolCallId: "shared", name: "read_file", arguments: { path: "old.ts" } }),
    issued(2, "turn:old", "shared", "read_file", { path: "old.ts" }),
    transcript(3, "turn:new", { kind: "tool_call", toolCallId: "shared", name: "run_shell", arguments: { command: "node current-check.cjs" } }),
    envelope(4, "turn:new", "tool_use", { toolCallId: "shared", name: "run_shell" }),
    envelope(5, "turn:new", "tool_result", { toolCallId: "shared", status: "succeeded", value: { exitCode: 0 } }, { turnId: "turn:old" }),
    envelope(6, "turn:new", "tool_result", { toolCallId: "shared", status: "succeeded", value: { exitCode: 0 } }, { sessionId: "session:foreign" }),
    envelope(7, "turn:new", "tool_result", { toolCallId: "shared", status: "succeeded", value: { exitCode: 0 } }, { producerId: "child-worker" }),
    envelope(8, "turn:new", "tool_result", { toolCallId: "shared", status: "succeeded", value: { exitCode: 7 } }),
    envelope(9, "turn:new", "tool_result", { toolCallId: "shared", status: "succeeded", value: { exitCode: 0 } }),
  ], sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.receipts.length, 1);
  assert.equal(projected.value.receipts[0]?.executionId, `${sessionId}/turn:new`);
  assert.equal(projected.value.receipts[0]?.checkStatus, "failed");
  assert.match(projected.value.evidence[0]?.summary ?? "", /node current-check\.cjs/);
  assert.doesNotMatch(JSON.stringify(projected.value), /old\.ts/);
});

test("a transcript proposal without actual tool_use cannot produce an execution receipt", () => {
  const projected = projectWorkflowImprovementEvidence([
    transcript(1, "turn:a", { kind: "tool_call", toolCallId: "proposed", name: "run_shell", arguments: { command: "node proposed.cjs" } }),
    envelope(2, "turn:a", "tool_result", { toolCallId: "proposed", status: "succeeded", value: { exitCode: 0 } }),
  ], sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.receipts.length, 0);
  assert.equal(projected.value.evidence.length, 0);
});

test("public evidence redacts known credentials and secret-shaped input without changing the journal", () => {
  const secret = "fictional-local-credential-for-contract-test";
  const rawInput = `Inspect the result; api_key=placeholder-value; credential ${secret}`;
  const records = [transcript(1, "turn:a", { kind: "user", text: rawInput }),
    issued(2, "turn:a", "inspect", "run_shell", { command: `Write-Output ${secret}` }),
    envelope(3, "turn:a", "tool_result", { toolCallId: "inspect", status: "succeeded", value: { exitCode: 0 },
      output: `password=fictional-output; ${secret}` })];
  const projected = projectWorkflowImprovementEvidence(records, sessionId, [secret]);

  assert.ok(projected.ok);
  const publicJson = JSON.stringify(projected.value);

  assert.equal(publicJson.includes(secret), false);
  assert.equal(publicJson.includes("placeholder-value"), false);
  assert.equal(publicJson.includes("fictional-output"), false);
  assert.equal(records[0]?.payload.text, rawInput);
  assert.equal(workflowImprovementPublicData({ nested: [{ explanation: secret }] }, [secret]), false);
  assert.equal(workflowImprovementPublicData({ nested: [{ explanation: "api_key=placeholder-value" }] }, []), false);
  assert.equal(workflowImprovementPublicData({ explanation: "The scoped query returned no current evidence." }, [secret]), true);
});

test("hidden reasoning and system text never become learning evidence", () => {
  const hidden = "PRIVATE_REASONING_CONTRACT_MARKER";
  const projected = projectWorkflowImprovementEvidence([
    transcript(1, "turn:a", { kind: "user", text: "Find the source owner." }),
    transcript(2, "turn:a", { kind: "assistant_reasoning", blockId: "hidden", text: hidden, redacted: false }),
    transcript(3, "turn:a", { kind: "system", text: "PRIVATE_SYSTEM_CONTRACT_MARKER" }),
    envelope(4, "turn:a", "reasoning_delta", { text: hidden }),
  ], sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.evidence.length, 1);
  assert.equal(projected.value.evidence[0]?.summary, "Find the source owner.");
  assert.doesNotMatch(JSON.stringify(projected.value), /PRIVATE_REASONING_CONTRACT_MARKER|PRIVATE_SYSTEM_CONTRACT_MARKER/);
});

test("a long command and noisy output retain the actual diagnostic tail without exposing credentials", () => {
  const secret = "fictional-tail-credential-for-contract-test";
  const projected = projectWorkflowImprovementEvidence([
    issued(1, "turn:a", "build", "run_shell", { command: `node build.cjs ${"--unchanged-option ".repeat(200)}` }),
    envelope(2, "turn:a", "tool_result", { toolCallId: "build", status: "succeeded", value: { exitCode: 2 },
      output: `Starting build\n${"unrelated progress\n".repeat(200)}${secret}\nFATAL: generated manifest is absent` }),
  ], sessionId, [secret]);

  assert.ok(projected.ok);
  const observation = projected.value.evidence[0];

  assert.equal(observation?.kind, "tool_failure");
  assert.match(observation?.summary ?? "", /FATAL: generated manifest is absent/);
  assert.match(observation?.summary ?? "", /command abbreviated/);
  assert.match(observation?.summary ?? "", /characters omitted/);
  assert.equal(JSON.stringify(projected.value).includes(secret), false);
  assert.ok((observation?.summary.length ?? 0) <= 2048);
});

test("failed messages retain diagnostic tails and public scalar result metadata without copying arbitrary payloads", () => {
  const projected = projectWorkflowImprovementEvidence([
    issued(1, "turn:a", "search", "search", { query: "source owner" }),
    envelope(2, "turn:a", "tool_result", { toolCallId: "search", status: "failed", truncated: true,
      message: `Search progress ${"unrelated progress ".repeat(80)}\nFATAL: result cap reached; narrow the owner scope`,
      value: { totalMatches: 430, truncated: true, exitCode: 3, privateBody: "DO_NOT_COPY_ARBITRARY_VALUE" } }),
  ], sessionId);

  assert.ok(projected.ok);
  const summary = projected.value.evidence[0]!.summary;

  assert.match(summary, /FATAL: result cap reached; narrow the owner scope/);
  assert.match(summary, /"totalMatches":430/);
  assert.match(summary, /"truncated":true/);
  assert.match(summary, /"exitCode":3/);
  assert.doesNotMatch(summary, /DO_NOT_COPY_ARBITRARY_VALUE/);
  assert.ok(summary.length <= 2048);
});

test("an ambiguous repeated issuance cannot reuse a consumed transcript proposal", () => {
  const projected = projectWorkflowImprovementEvidence([
    transcript(1, "turn:a", { kind: "tool_call", toolCallId: "same", name: "run_shell", arguments: { command: "node original.cjs" } }),
    envelope(2, "turn:a", "tool_use", { toolCallId: "same", name: "run_shell" }),
    envelope(3, "turn:a", "tool_use", { toolCallId: "same", name: "run_shell" }),
    envelope(4, "turn:a", "tool_result", { toolCallId: "same", status: "succeeded", value: { exitCode: 0 } }),
  ], sessionId);

  assert.ok(projected.ok);
  assert.equal(projected.value.receipts.length, 0);
});
