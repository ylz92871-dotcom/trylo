import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { recordOf } from "../domain/evolution/parse.js";
import { createToolEvolutionArchive } from "../runtime/evolution-archive.js";
import { openToolCandidateUse } from "../runtime/evolution-use.js";
import { createToolLearningReportTools } from "../runtime/learning-report-tool.js";
import { createToolGapRuntime } from "../runtime/awareness-runtime.js";
import { createToolLearningFunding } from "../runtime/learning-funding.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "../runtime/pipeline-worker.js";

/** Real Board/use/report/funding paths, controlled executor and model decisions.
 * No provider, installation, execution permission or production quality claim. */
export async function feedbackInquiryFixture(t: TestContext) {
  const base = testScratchPath("feedback-inquiry-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = "feedback-inquiry-test", now = () => 1000;
  const candidate = { identity: "double", description: "TEST ONLY double", source: "module.exports=input=>input*2;", inputSchema: {},
    mastery: { whenToUse: ["TEST ONLY doubling finite numeric inputs"], preconditions: [], pitfalls: [] } };
  const request = { schemaVersion: 1 as const, requestId: "parent", scope, capability: "Double finite numbers", operation: "create" as const, evidence: [
    { sampleId: "a", role: "source" as const, input: 1, expected: { kind: "value" as const, value: 2 } },
    { sampleId: "b", role: "source" as const, input: 2, expected: { kind: "value" as const, value: 4 } },
    { sampleId: "v", role: "variation" as const, input: 0, expected: { kind: "value" as const, value: 0 } },
    { sampleId: "c", role: "counterexample" as const, input: null, expected: { kind: "error" as const, code: "invalid_input" } },
  ] };
  const artifact = { schemaVersion: 1 as const, request, candidate, generatedAt: new Date(0).toISOString(), verification: { verdict: "pass" as const,
    candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence), checks: request.evidence.map(sample => ({ sampleId: sample.sampleId,
      role: sample.role, outcome: "passed" as const, detail: "TEST ONLY parent archive shape" })) } };
  const saved = await createToolEvolutionArchive(root).save(artifact);
  assert.ok(saved.ok, JSON.stringify(saved));
  let use = 0;
  const opened = await openToolCandidateUse({ boardRoot: root, versionId: saved.versionId, sessionId: "session", workspaceId: "workspace", now,
    newId: () => `use-${++use}`, warn: () => {}, executor: { execute: async (_candidate, input) => ({ kind: "value", value: typeof input === "number" ? input * 2 : null }) } });
  assert.ok(opened.ok, JSON.stringify(opened));
  t.after(opened.mount.close);
  const useTool = async () => { const outcome = await opened.mount.tools.execute({ name: opened.mount.binding.name,
    toolCallId: `actual-call-${use + 1}`, arguments: { input: use + 1 } }, new AbortController().signal);
  assert.equal(outcome.outcome, "result");
  return `use-${use}`; };

  await useTool();
  await useTool();
  const state = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  let dispatches = 0;
  const runtime = createToolGapRuntime({ now, warn: () => {}, ledger: { append: async () => {}, tail: async () => [] } });
  t.after(runtime.close);
  const report = async (turnId: string, feedbackId: string, fields: JsonObject = {}) => {
    const tools = createToolLearningReportTools({ runtime, boardRoot: root, workspaceId: "workspace", sessionId: "session", taskId: turnId,
      now, afterQueued: () => { dispatches++; } });
    const outcome = await tools.execute({ name: "tool_learning_report", toolCallId: feedbackId, arguments: { operation: "feedback", report: {
      versionId: saved.versionId, useIds: ["use-1", "use-2"], situation: "one task", evidenceRefs: ["task:actual"], outcome: "unsolved",
      attribution: "implementation", recommendation: "improve", summary: "TEST ONLY investigate these actual uses", ...fields,
    } } }, new AbortController().signal);

    assert.equal(outcome.outcome, "result", JSON.stringify(outcome));
    if (outcome.outcome !== "result") assert.fail("public report must succeed");

    assert.ok(recordOf(outcome.value.learning));
    return outcome.value.learning;
  };
  const work = async (mode: "succeeded" | "waiting_evidence" | "waiting_approval", onPlanning?: () => Promise<void>) => {
    const funding = createToolLearningFunding({ boardRoot: root, scope, now });
    let calls = 0;
    const reasoning = { rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY", expectedBenefit: "hypothesis", constructionCost: "TEST ONLY", alternatives: [] };
    const services: ToolPipelineServices = { allowance: plan => funding.allowance(plan), releaseAllowance: () => funding.release(),
      context: async () => ({ availableTools: [], requirements: [] }), evolve: async () => { assert.fail("no source construction is needed for this budget test"); },
      search: async () => ({ status: "complete", candidates: [{ platform: "npm", id: "TEST_ONLY-package", version: "1.0.0", licenseSpdx: "MIT", sourceUrl: "https://www.npmjs.com/package/TEST_ONLY-package" }], failures: [] }),
      plan: async context => {
        const reservationId = `controlled-planning-${++calls}`;
        assert.ok((await funding.reserve(reservationId, 512)).ok);
        assert.ok((await funding.settle(reservationId, { kind: "reported", inputTokens: 50, outputTokens: 50, totalTokens: 100, model: "TEST ONLY" })).ok);
        await onPlanning?.();

        return mode === "waiting_approval" ? context.search.candidates.length === 0
          ? { ...reasoning, action: "research", query: "TEST ONLY existing package" }
          : { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "TEST_ONLY-package", version: "1.0.0" }, adaptation: "TEST ONLY pending user approval" }
          : { ...reasoning, action: "defer", reason: mode === "succeeded" ? "not_worthwhile" : "more_evidence", neededEvidence: ["independent task facts"] };
      } };
    const result = await workToolLearningPipeline({ boardRoot: root, scope, now, services, mode: "after_turn", signal: new AbortController().signal });

    assert.ok(result.ok);
    return result;
  };

  return { root, scope, now, parentVersionId: saved.versionId, state, useTool, report, work, dispatches: () => dispatches };
}
