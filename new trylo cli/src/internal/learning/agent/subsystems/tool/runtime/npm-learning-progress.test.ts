import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface } from "../domain/evolution/npm-production-plan.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { readNpmLearningProgress, readNpmLearningSourceReads, saveNpmLearningSourceRead } from "./npm-learning-progress.js";
import { researchNpmContract } from "./npm-contract-research.js";
import { checkNpmSourceImplementation, decodeNpmSourceCheck } from "./npm-source-check.js";

async function fixture(t: TestContext) {
  const base = testScratchPath("npm-learning-progress-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = npmTreeTestData(), scope = data.plan.tree.scope, boardRoot = path.join(root, "board"), jobId = "test-npm-learning-progress";
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "test-frozen-contract", scope, capability: "TEST ONLY", operation: "create", evidence: [
    { sampleId: "s1", role: "source", input: { value: 1 }, expected: { kind: "value", value: 1 } },
    { sampleId: "s2", role: "source", input: { value: 2 }, expected: { kind: "value", value: 2 } },
    { sampleId: "v", role: "variation", input: { value: 3 }, expected: { kind: "value", value: 3 } },
    { sampleId: "c", role: "counterexample", input: { value: null }, expected: { kind: "error", code: "bad" } },
  ] };

  await withBoardWriter(boardRoot, async store => {
    const at = new Date(0).toISOString();
    assert.ok((await store.apply({ type: "enqueue_job", commandId: "queue", issuedAt: at,
      job: { jobId, domain: "tool", scope, observationId: "test", dedupeKey: jobId, maxAttempts: 3 } })).ok);
    assert.ok((await store.apply({ type: "start_job", commandId: "start", issuedAt: at, jobId })).ok);
  });
  let modelCalls = 0;
  const input: NpmAdaptationInput = { boardRoot, workspaceId: "test", installation: data.plan, installationRoot: "unused", adaptation: "TEST ONLY",
    admission: { jobId, attempt: 1 }, signal: new AbortController().signal, now: () => 0,
    plan: { type: "tool_learning_plan", schemaVersion: 1, scope, capability: checks.capability, createdAt: new Date(0).toISOString(),
      trigger: { runId: "test", proposalKey: "test", action: "user_requested", evidenceRefs: [] } },
    services: { allowance: async () => ({ grantId: "test-grant", maxCalls: 4, callsRemaining: 4 - modelCalls, maxTokens: 96_000, tokensRemaining: 90_000, maxPromptChars: 24_000 }),
      complete: async () => {
        modelCalls++;
        return modelCalls === 1 ? { action: "read", paths: ["node_modules/test-cli/cli.cjs"] } : { checks };
      } } };
  const contractId = `npm-contract_v1_${contentHashOf(checks)}`;
  const content = { type: "tool_npm_learning_contract", schemaVersion: 1, subjectId: jobId, installationId: npmInstallId(data.plan), groundingHash: "a".repeat(64), checks,
    origins: checks.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "test-user-requirement" })) };

  assert.ok((await saveNpmLearningArtifact({ ...input, scope, versionId: contractId, content, issuedAt: new Date(0).toISOString() })).ok);

  return { input, checks, contractId, modelCalls: () => modelCalls };
}

test("restart restores the latest exact-contract interface and source-only diagnosis plus bounded source coordinates", async t => {
  const fx = await fixture(t);
  const selected = decodeNpmToolInterface({ descriptor: { identity: "test", description: "TEST ONLY", inputSchema: {}, mastery: { whenToUse: ["TEST ONLY source recovery"], preconditions: [], pitfalls: [] } },
    runtime: { profile: "confined_npm_library_v1", source: "module.exports=input=>input.value;" } });
  assert.ok(selected);

  for (const value of [10, 20]) {
    const content = { type: "tool_npm_learning_attempt", schemaVersion: 1, subjectId: fx.input.admission.jobId, contractId: fx.contractId,
      interface: selected, check: { kind: "failed", sampleId: "s1", expected: fx.checks.evidence[0]!.expected, result: { kind: "value", value }, interpretation: "TEST ONLY source check" } };
    assert.ok((await saveNpmLearningArtifact({ ...fx.input, scope: fx.input.plan.scope,
      versionId: `npm-attempt_v1_${contentHashOf(content)}`, content, issuedAt: new Date(0).toISOString() })).ok);
  }

  assert.ok((await saveNpmLearningSourceRead(fx.input, { contractId: fx.contractId,
    request: { action: "read", paths: ["node_modules/test-cli/cli.cjs"], offset: 5000 }, sourceFingerprint: "b".repeat(64) })).ok);
  const restored = await readNpmLearningProgress(fx.input, fx.contractId, fx.checks);
  assert.ok(restored.ok);
  assert.ok(restored.lastAttempt);
  assert.equal(restored.lastAttempt.check.kind, "failed");

  if (restored.lastAttempt.check.kind === "failed") {
    assert.deepEqual(restored.lastAttempt.check.result, { kind: "value", value: 20 });
    assert.deepEqual(restored.lastAttempt.check.input, fx.checks.evidence[0]!.input, "legacy records hydrate input from the exact source sample only");
  }

  assert.deepEqual(restored.lastAttempt.interface, selected);
  assert.equal(restored.reads[0]?.request.offset, 5000);
  assert.equal(JSON.stringify(restored.reads).includes("module.exports"), false);
  const other = await readNpmLearningProgress(fx.input, fx.contractId, { ...fx.checks, capability: "another contract" });
  assert.ok(!other.ok);
});

test("contract research reads actual source before freezing and replays its coordinates without extra model requests", async t => {
  const fx = await fixture(t);
  let localReads = 0;
  const options = { contractId: fx.contractId, initialSource: { initial: true }, prompt: (source: unknown) => JSON.stringify(source),
    readSource: () => {
      localReads++;
      return { source: { api: "actualPackageMethod" }, sourceFingerprint: "c".repeat(64) };
    } };
  const result = await researchNpmContract(fx.input, options);
  assert.ok(result.ok);
  assert.deepEqual(result.response, { checks: fx.checks });
  assert.equal(fx.modelCalls(), 2);
  assert.equal(localReads, 1);
  const reads = await readNpmLearningSourceReads(fx.input, fx.contractId);
  assert.ok(reads.ok);
  assert.equal(reads.reads.length, 1);
  const resumed = await researchNpmContract({ ...fx.input, services: { ...fx.input.services,
    complete: async prompt => {
      assert.ok(prompt.includes("actualPackageMethod"));
      return { checks: fx.checks };
    } } }, options);

  assert.ok(resumed.ok);
  assert.equal(localReads, 2);
});

test("research retains a generation call and reports prompt overflow before any provider request", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const scarce = { ...fx.input, services: { ...fx.input.services,
    allowance: async () => ({ grantId: "test", maxCalls: 2, callsRemaining: 2 - calls, maxTokens: 1000, tokensRemaining: 1000, maxPromptChars: 1000 }),
    complete: async () => {
      calls++;
      return { action: "read", paths: ["node_modules/test-cli/cli.cjs"] };
    } } };
  const options = { contractId: fx.contractId, initialSource: {}, prompt: () => "test",
    readSource: () => ({ source: { fact: true }, sourceFingerprint: "d".repeat(64) }) };
  const exhausted = await researchNpmContract(scarce, options);
  assert.ok(!exhausted.ok);
  assert.equal(exhausted.code, "npm_contract_research_closed");
  assert.equal(calls, 1);
  const overflow = await researchNpmContract(fx.input, { ...options, prompt: () => undefined });
  assert.ok(!overflow.ok);
  assert.equal(overflow.code, "npm_contract_context_exceeds_allowance");
  assert.equal(fx.modelCalls(), 0);
});

test("the last contract decision is explicitly closed to research and retains the implementation call", async t => {
  const fx = await fixture(t);
  let calls = 0, reads = 0;
  const input = { ...fx.input, services: { ...fx.input.services,
    allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 2, callsRemaining: 2 - calls, maxTokens: 2000, tokensRemaining: 2000, maxPromptChars: 2000 }),
    complete: async (prompt: string) => {
      calls++;
      assert.ok(prompt.includes('"kind":"contract_only"'));
      return { checks: fx.checks };
    } } };
  const result = await researchNpmContract(input, { contractId: fx.contractId, initialSource: {},
    prompt: (_source, _allowance, boundary) => JSON.stringify(boundary),
    readSource: () => {
      reads++;
      return { source: {}, sourceFingerprint: "e".repeat(64) };
    } });

  assert.ok(result.ok);
  assert.equal(calls, 1);
  assert.equal(reads, 0);
  assert.equal((await input.services.allowance()).callsRemaining, 1, "the original grant's source-generation call remains untouched");
});

test("re-reading initial evidence closes research and offers one final contract decision instead of silently exiting", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const input = { ...fx.input, services: { ...fx.input.services,
    allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 4, callsRemaining: 4 - calls, maxTokens: 3000, tokensRemaining: 3000, maxPromptChars: 3000 }),
    complete: async (prompt: string) => { calls++;
    if (calls === 1) return { action: "read", paths: ["node_modules/test-cli/cli.cjs"] };
      assert.ok(prompt.includes('"reason":"no_new_source"'));
    return { checks: fx.checks }; } } };
  const result = await researchNpmContract(input, { contractId: fx.contractId, initialSource: { same: true }, initialSourceFingerprint: "e".repeat(64),
    prompt: (_source, _allowance, boundary) => JSON.stringify(boundary), readSource: () => ({ source: { same: true }, sourceFingerprint: "e".repeat(64) }) });

  assert.ok(result.ok);
  assert.equal(calls, 2);
});

test("restoration refuses changed source bytes rather than reporting old coordinates as inspected evidence", async t => {
  const fx = await fixture(t);
  assert.ok((await saveNpmLearningSourceRead(fx.input, { contractId: fx.contractId,
    request: { action: "read", paths: ["node_modules/test-cli/cli.cjs"] }, sourceFingerprint: "b".repeat(64) })).ok);
  const result = await researchNpmContract<unknown>(fx.input, { contractId: fx.contractId, initialSource: {}, prompt: () => "TEST ONLY",
    readSource: () => ({ source: { changed: true }, sourceFingerprint: "c".repeat(64) }) });
  assert.ok(!result.ok);
  assert.equal(result.code, "npm_contract_source_changed");
  assert.equal(fx.modelCalls(), 0);
});

test("source repair diagnostics expose host-defined codes while withholding arbitrary detail and raw output", async t => {
  const fx = await fixture(t);
  const plan = createNpmToolProductionPlan({ workspaceId: "test", installation: fx.input.installation, checks: fx.checks,
    descriptor: { identity: "test", description: "TEST ONLY", inputSchema: {}, mastery: { whenToUse: ["TEST ONLY source recovery"], preconditions: [], pitfalls: [] } },
    runtime: { profile: "confined_npm_library_v1", source: "module.exports=input=>input;" } });
  assert.ok(plan);
  const known = await checkNpmSourceImplementation(plan, async () => ({ kind: "protocol_error", detail: "npm_patch_source_mismatch" }), fx.input.signal);

  assert.ok(known.kind === "failed");
  assert.deepEqual(known.result, { kind: "protocol_error", code: "npm_patch_source_mismatch" });
  assert.deepEqual(known.input, fx.checks.evidence[0]!.input);
  assert.equal(decodeNpmSourceCheck({ ...known, input: { value: "tampered" } }, plan), undefined);
  assert.equal(decodeNpmSourceCheck({ ...known, sampleId: "v", input: fx.checks.evidence[2]!.input,
    expected: fx.checks.evidence[2]!.expected }, plan), undefined, "held-out cases never become repair feedback, including on replay");
  const unknown = await checkNpmSourceImplementation(plan, async () => ({ kind: "protocol_error", detail: "TEST_ONLY_PRIVATE_DETAIL" }), fx.input.signal);

  assert.equal(unknown.kind, "blocked");

  if (unknown.kind === "blocked") assert.equal(unknown.executionKind, "protocol_error");

  assert.equal(JSON.stringify(unknown).includes("TEST_ONLY_PRIVATE_DETAIL"), false);
  const timeout = await checkNpmSourceImplementation(plan, async () => ({ kind: "timeout", detail: "TEST_ONLY_PRIVATE_DEADLINE" }), fx.input.signal);

  assert.equal(timeout.kind, "blocked");

  if (timeout.kind === "blocked") assert.equal(timeout.executionKind, "timeout");

  assert.equal(JSON.stringify(timeout).includes("TEST_ONLY_PRIVATE_DEADLINE"), false);
});
