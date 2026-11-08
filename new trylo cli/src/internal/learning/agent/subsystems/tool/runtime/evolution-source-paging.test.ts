import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolRunnerPort } from "../../../../../ports/tool-runner-port.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { ToolEvolutionVerifier } from "../domain/evolution/verification.js";
import { createToolEvolutionRuntime } from "./evolution-runtime.js";

const priorSource = `/*${"padding ".repeat(3500)}*/\nmodule.exports = input => input * 2;`;
const request: ToolEvolutionRequest = { schemaVersion: 1, requestId: "large-parent", scope: "test", capability: "double", operation: "improve", maxAttempts: 1,
  prior: { versionId: "frozen-parent", source: priorSource }, evidence: [
    { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } },
    { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
    { sampleId: "hidden", role: "variation", input: "HELDOUT_INPUT_SECRET", expected: { kind: "value", value: "HELDOUT_EXPECTED_SECRET" } },
    { sampleId: "bad", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
  ] };
const patch = { identity: "double", description: "TEST ONLY paging contract", inputSchema: { type: "number" },
  mastery: { whenToUse: ["TEST ONLY · double a numeric input"], preconditions: [], pitfalls: [] }, sourcePatch: { baseContentHash: contentHashOf(priorSource),
    edits: [{ search: "input * 2", replace: "input + input" }] } };

function fixture(respond: (call: number, prompt: string) => unknown, callsAllowed = 4) {
  const prompts: string[] = [];
  let calls = 0, verified = 0, saved = 0;
  const worker: ToolRunnerPort = { submit: async task => {
    prompts.push(String(task.input.prompt));
    return { taskId: task.taskId };
  },
    wait: async taskId => ({ taskId, status: "completed", observed: "terminal", output: JSON.stringify(respond(++calls, prompts.at(-1)!)) }),
    cancel: async () => true, status: async () => "completed", onProgress: () => () => {} };
  const verifier: ToolEvolutionVerifier = { verify: async (candidate, frozen) => { verified++;
  return { verdict: "pass", candidateHash: contentHashOf(candidate),
    samplesHash: contentHashOf(frozen.evidence), checks: frozen.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "TEST ONLY contract binding" })) }; } };
  const options = { runner: worker, verifier, archive: { save: async () => {
    saved++;
    return { ok: true as const, proposalId: "test-proposal", versionId: "test-version" };
  } }, now: () => 0,
    generationAllowance: async () => ({ callsRemaining: callsAllowed - calls, tokensRemaining: 48000, maxPromptChars: 24000 }) };

  return { options, prompts, facts: () => ({ calls, verified, saved }) };
}

test("a funded generator pages exact frozen parent bytes, then sourcePatch yields a complete verified artifact without exposing held-out oracle", async () => {
  const fx = fixture((call, prompt) => {
    assert.ok(prompt.length < 24000);
    assert.ok(!prompt.includes("HELDOUT_INPUT_SECRET") && !prompt.includes("HELDOUT_EXPECTED_SECRET"));
    if (call === 1) {
      assert.ok(!prompt.includes("module.exports = input => input * 2;"));
      return { action: "read_parent", baseContentHash: contentHashOf(priorSource), offset: 26000 };
    }
    assert.ok(prompt.includes("module.exports = input => input * 2;"));
    return patch;
  });
  const result = await createToolEvolutionRuntime(fx.options).evolve(request, new AbortController().signal);

  assert.equal(result.kind, "candidate");
  if (result.kind !== "candidate") assert.fail(JSON.stringify(result));

  assert.equal(result.attempts, 1, "read decisions are not verification/repair attempts");
  assert.equal(result.artifact.request.prior?.source, priorSource);
  assert.equal(result.artifact.candidate.source, priorSource.replace("input * 2", "input + input"));
  assert.deepEqual(fx.facts(), { calls: 2, verified: 1, saved: 1 });
});

test("a duplicate source read closes investigation but retains a final candidate decision from the original allowance", async () => {
  const fx = fixture((call, prompt) => {
    if (call === 1) return { action: "read_parent", baseContentHash: contentHashOf(priorSource), offset: 0 };
    assert.ok(prompt.includes('"reason":"no_new_source"'));
    return patch;
  });
  const result = await createToolEvolutionRuntime(fx.options).evolve(request, new AbortController().signal);
  assert.equal(result.kind, "candidate");
  assert.deepEqual(fx.facts(), { calls: 2, verified: 1, saved: 1 });
});

test("the last funded call cannot be diverted into another read, and a stale hash never reaches verification", async () => {
  const closed = fixture((_call, prompt) => { assert.ok(prompt.includes('"reason":"reserved_call"'));
    return { action: "read_parent", baseContentHash: contentHashOf(priorSource), offset: 26000 }; }, 1);
  const first = await createToolEvolutionRuntime(closed.options).evolve(request, new AbortController().signal);

  assert.equal(first.kind, "failed");
  if (first.kind === "failed") assert.equal(first.code, "parent_source_read_closed");

  assert.deepEqual(closed.facts(), { calls: 1, verified: 0, saved: 0 });
  const stale = fixture(() => ({ action: "read_parent", baseContentHash: "0".repeat(64), offset: 26000 }));
  const second = await createToolEvolutionRuntime(stale.options).evolve(request, new AbortController().signal);

  assert.equal(second.kind, "failed");
  if (second.kind === "failed") assert.equal(second.code, "parent_source_hash_mismatch");

  assert.deepEqual(stale.facts(), { calls: 1, verified: 0, saved: 0 });
});

test("mandatory public oracle cannot be truncated to fit, and the unfunded manual path retains its old full-source single-call contract", async () => {
  const fx = fixture(() => patch);
  const oversized = await createToolEvolutionRuntime(fx.options).evolve({ ...request, evidence: request.evidence.map((sample, index) =>
    index < 2 ? { ...sample, input: String(index).repeat(12000) } : sample) }, new AbortController().signal);

  assert.equal(oversized.kind, "failed");
  if (oversized.kind === "failed") assert.equal(oversized.code, "generation_context_exceeds_allowance");

  assert.deepEqual(fx.facts(), { calls: 0, verified: 0, saved: 0 });
  const manual = fixture((_call, prompt) => {
    assert.ok(prompt.includes(priorSource.replace(/\n/g, "\\n")));
    return patch;
  });
  const { generationAllowance: _allowance, ...options } = manual.options;
  const result = await createToolEvolutionRuntime(options).evolve(request, new AbortController().signal);

  assert.equal(result.kind, "candidate");
  assert.deepEqual(manual.facts(), { calls: 1, verified: 1, saved: 1 });
});
