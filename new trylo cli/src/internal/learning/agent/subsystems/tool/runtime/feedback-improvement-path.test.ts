import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { openRegistryHarness, issueAgentMethodReceipt } from "../../../../../integration/testing/authority-fixtures.js";
import type { ToolRunnerPort } from "../../../../../ports/tool-runner-port.js";
import { VALIDATION_STAGE_ORDER, type ValidationRecord } from "../../../../../tooling/contract/types.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest, ToolEvolutionSample } from "../domain/evolution/contracts.js";
import type { CandidateExecutor } from "../domain/evolution/execution.js";
import type { ToolEvolutionVerifier, ToolEvolutionCheck } from "../domain/evolution/verification.js";
import { isJsonValue } from "../domain/evolution/parse.js";
import { createToolProductionPlan, toolProductionScope } from "../domain/evolution/production-plan.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { createToolEvolutionRuntime } from "./evolution-runtime.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { toolLearningPriorVersions } from "./learning-context.js";
import { readToolLearningPipeline } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { saveToolProductionPlan, TOOL_PRODUCTION_GENERATOR, TOOL_PRODUCTION_VERIFIER } from "./production-assets.js";
import { admitToolProductionVerification } from "./production-evidence.js";
import { reviewToolProductionActivation, activateToolProduction } from "./production-activation.js";
import { readActiveProductionTool } from "./production-reader.js";
import { openToolProductionUse } from "./production-use.js";

const timestamp = "2026-11-03T00:00:00.000Z", clock = () => 1793664000000;
const request: ToolEvolutionRequest = { schemaVersion: 1, requestId: "decimal-v1", scope: "feedback-evolution", capability: "Double finite numbers without rounding",
  operation: "create", evidence: [
    { sampleId: "integer-a", role: "source", input: 2, expected: { kind: "value", value: 4 } },
    { sampleId: "integer-b", role: "source", input: 3, expected: { kind: "value", value: 6 } },
    { sampleId: "zero", role: "variation", input: 0, expected: { kind: "value", value: 0 } },
    { sampleId: "invalid", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
  ] };
const prefix = "module.exports = input => { if (typeof input !== 'number') throw Object.assign(new Error('numeric input required'), {code:'invalid_input'}); return ";
const v1Candidate: ToolEvolutionCandidate = { identity: "decimal_double", description: "Double finite numbers", inputSchema: { type: "number" },
  source: `${prefix}Math.round(input * 2); };`, mastery: { whenToUse: ["Double numeric input"], preconditions: ["Finite numeric input"], pitfalls: [] } };
const v2Candidate: ToolEvolutionCandidate = { ...v1Candidate, source: `${prefix}input * 2; };` };

/** Actual source evaluation for this hermetic scenario. VM is not the production OS sandbox. */
const executor: CandidateExecutor = { async execute(candidate, input, signal) {
  if (signal.aborted) return { kind: "cancelled" };
  try {
    const value: unknown = runInNewContext(`${candidate.source}\nmodule.exports(input);`, { module: { exports: undefined }, input }, { timeout: 100 });
    return isJsonValue(value) ? { kind: "value", value } : { kind: "protocol_error", detail: "non-JSON result" };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "execution_error";
    return { kind: "tool_error", code };
  }
} };
const verifier: ToolEvolutionVerifier = { async verify(candidate, frozen, signal) {
  const checks: ToolEvolutionCheck[] = [];

  for (const sample of frozen.evidence) {
    const executed = await executor.execute(candidate, sample.input, signal);
    const passed = sample.expected.kind === "value" ? executed.kind === "value" && contentHashOf(executed.value) === contentHashOf(sample.expected.value)
      : executed.kind === "tool_error" && executed.code === sample.expected.code;
    checks.push({ sampleId: sample.sampleId, role: sample.role, outcome: passed ? "passed" : "wrong_result", detail: "Actual in-process source result; not an OS-isolation verdict" });
  }

  return { verdict: checks.every(check => check.outcome === "passed") ? "pass" : "fail", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(frozen.evidence), checks };
} };

function sourceRunner(candidate: ToolEvolutionCandidate, inspectPrompt: (prompt: string) => void = () => {}): ToolRunnerPort {
  return { submit: async task => {
    assert.equal(typeof task.input.prompt, "string");
    inspectPrompt(String(task.input.prompt));
    return { taskId: task.taskId };
  },
    onProgress: () => () => {}, cancel: async () => true, status: async () => "completed",
    wait: async taskId => ({ taskId, status: "completed", observed: "terminal", output: JSON.stringify(candidate) }) };
}

test("actual production feedback retains its exact stronger contract and waits before a weaker pure repair can spend source calls", async t => {
  const base = testScratchPath("tool-feedback-complete-path");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const first = await createToolEvolutionRuntime({ runner: sourceRunner(v1Candidate), verifier,
    archive: createToolEvolutionArchive(boardRoot), now: clock }).evolve(request, signal);

  assert.equal(first.kind, "candidate");
  if (first.kind !== "candidate") assert.fail(JSON.stringify(first));

  assert.equal(first.artifact.verification.verdict, "pass", "integer contract is evaluated from actual v1 source");

  // Existing authority fixture exercises receipt and approval plumbing only; it is not native production acceptance.
  const harness = await openRegistryHarness();
  t.after(harness.close);
  const checks: ToolEvolutionRequest = { ...request, requestId: "fresh-production-checks", evidence: request.evidence.map(sample => sample.role === "variation"
    ? { ...sample, input: 4, expected: { kind: "value", value: 8 } } : sample.role === "counterexample" ? { ...sample, input: "invalid" } : sample) };
  const production = createToolProductionPlan({ workspaceId: "task-workspace", originVersionId: first.versionId, artifact: first.artifact, checks, license: "MIT" });

  assert.ok(production.ok, JSON.stringify(production));
  assert.ok((await saveToolProductionPlan(boardRoot, production.plan, timestamp)).ok);
  const validation: ValidationRecord = { validationId: "TEST-ONLY-approval-wiring", packageVersionId: production.versionId, actor: "verifier", verdict: "pass",
    stages: VALIDATION_STAGE_ORDER.map(stage => ({ stage, passed: true, detail: "TEST ONLY authority/approval shape, not OS checks" })) };
  const receipt = await issueAgentMethodReceipt(harness, validation, { scope: toolProductionScope(production.plan), verifierId: TOOL_PRODUCTION_VERIFIER, generatorId: TOOL_PRODUCTION_GENERATOR });
  const selection = { boardRoot, versionId: production.versionId, workspaceId: production.plan.workspaceId, authority: { verify: harness.registry.verify } };

  assert.ok((await admitToolProductionVerification({ ...selection, receiptId: receipt.receiptId, issuedAt: timestamp })).ok);
  const reviewed = await reviewToolProductionActivation(selection);
  assert.ok(reviewed.ok);
  const permission = createFilePermissionStore({ path: path.join(boardRoot, "permission.ndjson") });
  const approved = await permission.issue({ action: "activate", candidateId: reviewed.reviewId, packageVersionId: production.versionId,
    scope: toolProductionScope(production.plan), issuedAt: timestamp, expiry: "2026-11-03T00:01:00.000Z" });
  assert.ok(approved.ok);
  assert.ok((await activateToolProduction({ ...selection, reviewId: reviewed.reviewId, permission, token: { grantId: approved.grant.grantId }, issuedAt: timestamp })).ok);

  let useSequence = 0;
  const mounted = await openToolProductionUse({ ...selection, sessionId: "fractional-session", executor, now: clock,
    newId: () => `decimal-use-${++useSequence}`, warn: message => assert.fail(message) });
  assert.ok(mounted.ok);
  t.after(mounted.mount.close);
  const actual = await mounted.mount.tools.execute({ toolCallId: "fractional-call", name: mounted.mount.binding.name, arguments: { input: 0.75 } }, signal);

  assert.equal(actual.outcome, "result");
  if (actual.outcome !== "result") assert.fail("actual v1 invocation should return");

  assert.equal(actual.output, "2", "v1 returns a value but fails the independent task requirement of 1.5");
  const before = await createBoardReader(boardRoot).load();
  assert.ok(before.ok);
  const use = before.state.toolUses?.find(item => item.toolCallId === "fractional-call");
  assert.ok(use);
  assert.equal(use.quality, "unverified");
  assert.equal(use.execution, "returned");
  const feedback = await recordAndScheduleToolTaskFeedback(boardRoot, { schemaVersion: 1, feedbackId: "decimal-feedback", versionId: production.versionId,
    sessionId: "fractional-session", taskId: "fractional-task", useIds: [use.useId], situation: "fractional-input",
    evidenceRefs: ["task-result:fractional"], source: "user", outcome: "unsolved", attribution: "implementation",
    summary: "Input 0.75 returned 2, but the task requires exactly 1.5 without rounding", recommendation: "improve" }, timestamp);

  assert.ok(feedback.ok, JSON.stringify(feedback));
  assert.equal(feedback.learning.kind, "queued");

  if (feedback.learning.kind !== "queued") assert.fail("attributed implementation feedback must queue work");

  const feedbackJobId = feedback.learning.jobId;
  const queued = await readToolLearningPipeline(boardRoot);
  assert.ok(queued.ok);
  const queuedPlan = queued.jobs.find(job => job.jobId === feedbackJobId)?.plan;
  assert.ok(queuedPlan);
  assert.equal(queuedPlan.targetVersionId, first.versionId);

  const distractor = await createToolEvolutionRuntime({ runner: sourceRunner(v2Candidate), verifier,
    archive: createToolEvolutionArchive(boardRoot), now: clock }).evolve({ ...request, requestId: "same-capability-distractor" }, signal);

  assert.equal(distractor.kind, "candidate");
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  const { targetVersionId: omittedTarget, ...legacyPlan } = queuedPlan;
  assert.equal(omittedTarget, first.versionId);
  const legacy = toolLearningPriorVersions(loaded.state, { ...legacyPlan, trigger: { ...legacyPlan.trigger, tool: "runtime:decimal_double",
    evidenceRefs: [...legacyPlan.trigger.evidenceRefs, first.versionId] } });
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.versions.map(prior => prior.versionId), [first.versionId], "legacy exact source ref selects the parent despite another matching capability");

  const decimalSample: ToolEvolutionSample = { sampleId: "task-contract:fractional", role: "variation", input: 0.75, expected: { kind: "value", value: 1.5 } };
  let planned = 0, generated = 0;
  const services: ToolPipelineServices = { executionAuthorized: true,
    allowance: async () => ({ grantId: "TEST-central-allowance", maxCalls: 2, maxTokens: 16000, callsRemaining: 2, tokensRemaining: 16000, maxPromptChars: 24000 }),
    context: async () => ({ availableTools: [], requirements: [{ ref: "task-result:fractional", kind: "user_requirement", text: "For input 0.75 return exactly 1.5; doubling never rounds; retain invalid-input rejection" }],
      groundedSamples: [{ ref: "task-result:fractional", sample: decimalSample }] }),
    search: async () => { assert.fail("a precise version repair does not need public discovery"); },
    plan: async context => {
      planned++;
      assert.equal(context.priorVersions.length, 1);
      const parent = context.priorVersions[0]!;
      assert.equal(parent.versionId, first.versionId);
      assert.equal(parent.source, v1Candidate.source);
      assert.match(parent.feedback, /decimal-feedback/);
      assert.match(parent.feedback, /implementation/);
      assert.match(parent.feedback, /0.75 returned 2/);

      return { action: "improve", rationale: "The task result attributes rounding to this archived implementation", existingInsufficiency: "v1 rounds fractional output",
        expectedBenefit: "Correct fractional output; no measured cost saving", constructionCost: "One source revision and frozen sample checks", alternatives: ["Usage change cannot undo internal rounding"],
        request: { ...request, requestId: "planned-decimal-repair", operation: "improve", prior: { versionId: parent.versionId, source: parent.source }, evidence: [...parent.evidence, decimalSample] },
        sampleOrigins: [...parent.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${parent.versionId}:${sample.sampleId}` })),
          { sampleId: decimalSample.sampleId, kind: "contract", ref: "task-result:fractional" }] };
    },
    evolve: async () => {
      generated++;
      assert.fail("the proposed pure repair lacks a host-bound production regression chain");
    } };
  const worked = await workToolLearningPipeline({ boardRoot, scope: request.scope, now: clock, services, mode: "after_turn", signal, jobIds: [feedbackJobId] });

  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "pure_production_regression_contract_required");
  assert.equal(planned, 1);
  assert.equal(generated, 0);
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  const inventory = await readToolLearningPipeline(boardRoot);
  assert.ok(inventory.ok);
  const result = inventory.jobs.find(job => job.jobId === feedbackJobId)?.result;
  assert.equal(result?.outcome, "waiting_evidence");
  assert.equal(result?.candidateVersionId, undefined);
  assert.equal(result?.generation, undefined);
  const diagnostics = after.state.assets.filter(asset => asset.kind === "workflow" && typeof asset.content === "object" && asset.content !== null
    && "type" in asset.content && asset.content.type === "tool_pure_production_regression_block");

  assert.ok(diagnostics.length > 0);
  assert.match(JSON.stringify(diagnostics), new RegExp(production.versionId));
  assert.match(JSON.stringify(diagnostics), new RegExp(contentHashOf(production.plan.checks)));
  assert.deepEqual(after.state.activations, before.state.activations, "waiting cannot replace an approved version");
  assert.equal(after.state.approvals.length, before.state.approvals.length, "waiting does not manufacture another activation approval");
  const active = await readActiveProductionTool(selection);
  assert.ok(active.ok);
  assert.equal(active.versionId, production.versionId);
});
