import { testScratchPath } from "../../../../../testing/scratch.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { enqueueToolLearningPlan, readToolLearningPipeline } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { toolPlanningResearch } from "./pipeline-research.js";

const occurredAt = "2026-11-04T00:00:00.000Z";
const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "research-scope", capability: "parse structured tables",
  trigger: { runId: "research-task", proposalKey: "table-gap", evidenceRefs: ["requirement:table"], action: "user_requested" }, createdAt: occurredAt };
const reasoning = { rationale: "Inspect candidate API to resolve input compatibility", existingInsufficiency: "Inventory lacks table parsing",
  expectedBenefit: "May replace repeated parsing work", constructionCost: "Bounded discovery and adaptation", alternatives: ["Compare existing tools before acquisition"] };
const candidate = { platform: "npm" as const, id: "table-parser", version: "1.2.3" };
const discovery = (id: string) => ({ status: "complete" as const, candidates: [{ ...candidate, id,
  sourceUrl: `https://www.npmjs.com/package/${id}`, licenseSpdx: "MIT" }], failures: [] });

async function fixture(t: TestContext) {
  const base = testScratchPath("tool-research-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok, JSON.stringify(queued));
  const services: ToolPipelineServices = { executionAuthorized: true,
    allowance: async () => ({ grantId: "central:research", maxCalls: 4, maxTokens: 20_000, callsRemaining: 4, tokensRemaining: 20_000, maxPromptChars: 50_000 }),
    search: async () => discovery(candidate.id), evolve: async () => { throw new Error("research must not execute generated code"); } };

  return { root, jobId: queued.jobId, input: { boardRoot: root, scope: plan.scope, now: () => 1793721600000,
    mode: "after_turn" as const, signal: new AbortController().signal, services } };
}

test("a funded investigation reads candidate API and revises alternatives across more than one search", async t => {
  const fx = await fixture(t);
  let calls = 0, searches = 0, inspections = 0;
  const decisions: ToolLearningDecision[] = [
    { ...reasoning, action: "research", query: "table parser library" },
    { ...reasoning, action: "research", inspect: { candidate, path: "src/index.ts" } },
    { ...reasoning, action: "research", query: "alternative parser supports malformed cells" },
    { ...reasoning, action: "acquire", candidate, adaptation: "Wrap parse(rows) after comparing documented malformed-cell behavior" },
  ];
  const text = "export function parse(rows: string[][]): Table; // rejects malformed cells";
  const services: ToolPipelineServices = { ...fx.input.services,
    plan: async context => {
      if (calls >= 2) assert.ok(context.research?.some(step => step.inspection?.documents[0]?.text.includes("parse(rows")), "API content must affect later planning");
      assert.equal(context.history?.length, calls);
      return decisions[calls++];
    },
    search: async () => discovery(++searches === 1 ? candidate.id : "other-parser"),
    inspect: async input => { inspections++;
    assert.deepEqual(input.candidate, candidate);
      return { status: "complete", candidate, documents: [{ sourceUrl: "https://api.github.com/repos/example/parser/contents/src/index.ts?ref=commit",
        path: "src/index.ts", contentHash: contentHashOf(text), text, truncated: false, kind: "source", revision: "f".repeat(40) }] }; },
  };
  const worked = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "acquisition_approval_required");
  assert.equal(calls, 4);
  assert.equal(searches, 2);
  assert.equal(inspections, 1);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  const facts = toolPlanningResearch(loaded.state, plan, fx.jobId);
  assert.ok(facts.ok);
  assert.equal(facts.research.length, 3);
  assert.equal(facts.history.length, 4);
  assert.equal(loaded.state.activations.length, 0);
  assert.equal(loaded.state.approvals.length, 0);
});

test("a repeated investigation stops before repeating network work and its own bookkeeping cannot wake it", async t => {
  const fx = await fixture(t);
  let searches = 0, calls = 0;
  const services: ToolPipelineServices = { ...fx.input.services,
    plan: async context => { calls++;
    return context.researchBoundary === undefined
      ? { ...reasoning, action: "research", query: calls === 1 ? "  Same   investigation  " : "same investigation" }
      : { ...reasoning, action: "defer", reason: "more_evidence", neededEvidence: ["A concrete interface incompatibility remains unverified"] }; },
    search: async () => {
      searches++;
      return discovery(candidate.id);
    } };
  const first = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(first.ok);
  assert.equal(first.results[0]?.code, "more_evidence");
  assert.equal(searches, 1);
  assert.equal(calls, 3);
  const resumed = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(resumed.ok);
  assert.equal(resumed.results.length, 0);
  assert.equal(searches, 1);
  assert.equal(calls, 3);
  const status = await readToolLearningPipeline(fx.root);
  assert.ok(status.ok);
  assert.equal(status.jobs[0]?.attempt, 1);
});

test("the last funded call explicitly asks for a final decision and cannot launch uninterpretable research", async t => {
  const fx = await fixture(t);
  let searches = 0;
  const services: ToolPipelineServices = { ...fx.input.services,
    allowance: async () => ({ grantId: "central:research", maxCalls: 1, maxTokens: 20_000, callsRemaining: 1, tokensRemaining: 20_000, maxPromptChars: 50_000 }),
    plan: async context => { assert.deepEqual(context.researchBoundary, { furtherInvestigation: "closed", reason: "research_capacity" });
      return { ...reasoning, action: "research", query: "unfunded next step" }; },
    search: async () => {
      searches++;
      return discovery(candidate.id);
    } };
  const worked = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "research_closed");
  assert.equal(searches, 0);
});

test("a final funded interpretation can preserve missing evidence without another investigation", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const services: ToolPipelineServices = { ...fx.input.services,
    allowance: async () => ({ grantId: "central:research", maxCalls: 1, maxTokens: 20_000, callsRemaining: 1, tokensRemaining: 20_000, maxPromptChars: 50_000 }),
    plan: async context => { calls++;
    assert.equal(context.researchBoundary?.furtherInvestigation, "closed");
      return { ...reasoning, action: "defer", reason: "more_evidence", neededEvidence: ["A real malformed-table contract is still missing"] }; },
    search: async () => { assert.fail("the final interpretation has no new research authority"); } };
  const worked = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "more_evidence");
  assert.equal(calls, 1);
  const status = await readToolLearningPipeline(fx.root);
  assert.ok(status.ok);
  const result = status.jobs.find(row => row.jobId === fx.jobId)?.result;
  assert.ok(result?.decision?.action === "defer");
  assert.deepEqual(result.decision.neededEvidence, ["A real malformed-table contract is still missing"]);
});

test("a reformulated local lookup exposes a real overlooked tool and revalidates it before reuse", async t => {
  const fx = await fixture(t);
  let calls = 0, lookups = 0, searches = 0;
  const tool = { toolId: "runtime:zz-table", description: "Parse CSV tables with missing cells", versionId: "table-v1" };
  const services: ToolPipelineServices = { ...fx.input.services,
    context: async () => ({ availableTools: [], requirements: [] }),
    search: async () => {
      searches++;
      return discovery(candidate.id);
    },
    lookup: async query => {
      lookups++;
      return { query, candidates: [tool], total: 1, truncated: false };
    },
    plan: async context => {
      if (calls++ === 0) return { ...reasoning, action: "research", libraryQuery: "CSV" };
      assert.equal(context.availableTools[0]?.toolId, tool.toolId);
      return { ...reasoning, action: "reuse", toolId: tool.toolId, usage: "Use its existing missing-cell mode" };
    } };
  const worked = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "existing_capability_reused");
  assert.equal(searches, 0);
  assert.equal(lookups, 2);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.ok(loaded.state.assets.some(asset => typeof asset.content === "object" && asset.content !== null
    && "selectedToolVersionId" in asset.content && asset.content.selectedToolVersionId === tool.versionId));
});
