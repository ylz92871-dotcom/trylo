import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { OrganizationDecision } from "../../learning/central/organization/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isContentDataSafe } from "../learning-content/content-confidentiality.js";
import { CONTENT_SOURCE_VIEW_POLICY, contentSourceTextViewRef } from "../learning-content/sources/source-text-view.js";
import { indexOrganizationDomainRows } from "./organization-feedback-domain.js";
import { createCentralOrganizationService } from "./organization-service.js";

test("serialized collaboration scope and secret become a labelled public source view without weakening original organization guards", async () => {
  const scope = "C:\\PrivateWorkspace\\Case", secret = "fixture-known-provider-secret-for-public-view";
  const original: JsonObject = { schemaVersion: 1, phase: "loaded", scope, receiptId: "receipt:synthetic-load",
    owner: { kind: "personal_agent", experienceKey: "trylo.personal_agent.v1" }, versionIds: ["version:synthetic"],
    boundary: { executionId: "execution:synthetic", taskId: "task:synthetic", round: 1, role: "personal_agent", configurationRef: secret },
    recordedAt: "2026-11-05T04:00:00.000Z" };
  const raw: JsonObject = { kind: "collaboration_use_fact", factRef: "receipt:synthetic-load", unitRef: "version:synthetic",
    revisionRef: "receipt:synthetic-load", original,
    interpretation: "Original recorded loaded receipt; no dispatch, following or independent benefit is inferred." };
  const frame = { sourceRef: "frame:synthetic-public-view", sourceRefs: ["receipt:synthetic-load", "version:synthetic"], records: [raw] };
  const originalBytes = canonicalJson(frame);
  const unprojected = indexOrganizationDomainRows(frame)[0]!.feedback;
  const projected = indexOrganizationDomainRows(frame, { scope, secrets: [secret] })[0]!.feedback;

  assert.equal(unprojected.result.kind, "progress");
  assert.equal(projected.result.kind, "progress");

  if (unprojected.result.kind !== "progress" || projected.result.kind !== "progress") return;

  assert.equal(isContentDataSafe(unprojected, { scope }, [secret]), false,
    "a serialized source scope is prose, not a privileged canonical scope slot");
  assert.equal(isContentDataSafe(projected, { scope }, [secret]), true,
    "the public-projected collaboration_use_fact must no longer carry the absolute scope or known secret");
  assert.equal(canonicalJson(frame), originalBytes, "the original owner frame and its raw source bytes remain unchanged");
  assert.equal(frame.sourceRef, "frame:synthetic-public-view");
  assert.equal(projected.unitRef, unprojected.unitRef);
  assert.deepEqual(projected.sourceRefs, unprojected.sourceRefs);
  assert.deepEqual(projected.result.resultRefs, unprojected.result.resultRefs);
  assert.ok(!projected.result.summary.includes("PrivateWorkspace"));
  assert.ok(!projected.result.summary.includes(secret));
  assert.ok(projected.result.summary.length <= 4096);
  const summary = JSON.parse(projected.result.summary);

  assert.equal(summary.sourceFactRef, raw.factRef);
  assert.equal(summary.sourceRevisionRef, raw.revisionRef);
  assert.equal(Object.hasOwn(summary, "original"), false, "changed presentation cannot pass raw source JSON off as public prose");
  assert.equal(summary.publicProjection.policy, CONTENT_SOURCE_VIEW_POLICY);
  assert.equal(summary.publicProjection.originalSourceHash, contentHashOf(unprojected.result.summary));
  assert.equal(summary.publicProjection.originalBodyHash, contentHashOf(raw));
  assert.equal(summary.publicProjection.projectionHash, contentHashOf(summary.publicText));
  assert.equal(summary.publicProjection.projectionRef, contentSourceTextViewRef(String(raw.factRef),
    summary.publicProjection.originalSourceHash, summary.publicProjection.projectionHash));
  assert.ok(summary.publicText.includes("<workspace>"));

  // Only the original Board port is injected. Real organization construction,
  // prefix replay, frozen-decision and publication safety guards still execute.
  let revision = 0;
  const facts: RewardV2Fact[] = [];
  const board = { async read() { return { revision, facts: [...facts] }; }, async append(expected: number, draft: RewardV2Draft) {
    const old = facts.find(fact => fact.id === draft.id);
    if (old !== undefined) return { status: "written" as const, revision, idempotent: true };
    if (expected !== revision) return { status: "stale" as const };
    revision++;
    facts.push({ ...draft, sequence: revision });
    return { status: "written" as const, revision, idempotent: false };
  } };
  const service = createCentralOrganizationService({ boardRoot: "unused-injected-original-board", scope, secrets: [secret], enabled: () => true, board });
  const decision: OrganizationDecision = { kind: "decision", decisionRef: "decision:public-view", purposeRef: "intent:public-view",
    context: { purpose: "Inspect the original loaded receipt through its public source view", conditionKeys: [], known: [], residual: ["Actual dispatch remains unknown"] },
    program: { programRef: "program:source-inspection", depth: "Inspect one original receipt", timing: "now" },
    expectation: { change: "Retain the source boundary without copying private metadata", uncertainties: ["Economic contribution is unknown"] },
    alternatives: ["Wait for more original evidence"], issueRefs: [], stageRefs: [], sourceRefs: ["receipt:synthetic-load"], experienceUse: null };
  const frozen = await service.freezeDecision(decision, revision);
  assert.equal(frozen.status, "saved");
  if (frozen.status !== "saved") return;

  const rawCandidate = { ...unprojected, decisionRef: decision.decisionRef };

  assert.deepEqual(await service.observe(rawCandidate, frozen.revision), { status: "rejected", reason: "organization_sensitive_content" });
  assert.equal(facts.length, 1, "the rejected raw source cannot cross the real publication guard");
  const candidate = { ...projected, decisionRef: decision.decisionRef };
  const published = await service.observe(candidate, frozen.revision);
  assert.equal(published.status, "saved");
  if (published.status !== "saved") return;

  assert.equal(facts.length, 2);
  assert.deepEqual(await service.observe({ ...candidate, supersedes: published.factId,
    sourceRefs: [...candidate.sourceRefs, "C:\\AnotherPrivateRoot\\evidence.txt"] }, published.revision),
  { status: "rejected", reason: "organization_sensitive_content" });
  assert.deepEqual(await service.observe({ ...candidate, supersedes: published.factId,
    result: { ...projected.result, summary: `${projected.result.summary}\n${secret}` } }, published.revision),
  { status: "rejected", reason: "organization_sensitive_content" });
  assert.equal(facts.length, 2, "public projection grants no exemption for sensitive refs or later prose");
  const stored = await service.read();
  assert.equal(stored.status, "ready");

  if (stored.status === "ready") assert.deepEqual(stored.projection.feedback[0]!.value, candidate);

  const clean = { ...raw, original: { ...original, scope: "workspace:public-source",
    boundary: { executionId: "execution:synthetic", taskId: "task:synthetic", round: 1, role: "personal_agent", configurationRef: "configuration:public" } } };
  const cleanFrame = { ...frame, records: [clean] };

  assert.deepEqual(indexOrganizationDomainRows(cleanFrame, { scope, secrets: [secret] }), indexOrganizationDomainRows(cleanFrame),
    "an unchanged safe source keeps its original summary bytes and unit identity");
});
