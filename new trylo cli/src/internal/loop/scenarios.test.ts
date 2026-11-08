import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCENARIO_NAMES, runScenario, type ScenarioName } from "./scenarios.js";

function expected(name: ScenarioName): { terminal: string; requiredKinds: string[] } {
  return JSON.parse(
    readFileSync(join(process.cwd(), "testdata", "loop", `${name}.json`), "utf8"),
  ) as { terminal: string; requiredKinds: string[] };
}

test("ordinary-stream completes with text", async () => {
  const result = await runScenario("ordinary-stream");
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.envelopes.some((item) => item.kind === "text"), true);
  assert.equal(result.envelopes.some((item) => item.kind === "terminal"), true);
});

test("tool-approve reaches completed after tool result", async () => {
  const result = await runScenario("tool-approve");
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.envelopes.some((item) => item.kind === "approval_requested"), true);
  assert.equal(result.envelopes.some((item) => item.kind === "tool_result"), true);
  assert.equal(result.state.toolCalls["call-1"]?.status, "succeeded");
});

test("approval-deny completes with a model explanation while the denied action never runs", async () => {
  const result = await runScenario("approval-deny");
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.iterations, 2);
  assert.equal(result.state.toolCalls["call-1"]?.status, "denied");
  assert.equal(result.transcript.some(item => item.kind === "tool_result" && item.toolCallId === "call-1"
    && item.outcome === "failed" && item.output.includes("permission_denied")), true);
  assert.equal(result.transcript.some(item => item.kind === "assistant_text"
    && item.text === "The requested call was denied and did not run."), true);
  assert.equal(result.envelopes.some((item) => item.kind === "permission_denied"), true);
  assert.equal(result.envelopes.some((item) => item.kind === "user_cancel"), false);
});

test("tool-fail-repair lets the model finish", async () => {
  const result = await runScenario("tool-fail-repair");

  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.state.toolCalls["call-1"]?.status, "failed");
  assert.equal(
    result.envelopes.some((item) => item.kind === "text" && item.payload.text === "repaired"),
    true,
  );
});

test("streaming-cancel is cancelled", async () => {
  const result = await runScenario("streaming-cancel");
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(result.envelopes.some((item) => item.kind === "user_cancel"), true);
});

test("transport-unknown is unknown not failed", async () => {
  const result = await runScenario("transport-unknown");
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "unknown");
  assert.notEqual(result.state.terminalReason, "failed");
});

test("retry-new-attempt keeps correlation and changes attempt", async () => {
  const result = await runScenario("retry-new-attempt");

  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.state.attempts.length, 2);
  assert.equal(result.state.correlationId, "cor-1");
  assert.notEqual(result.state.attempts[0]?.attemptId, result.state.attempts[1]?.attemptId);
  assert.equal(result.envelopes.some((item) => item.kind === "api_retry"), true);
});

test("completed-unverified keeps both facts", async () => {
  const result = await runScenario("completed-unverified");

  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.state.verification.status, "fail");
  assert.equal(
    result.envelopes.some((item) => item.kind === "observation" || item.kind === "check_result"),
    true,
  );
});

test("all eight scenarios match testdata/loop fixtures", async () => {
  assert.equal(SCENARIO_NAMES.length, 8);
  for (const name of SCENARIO_NAMES) {
    const result = await runScenario(name);
    const want = expected(name);

    assert.equal(result.state.phase, "terminal", name);
    assert.equal(result.state.terminalReason, want.terminal, name);
    const kinds = new Set(result.envelopes.map((item) => item.kind));

    for (const kind of want.requiredKinds) {
      assert.equal(kinds.has(kind), true, `${name} missing ${kind}`);
    }
  }
});
