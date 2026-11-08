import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { prepareNpmToolAdaptation } from "./npm-adaptation-runtime.js";
import { npmLearningFixture, npmLearningAdapter } from "../testing/npm-learning-fixture.js";
import { productionFromBoard } from "./production-assets.js";
import { npmLearningSource, mergeNpmLearningSource } from "../adapters/acquisition/npm-learning-source.js";
import { prepareNpmLearningContract } from "./npm-adaptation-contract.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { checkNpmSourceImplementation } from "./npm-source-check.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface } from "../domain/evolution/npm-production-plan.js";
import { contentHashOf } from "../../../../control/hash.js";

test("the learner freezes checks, repairs a real dependency adapter from source feedback and preserves held-out cases for admission", async t => {
  const fx = await npmLearningFixture(t), phases: string[] = [], prompts: string[] = [];
  let remaining = 3;
  const result = await prepareNpmToolAdaptation({ ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "Expose the existing normalization API",
    services: { allowance: async () => ({ grantId: "TEST ONLY controlled calls, not a central grant assertion", maxCalls: 3, maxTokens: 48000,
      callsRemaining: remaining, tokensRemaining: 48000, maxPromptChars: 24000 }), execute: fx.execute,
    complete: async (prompt, _signal, phase) => {
      remaining--;
      phases.push(phase);
      prompts.push(prompt);
      if (phase === "contract") return fx.contract;
      assert.ok(!prompt.includes("HELD_OUT_SENTINEL"));
      assert.ok(!prompt.includes("held_out_sentinel"));
      return fx.candidate(remaining === 1 ? "module.exports=input=>input.value;" : npmLearningAdapter);
    } } });

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.sourceChecked, true);
  assert.deepEqual(phases, ["contract", "implementation", "implementation"]);
  assert.equal(remaining, 0);
  assert.ok(prompts[2]?.includes('"sampleId":"a"') && prompts[2]?.includes('"kind":"failed"'));
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  const selected = productionFromBoard(loaded.state, result.versionId, "workspace-test");
  assert.ok(selected.ok);
  assert.equal(selected.lifecycle, "evaluating");
  assert.equal(loaded.state.activations.length, 0);
  assert.equal(selected.plan.type, "npm_tool_production_package");

  if (selected.plan.type === "npm_tool_production_package") assert.deepEqual(await fx.execute(selected.plan, { value: "  FOLLOW-UP " }, fx.signal), { kind: "value", value: "follow-up" });
});

test("waiting for resources preserves the frozen contract and a restart does not invent another oracle", async t => {
  const fx = await npmLearningFixture(t);
  let remaining = 2, calls = 0;
  const input = { ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "Expose the existing normalization API",
    services: { allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 2, maxTokens: 32000, callsRemaining: remaining, tokensRemaining: 32000, maxPromptChars: 24000 }),
      execute: fx.execute, complete: async (_prompt: string, _signal: AbortSignal, phase: "contract" | "implementation") => {
        remaining--;
        calls++;
        return phase === "contract" ? fx.contract : fx.candidate("module.exports=input=>input.value;");
      } } };
  const first = await prepareNpmToolAdaptation(input);
  assert.ok(!first.ok);
  assert.equal(first.code, "learning_budget_exhausted");
  assert.equal(calls, 2);
  const second = await prepareNpmToolAdaptation(input);
  assert.ok(!second.ok);
  assert.equal(second.code, "learning_budget_exhausted");
  assert.equal(calls, 2);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.assets.filter(asset => typeof asset.content === "object" && asset.content !== null && "type" in asset.content && asset.content.type === "tool_npm_learning_contract").length, 1);
});

test("source research prioritizes requested ranges and retains the exact hash across paging", () => {
  const files = [{ path: "node_modules/example/README.md", body: Buffer.from("documentation ".repeat(1000)) },
    { path: "node_modules/example/package.json", body: Buffer.from('{"name":"example"}') },
    { path: "node_modules/example/large.cjs", body: Buffer.from(`${"a".repeat(6000)}API_TAIL`) }];
  const first = npmLearningSource(files, "node_modules/example", ["node_modules/example/large.cjs"]);
  const next = npmLearningSource(files, "node_modules/example", ["node_modules/example/large.cjs"], 5000);

  assert.equal(first.excerpts[0]?.path, "node_modules/example/large.cjs");
  assert.equal(first.excerpts[0]?.nextOffset, 5000);
  assert.ok(next.excerpts[0]?.text.endsWith("API_TAIL"));
  assert.equal(first.excerpts[0]?.sha256, next.excerpts[0]?.sha256);
  const merged = mergeNpmLearningSource(first, next);
  assert.ok(merged.excerpts.some(row => row.offset === 5000 && row.text.includes("API_TAIL")));
  assert.ok(merged.excerpts.reduce((sum, row) => sum + row.text.length, 0) <= 8000);
});

test("a restart publishes an already checked source attempt without buying another implementation or claiming activation", async t => {
  const fx = await npmLearningFixture(t);
  let calls = 0;
  const input = { ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "Recover the exact completed source step",
    services: { allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 2, maxTokens: 32000, callsRemaining: 2 - calls, tokensRemaining: 32000, maxPromptChars: 24000 }),
      complete: async () => {
        calls++;
        return fx.contract;
      }, execute: fx.execute } };
  const source = npmLearningSource([], fx.data.plan.tree.root.location);
  const frozen = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(frozen.ok);
  const selected = decodeNpmToolInterface(fx.candidate(npmLearningAdapter).interface);
  assert.ok(selected);
  const plan = createNpmToolProductionPlan({ workspaceId: input.workspaceId, installation: input.installation, ...selected, checks: frozen.contract.checks });
  assert.ok(plan);
  const check = await checkNpmSourceImplementation(plan, fx.execute, fx.signal);
  assert.equal(check.kind, "passed");
  const content = { type: "tool_npm_learning_attempt", schemaVersion: 1, subjectId: input.admission.jobId,
    contractId: frozen.versionId, interface: selected, check };

  assert.ok((await saveNpmLearningArtifact({ ...input, scope: fx.scope, versionId: `npm-attempt_v1_${contentHashOf(content)}`,
    content, issuedAt: new Date(fx.now()).toISOString() })).ok);
  const cancelled = await prepareNpmToolAdaptation({ ...input, signal: AbortSignal.abort() });

  assert.ok(!cancelled.ok);
  assert.equal(cancelled.code, "cancelled");
  const beforeResume = await createBoardReader(fx.boardRoot).load();
  assert.ok(beforeResume.ok);
  assert.ok(!beforeResume.state.assets.some(asset => typeof asset.content === "object" && asset.content !== null
    && "type" in asset.content && asset.content.type === "npm_tool_production_package"));
  const resumed = await prepareNpmToolAdaptation({ ...input, services: { ...input.services,
    complete: async () => { assert.fail("The source result was committed before the simulated process loss"); } } });

  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(resumed.sourceChecked, true);
  assert.equal(calls, 1);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.activations.length, 0);
});
