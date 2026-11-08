import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import test, { type TestContext } from "node:test";
import type { JsonValue } from "../../../../../protocol/envelope.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { checkJsonFunctionSource } from "../../../../../adapters/tool-evolution/json-function-policy.js";
import type { CandidateExecutor } from "../domain/evolution/execution.js";
import type { ToolCompositionPlan, ToolEvolutionCandidate, ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { decodeToolCompositionPlan, parseToolEvolutionRequest } from "../domain/evolution/parse.js";
import type { ToolEvolutionVerifier } from "../domain/evolution/verification.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { createToolCompositionRuntime, prepareToolComposition } from "./composition.js";
import { openToolCandidateUse, withdrawToolCandidate } from "./evolution-use.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { openRegistryHarness, issueAgentMethodReceipt } from "../../../../../integration/testing/authority-fixtures.js";
import { VALIDATION_STAGE_ORDER, type ValidationRecord } from "../../../../../tooling/contract/types.js";
import { createToolProductionPlan, toolProductionScope } from "../domain/evolution/production-plan.js";
import { saveToolProductionPlan, TOOL_PRODUCTION_GENERATOR, TOOL_PRODUCTION_VERIFIER } from "./production-assets.js";
import { admitToolProductionVerification } from "./production-evidence.js";
import { reviewToolProductionActivation, activateToolProduction } from "./production-activation.js";
import { openWorkspaceProductionTools } from "./production-use.js";

const now = () => 0;
const signal = () => new AbortController().signal;
const descriptor = { identity: "weighted_sum", description: "Sum numbers and multiply the result by a factor.",
  inputSchema: { type: "object" }, mastery: { whenToUse: ["Sum a list and apply a scale factor"], preconditions: ["Finite numbers and factor"], pitfalls: ["Does not parse text"] } };
const rows = [
  { sampleId: "s1", role: "source", input: { numbers: [1, 2], factor: 2 }, expected: { kind: "value", value: 6 } },
  { sampleId: "s2", role: "source", input: { numbers: [4], factor: 3 }, expected: { kind: "value", value: 12 } },
  { sampleId: "v", role: "variation", input: { numbers: [-2, 5], factor: -2 }, expected: { kind: "value", value: -6 } },
  { sampleId: "n", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
] satisfies ToolEvolutionRequest["evidence"];
const request: ToolEvolutionRequest = { schemaVersion: 1, requestId: "composition", scope: "test", capability: descriptor.description, operation: "create", evidence: rows };

// Executes known test programs. This proves compiler behavior; it is not an OS-isolation or native-production claim.
const executor: CandidateExecutor = { execute: async (candidate, input, cancellation) => {
  if (cancellation.aborted) return { kind: "cancelled" };

  const admitted = checkJsonFunctionSource(candidate.source);
  if (!admitted.ok) return { kind: "protocol_error", detail: admitted.code };

  const callable: unknown = new Script(`${admitted.program}\nmodule.exports;`).runInNewContext({ module: { exports: undefined } }, { timeout: 100 });

  assert.equal(typeof callable, "function");

  try { return { kind: "value", value: JSON.parse(JSON.stringify(await (callable as (value: JsonValue) => Promise<unknown>)(input))) as JsonValue }; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return { kind: "tool_error", code: error.code };
    throw error;
  }
} };
const verifier: ToolEvolutionVerifier = { verify: async (candidate, input, cancellation) => {
  const checks = [];

  for (const sample of input.evidence) {
    const actual = await executor.execute(candidate, sample.input, cancellation);
    const normalized = actual.kind === "tool_error" ? { kind: "error", code: actual.code } : actual;
    const matches = canonicalJson(normalized) === canonicalJson(sample.expected);
    checks.push({ sampleId: sample.sampleId, role: sample.role, outcome: matches ? "passed" as const : "wrong_result" as const, detail: "test program output compared to frozen expectation" });
  }

  return { verdict: checks.every(row => row.outcome === "passed") ? "pass" : "fail", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(input.evidence), checks };
} };

async function fixture(t: TestContext) {
  const base = testScratchPath("tool-composition-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = createToolEvolutionArchive(root);
  const sources = [
    "module.exports = input => { if (!input || !Array.isArray(input.numbers) || !input.numbers.every(Number.isFinite)) throw Object.assign(new Error('invalid'), {code:'invalid_input'}); return input.numbers.reduce((a,b)=>a+b,0); };",
    "module.exports = input => { if (!input || !Number.isFinite(input.value) || !Number.isFinite(input.factor)) throw Object.assign(new Error('invalid'), {code:'invalid_input'}); return input.value * input.factor; };",
  ];
  const versions: string[] = [];

  for (const [index, source] of sources.entries()) {
    const candidate: ToolEvolutionCandidate = { ...descriptor, identity: `component_${index}`, source };
    const inputs = index === 0 ? [[{ numbers: [1, 2] }, 3], [{ numbers: [4] }, 4], [{ numbers: [] }, 0]]
      : [[{ value: 3, factor: 2 }, 6], [{ value: 4, factor: 3 }, 12], [{ value: 0, factor: -2 }, 0]];
    const componentRequest: ToolEvolutionRequest = { ...request, requestId: `seed-${index}`, evidence: [
      ...inputs.map(([input, value], i) => ({ sampleId: `s${i}`, role: i === 2 ? "variation" as const : "source" as const, input: input as JsonValue, expected: { kind: "value" as const, value: value as JsonValue } })),
      { sampleId: "invalid", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
    ] };
    const verification = await verifier.verify(candidate, componentRequest, signal());
    assert.equal(verification.verdict, "pass");
    const saved = await archive.save({ schemaVersion: 1, request: componentRequest, candidate, verification, generatedAt: new Date(0).toISOString() });

    assert.ok(saved.ok, JSON.stringify(saved));
    versions.push(saved.versionId);
  }

  const composition: ToolCompositionPlan = { schemaVersion: 1, steps: [
    { stepId: "sum", versionId: versions[0]!, input: { from: "input", path: [] } },
    { stepId: "scale", versionId: versions[1]!, input: { from: "object", fields: { value: { from: "step", stepId: "sum", path: [] }, factor: { from: "input", path: ["factor"] } } } },
  ], output: { from: "step", stepId: "scale", path: [] } };

  return { root, archive, versions, composed: { ...request, composition } };
}

test("composition preserves legacy request decoding and rejects cycles, unknown versions and prototype paths", async t => {
  const fx = await fixture(t);

  assert.ok(parseToolEvolutionRequest(request).ok);
  assert.ok(parseToolEvolutionRequest(fx.composed).ok);
  assert.equal(decodeToolCompositionPlan({ ...fx.composed.composition, output: { from: "literal", value: 12 } }), undefined);
  assert.equal(decodeToolCompositionPlan({ ...fx.composed.composition, steps: fx.composed.composition.steps.map(step => ({ ...step, input: { from: "step", stepId: "scale", path: [] } })) }), undefined);
  assert.equal(decodeToolCompositionPlan({ ...fx.composed.composition, output: { from: "step", stepId: "scale", path: ["__proto__"] } }), undefined);
  const unavailable = await prepareToolComposition(fx.root, { ...fx.composed, scope: "foreign" }, descriptor);

  assert.equal(!unavailable.ok && unavailable.code, "composition_scope_mismatch");
});

test("existing tool composition verifies, archives, reopens and executes an immutable callable with use facts", async t => {
  const fx = await fixture(t);
  const result = await createToolCompositionRuntime({ boardRoot: fx.root, verifier, archive: fx.archive, now }).compose(fx.composed, descriptor, signal());

  assert.equal(result.kind, "candidate", JSON.stringify(result));
  if (result.kind !== "candidate") return;

  assert.equal(result.attempts, 0);
  assert.ok(checkJsonFunctionSource(result.artifact.candidate.source).ok);
  const before = await createBoardReader(fx.root).load();
  assert.ok(before.ok);
  assert.equal(before.state.activations.length, 0);
  const opened = await openToolCandidateUse({ boardRoot: fx.root, versionId: result.versionId, sessionId: "later-task", workspaceId: "workspace-test", executor, now, newId: () => "composition-use", warn: () => {} });

  assert.ok(opened.ok);
  t.after(opened.mount.close);
  assert.equal(opened.mount.binding.needsApproval, true);
  const output = await opened.mount.tools.execute({ toolCallId: "composition-call", name: opened.mount.binding.name, arguments: { input: { numbers: [7, -2], factor: 4 } } }, signal());

  assert.equal(output.outcome, "result");
  if (output.outcome === "result") assert.equal(output.output, "20");

  const after = await createBoardReader(fx.root).load();
  assert.ok(after.ok);
  assert.equal(after.state.toolUses?.[0]?.versionId, result.versionId);
  assert.equal(after.state.toolUses?.[0]?.quality, "unverified");
});

test("composition cannot archive substituted source, reuse withdrawn parents or ignore cancellation", async t => {
  const fx = await fixture(t), prepared = await prepareToolComposition(fx.root, fx.composed, descriptor);
  assert.ok(prepared.ok);
  const substitute = { ...prepared.candidate, source: "module.exports = input => 6;" };
  const verification = { verdict: "pass" as const, candidateHash: contentHashOf(substitute), samplesHash: contentHashOf(fx.composed.evidence),
    checks: fx.composed.evidence.map(row => ({ sampleId: row.sampleId, role: row.role, outcome: "passed" as const, detail: "forged test claim" })) };
  const rejected = await fx.archive.save({ schemaVersion: 1, request: fx.composed, candidate: substitute, verification, generatedAt: new Date(0).toISOString() });

  assert.equal(!rejected.ok && rejected.code, "composition_binding_mismatch");
  assert.ok((await withdrawToolCandidate(fx.root, fx.versions[0]!, new Date(0).toISOString())).ok);
  const withdrawn = await prepareToolComposition(fx.root, fx.composed, descriptor);
  assert.equal(!withdrawn.ok && withdrawn.code, "candidate_unavailable");
  const cancellation = new AbortController();
  cancellation.abort();
  const cancelled = await createToolCompositionRuntime({ boardRoot: fx.root, verifier, archive: fx.archive, now }).compose(fx.composed, descriptor, cancellation.signal);

  assert.equal(cancelled.kind, "cancelled");
});

test("a composed artifact follows existing production evidence and exact approval before later task use", async t => {
  const fx = await fixture(t);
  const evolved = await createToolCompositionRuntime({ boardRoot: fx.root, verifier, archive: fx.archive, now }).compose(fx.composed, descriptor, signal());

  assert.equal(evolved.kind, "candidate");
  if (evolved.kind !== "candidate") return;

  const checks: ToolEvolutionRequest = { ...request, requestId: "fresh-production", evidence: rows.map(row => row.role === "variation"
    ? { ...row, input: { numbers: [10, -4], factor: 2 }, expected: { kind: "value", value: 12 } }
    : row.role === "counterexample" ? { ...row, input: "invalid" } : row) };
  const production = createToolProductionPlan({ workspaceId: "workspace-test", originVersionId: evolved.versionId, artifact: evolved.artifact, checks, license: "MIT" });

  assert.ok(production.ok);
  const issuedAt = "2026-10-31T00:00:00.000Z";

  assert.ok((await saveToolProductionPlan(fx.root, production.plan, issuedAt)).ok);
  const harness = await openRegistryHarness();
  t.after(harness.close);
  const selection = { boardRoot: fx.root, versionId: production.versionId, workspaceId: "workspace-test", authority: { verify: harness.registry.verify } };
  const options = { ...selection, executor, sessionId: "later-production-task", now, newId: () => "production-composition-use", warn: () => {} };
  const before = await openWorkspaceProductionTools(options);
  assert.ok(before.ok);
  assert.equal(before.tools.snapshot().length, 0);
  await before.close();
  // Existing test-only authority fixture proves receipt/approval wiring, not real ten-stage production verification.
  const record: ValidationRecord = { validationId: "test-composition-validation", packageVersionId: production.versionId, actor: "verifier", verdict: "pass",
    stages: VALIDATION_STAGE_ORDER.map(stage => ({ stage, passed: true, detail: "TEST ONLY receipt contract" })) };
  const receipt = await issueAgentMethodReceipt(harness, record, { scope: toolProductionScope(production.plan), verifierId: TOOL_PRODUCTION_VERIFIER, generatorId: TOOL_PRODUCTION_GENERATOR });

  assert.ok((await admitToolProductionVerification({ ...selection, receiptId: receipt.receiptId, issuedAt })).ok);
  const review = await reviewToolProductionActivation(selection);
  assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });

  assert.equal((await activateToolProduction({ ...selection, reviewId: review.reviewId, permission, token: { grantId: "forged" }, issuedAt })).ok, false);
  const grant = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: production.versionId,
    scope: toolProductionScope(production.plan), issuedAt, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(grant.ok);
  assert.ok((await activateToolProduction({ ...selection, reviewId: review.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt })).ok);
  const mounted = await openWorkspaceProductionTools(options);
  assert.ok(mounted.ok);
  t.after(mounted.close);
  const binding = mounted.tools.snapshot()[0];
  assert.ok(binding);
  const output = await mounted.tools.execute({ toolCallId: "approved-composition", name: binding.name, arguments: { input: { numbers: [7, 3], factor: 5 } } }, signal());

  assert.equal(output.outcome, "result");
  if (output.outcome === "result") assert.equal(output.output, "50");

  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.toolUses?.at(-1)?.versionId, production.versionId);
});
