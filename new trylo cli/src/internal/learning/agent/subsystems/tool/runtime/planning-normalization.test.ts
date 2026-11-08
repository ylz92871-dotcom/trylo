import test from "node:test";
import assert from "node:assert/strict";
import { seedToolProduction } from "../testing/production-fixtures.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { boundToolLearningContext } from "../domain/evolution/learning-context-budget.js";
import { decodeToolLearningDecision, type ToolLearningContext } from "../domain/evolution/learning-plan.js";
import { normalizeToolPlanningDecision } from "./planning-normalization.js";
import { decisionBindingFailure } from "./learning-context.js";

test("a large parent is offered as an explicit excerpt and a short exact reference resolves to its full archived source", async t => {
  const fx = await seedToolProduction(t), original = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(original.ok);
  const candidate = { ...original.artifact.candidate, source: `${original.artifact.candidate.source}\n/*${"archived comment ".repeat(1600)}*/` };
  const saved = await createToolEvolutionArchive(fx.root).save({ ...original.artifact, candidate,
    verification: { ...original.artifact.verification, candidateHash: contentHashOf(candidate) } });
  assert.ok(saved.ok);
  const prior = { versionId: saved.versionId, capability: original.artifact.request.capability, source: candidate.source,
    evidence: original.artifact.request.evidence, feedback: "An exact user request asks to improve this archived version" };
  const context: ToolLearningContext = { plan: { type: "tool_learning_plan", schemaVersion: 1, scope: original.artifact.request.scope,
    capability: prior.capability, targetVersionId: prior.versionId, createdAt: original.artifact.generatedAt,
    trigger: { runId: "large-parent-task", proposalKey: "large-parent", action: "user_requested", evidenceRefs: [] } },
  allowance: { grantId: "TEST-allowance", maxCalls: 8, callsRemaining: 8, maxTokens: 96000, tokensRemaining: 96000, maxPromptChars: 24000 },
  search: { status: "complete", candidates: [], failures: [] }, availableTools: [], requirements: [], priorVersions: [prior],
  groundedSamples: prior.evidence.map(sample => ({ ref: `${prior.versionId}:${sample.sampleId}`, sample })) };
  const bounded = boundToolLearningContext(context);
  assert.ok(bounded);
  const view = bounded.priorVersions[0];
  assert.ok(view);
  assert.equal(view.source, undefined);
  assert.equal(view.sourceHash, contentHashOf(candidate.source));
  assert.equal(view.sourceChars, candidate.source.length);
  assert.equal(view.excerptTruncated, true);
  assert.equal(view.sourceExcerpt?.length, 4000);
  const raw = { action: "improve", rationale: "Repair the exact parent", existingInsufficiency: "Existing implementation needs a narrow update",
    expectedBenefit: "Hypothesized reliability gain", constructionCost: "One source edit", alternatives: ["Retain the existing version if no change is justified"],
    request: { ...original.artifact.request, operation: "improve", prior: { versionId: saved.versionId, sourceHash: view.sourceHash } },
    sampleOrigins: prior.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${prior.versionId}:${sample.sampleId}` })) };
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  const normalized = normalizeToolPlanningDecision(raw, bounded, loaded.state);
  assert.ok(normalized.ok);
  const decoded = decodeToolLearningDecision(normalized.value);
  assert.ok(decoded && decoded.action === "improve");
  assert.equal(decoded.request.prior?.source, candidate.source);
  assert.equal(decisionBindingFailure(decoded, bounded), undefined);
  const mismatch = normalizeToolPlanningDecision({ ...raw, request: { ...raw.request,
    prior: { ...raw.request.prior, source: "partial source is not the archived parent" } } }, bounded, loaded.state);

  assert.equal(mismatch.ok, false, "a supplied mismatch must be refused rather than silently overwritten");
});
