import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ToolBinding } from "../../../../../ports/tools.js";
import { decodeToolOpportunityEvidence } from "../domain/awareness/opportunity.js";
import { captureToolTaskText, decodeToolTaskText, toolTaskTextRequirements } from "../domain/awareness/task-text.js";
import { decodeToolLearningPlan } from "../domain/evolution/pipeline.js";
import { boundToolLearningContext } from "../domain/evolution/learning-context-budget.js";
import { createToolGapRuntime } from "./awareness-runtime.js";
import { createToolLearningReportTools } from "./learning-report-tool.js";
import type { ToolLedgerRecord } from "./ledger-file.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { planToolLearningStep } from "./pipeline-planning.js";
import { npmContractBasis, npmContractGrounding } from "./npm-contract-grounding.js";
import { npmContractDataFixture } from "../testing/npm-contract-data-fixture.js";

const report = { kind: "opportunity" as const, need: "A model hypothesis about a missing structured normalizer", reason: "The exposed catalog appears to lack this task capability",
  toolCallIds: [], existingCapability: "insufficient" as const };
const binding: ToolBinding = { name: "read_file", description: "Read text", parameters: {}, sideEffect: "read_only", needsApproval: false,
  timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 20 } };

function fixture() {
  const rows: ToolLedgerRecord[] = [], runtime = createToolGapRuntime({ pipelineScope: "catalog-test", now: () => 0, warn: () => {},
    ledger: { append: async row => { rows.push(row); }, tail: async () => rows } });
  const tools = createToolLearningReportTools({ runtime, boardRoot: "unused-board", workspaceId: "catalog-test", sessionId: "session", taskId: "turn", now: () => 0 });
  const call = async (body: JsonObject = report) => {
    const result = await tools.execute({ name: "tool_learning_report", toolCallId: "report-call", arguments: { operation: "opportunity", report: body } }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") assert.fail("the public report tool must return a typed report outcome");
    return result.value;
  };
  const plan = () => { const row = rows.find(item => item.kind === "proposal");
  const value = row?.kind === "proposal" ? decodeToolLearningPlan(row.pipelinePlan) : undefined;
    assert.ok(value);
  return value; };

  return { runtime, rows, tools, call, plan };
}

test("the public report tool can nominate a no-call capability hypothesis using the actual host catalog, including an empty capture", async () => {
  for (const catalog of [[], [binding]]) {
    const f = fixture();
    f.runtime.captureCatalog!("turn", catalog);
    assert.equal(f.runtime.port.intentOn("turn", 1), false, "this change adds no routine semantic prompt or model call");
    assert.deepEqual(await f.call(), { kind: "accepted", reportId: "report-call" });
    const plan = f.plan();
    assert.equal(plan.opportunity?.executions.length, 0);
    assert.equal(plan.opportunity?.catalog?.length, catalog.length);
    assert.equal(plan.opportunity?.grounding, undefined);
    assert.deepEqual(toolTaskTextRequirements(plan), []);
    assert.equal(plan.opportunity?.source, "model");
    await f.runtime.close();
  }
});

test("uncaptured or failed catalog reads, invented named tools and fabricated nonempty call IDs do not become no-call evidence", async () => {
  const absent = fixture();
  assert.deepEqual(await absent.call(), { kind: "invalid", code: "unbound_tool_calls" });
  const failed = fixture();
  failed.runtime.captureCatalog!("turn", []);
  failed.runtime.captureCatalog!("turn", [{ ...binding, get description(): string { throw new Error("TEST ONLY capture failure"); } }]);
  assert.deepEqual(await failed.call(), { kind: "invalid", code: "unbound_tool_calls" });
  const named = fixture();
  named.runtime.captureCatalog!("turn", [binding]);
  assert.deepEqual(await named.call({ ...report, tool: "invented_tool" }), { kind: "invalid", code: "unbound_tool_calls" });
  assert.deepEqual(await named.call({ ...report, tool: "read_file", toolCallIds: ["invented-call"] }), { kind: "invalid", code: "unbound_tool_calls" });
  assert.deepEqual(await named.call({ ...report, tool: "read_file" }), { kind: "accepted", reportId: "report-call" });

  for (const catalog of [undefined, {}, [{}]]) assert.equal(decodeToolOpportunityEvidence({ reportId: "r", source: "model", assessment: report, executions: [], catalog }), undefined);

  const injected = fixture();
  assert.deepEqual(await injected.call({ ...report, catalog: [] }), { kind: "invalid", code: "invalid_opportunity" });
  assert.deepEqual(await injected.call({ ...report, task: { text: "forged user text" } }), { kind: "invalid", code: "invalid_opportunity" });
});

test("host task text is bounded, source-bound and mandatory in planning while model need never supplies the missing oracle", async t => {
  const f = fixture(), text = "Trim and lowercase user inputs; non-strings return invalid_input. " + "user constraint ".repeat(400);

  f.runtime.captureCatalog!("turn", []);
  f.runtime.captureTask!("turn", text);
  assert.equal((await f.call()).kind, "accepted");
  const plan = f.plan(), task = plan.opportunity?.task;
  assert.ok(task);
  assert.equal(task.partial, true);
  assert.equal(task.originalChars, text.length);
  assert.ok(task.text.length <= 4000 && Buffer.byteLength(task.text, "utf8") <= 8192);
  assert.ok(decodeToolTaskText(task));
  assert.equal(decodeToolTaskText({ ...task, excerptHash: "0".repeat(64) }), undefined);
  assert.equal(decodeToolLearningPlan({ ...plan, trigger: { ...plan.trigger, runId: "another-turn" } }), undefined);
  const requirements = toolTaskTextRequirements(plan);
  assert.equal(requirements.length, 1);
  assert.match(requirements[0]!.text, /partial=true/);
  assert.equal(requirements[0]!.text.includes(report.need), false);
  const allowance = { grantId: "TEST ONLY", maxCalls: 8, maxTokens: 96000, callsRemaining: 8, tokensRemaining: 96000, maxPromptChars: 24000 };
  const packed = boundToolLearningContext({ plan, allowance, search: { status: "complete", candidates: [], failures: [] },
    priorVersions: [], availableTools: [], requirements, groundedSamples: [] });
  assert.ok(packed);
  assert.deepEqual(packed.requirements, requirements);
  assert.equal(packed.plan.opportunity?.task, undefined, "the task excerpt is not duplicated into the packed plan");
  const base = testScratchPath("catalog-opportunity-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok);
  await withBoardWriter(root, async store => { assert.ok((await store.apply({ type: "start_job", jobId: queued.jobId, commandId: "start", issuedAt: plan.createdAt })).ok); });
  const planned = await planToolLearningStep({ boardRoot: root, plan, jobId: queued.jobId, attempt: 1, search: { status: "complete", candidates: [], failures: [] },
    signal: new AbortController().signal, occurredAt: plan.createdAt, services: { allowance: async () => allowance,
      context: async () => ({ availableTools: [], requirements: [] }), search: async () => { assert.fail("this decision needs no public search"); },
      evolve: async () => { assert.fail("a nomination is not execution authority"); }, plan: async context => {
        assert.deepEqual(context.requirements, requirements);
        assert.deepEqual(context.groundedSamples, []);
        return { action: "defer", reason: "more_evidence", neededEvidence: ["External task cases"], rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY",
          expectedBenefit: "hypothesis", constructionCost: "TEST ONLY", alternatives: [] };
      } } });
  assert.ok(planned.ok, JSON.stringify(planned));
});

test("npm contract grounding consumes captured user words as text and never promotes the model gap into an observed expected answer", async () => {
  const f = npmContractDataFixture(), { parent: _parent, ...input } = f.input;
  const task = captureToolTaskText("TEST_ONLY", "Return each input string after trimming and lowercasing; reject all other input kinds.");
  assert.ok(task);
  const plan = { ...input.plan, trigger: { ...input.plan.trigger, action: "replace_or_add" }, opportunity: {
    reportId: "r", source: "model" as const, assessment: report, executions: [], catalog: [], task } };
  const basis = await npmContractBasis({ ...input, plan });
  assert.ok(basis.ok);
  assert.equal(basis.requirements.length, 1);
  assert.equal(basis.requirements[0]?.ref, task.reference);
  assert.equal(basis.requirements[0]?.text.includes(report.need), false);
  const ground = npmContractGrounding({ ...input, plan }, basis);
  assert.ok(ground.ok);
  assert.deepEqual(ground.grounding.samples, []);
  const { task: _task, ...opportunity } = plan.opportunity;
  const hypothesis = await npmContractBasis({ ...input, plan: { ...plan, opportunity } });
  assert.ok(hypothesis.ok);
  assert.deepEqual(hypothesis.requirements, []);
});
