import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralOrganizationFeedbackRefresh } from "./organization-feedback.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { indexOrganizationDomainRows, projectOrganizationDomainRows } from "./organization-feedback-domain.js";
import { projectOrganizationCosts } from "./organization-feedback-cost.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { CentralLearningBudget } from "../../learning/control/central-budget-contract.js";
import type { OrganizationDecision } from "../../learning/central/organization/index.js";
import type { JsonObject } from "../../protocol/envelope.js";

const scope = "workspace:organization-followup", at = "2026-11-05T01:00:00Z";
const decision: OrganizationDecision = { kind: "decision", decisionRef: "decision:workflow", purposeRef: "intent:workflow",
  context: { purpose: "Reduce repeated handoff work", conditionKeys: ["handoff"], known: [], residual: ["Does the change help in later use?"] },
  program: { programRef: "workflow:research", depth: "bounded", timing: "now" }, expectation: { change: "Prepare a conditional improvement", uncertainties: ["economic gain unknown"] },
  alternatives: ["Wait for business feedback"], issueRefs: ["issue:workflow"], stageRefs: ["operation:workflow"],
  sourceRefs: ["reservation:central", "budget:root", "version:improvement"], experienceUse: null };
const frozenUse: JsonObject = { kind: "workflow_frozen_use", recordRef: "use-record:1", useId: "use:1", versionId: "version:improvement" };
const feedback = (quality: string, recordRef: string): JsonObject => ({ kind: "workflow_feedback", recordRef, feedbackId: "feedback:1",
  useId: "use:1", versionId: "version:improvement", executionId: "execution:1", exposure: "reported_used", quality,
  evidenceRefs: ["host-check:1"], followedStepIds: ["step:1"], explanation: "Original host/user channel measurement", processEvidence: { kind: "verified" } });

test("related late business feedback and exact root cost become visible before the first organization knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-organization-followup-"));
  assert.equal(dirname(root), resolve(tmpdir()));

  try {
    const opened = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: "root:open", issuedAt: at,
      action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "budget:root", scope,
        unit: "total_model_tokens", limits: { tokens: 1000, calls: 4, steps: 4 }, authorizationRef: "authorization:explicit" } } }));

    assert.ok(opened.ok);
    const reported = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: "source:workflow", issuedAt: at,
      action: { kind: "report", scope, issueId: "issue:workflow", problemKey: "workflow:handoff",
        report: { reportId: "report:workflow", source: { subsystem: "workflow", taskId: "task:workflow", versionId: "version:improvement" },
          facts: ["Original workflow handoff observation"], evidenceRefs: ["host-check:source"] } } }));

    assert.ok(reported.ok);
    const funding = createCentralAccountingFundingAtRoot({ boardRoot: root, budgetId: "budget:root", scope,
      owner: { kind: "central_deliberation", ownerId: "central:scope" }, enabled: () => true, now: () => at });

    assert.ok((await funding.reserve({ reservationId: "reservation:central", maxTokens: 500 })).ok);
    const service = createCentralOrganizationService({ boardRoot: root, scope, enabled: () => true });
    const initial = await service.read();
    assert.equal(initial.status, "ready");
    if (initial.status !== "ready") return;

    const centralDecision = { ...decision, issueRefs: ["question:central-purpose"] };

    assert.equal((await service.freezeDecision(centralDecision, initial.revision)).status, "saved");
    const progressSaved = await service.observe({ kind: "feedback", decisionRef: decision.decisionRef, unitRef: "operation:native-return", supersedes: null,
      sourceRefs: ["issue:workflow"], result: { kind: "progress", summary: "Actual native work returned original issue binding", remaining: ["Await real use"],
        resultRefs: ["issue:workflow"] } }, initial.revision + 1);

    assert.equal(progressSaved.status, "saved");
    let frame = { sourceRef: "workflow-frame:before-use", sourceRefs: ["version:improvement"], records: [frozenUse] };
    let sourceReads = 0;
    const refresh = createCentralOrganizationFeedbackRefresh({ boardRoot: root, scope, workspaceId: "original-workspace-id", enabled: () => true,
      service, project: (_board, selection) => { sourceReads++;
      assert.equal(selection.workspaceId, "original-workspace-id");
        assert.equal(selection.issueId, "issue:workflow", "central question identity must resolve through actual native work references");
      return frame; } });
    const noSelection = await refresh.refresh({}, new AbortController().signal);
    assert.equal(noSelection.status, "ready");

    if (noSelection.status === "ready") assert.equal(noSelection.materials.length, 0);

    assert.equal(sourceReads, 0, "no fallback to oldest decisions");
    const first = await refresh.refresh({ sourceRefs: ["issue:workflow"] }, new AbortController().signal);

    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;

    assert.ok(first.materials.some(material => material.text.includes("original_reservation_unsettled")));
    assert.ok(!first.materials.some(material => material.text.includes('"state":"observed"')));
    assert.ok((await funding.settle({ reservationId: "reservation:central", usage: { kind: "reported", totalTokens: 120 } })).ok);
    frame = { ...frame, sourceRef: "workflow-frame:used", records: [frozenUse, feedback("passed", "feedback-record:1")] };
    const late = await refresh.refresh({ sourceRefs: ["issue:workflow"] }, new AbortController().signal);

    assert.equal(late.status, "ready");
    if (late.status !== "ready") return;

    const view = await service.read();
    assert.equal(view.status, "ready");
    if (view.status !== "ready") return;

    assert.equal(view.projection.knowledge.length, 0);
    const outcome = view.projection.feedback.find(row => row.value.result.kind === "outcome");
    assert.ok(outcome);
    assert.ok(late.materials.some(material => readOrganizationFeedbackMaterial(material, scope)?.factId === outcome.factId
      && material.text.includes('"attribution":"unknown"')));
    const cost = view.projection.feedback.find(row => row.value.result.kind === "cost");
    assert.ok(cost);
    assert.deepEqual(cost.value.result, { kind: "cost", usage: { kind: "reported", tokens: 120, calls: 1, steps: 1 } });
    const stable = await refresh.refresh({ sourceRefs: ["issue:workflow"] }, new AbortController().signal);

    assert.equal(stable.status, "ready");
    if (stable.status === "ready") assert.equal(stable.revision, late.revision, "no self-triggering Board writes");

    const legacyRef = "decision:legacy-background";
    const beforeLegacy = await service.read();
    assert.equal(beforeLegacy.status, "ready");
    if (beforeLegacy.status !== "ready") return;

    const legacy = await service.freezeDecision({ ...decision, decisionRef: legacyRef, purposeRef: "intent:legacy-background",
      stageRefs: [], sourceRefs: ["source:legacy-issue-background"] }, beforeLegacy.revision);

    assert.equal(legacy.status, "saved");
    if (legacy.status !== "saved") return;

    const originalAdoption = view.projection.feedback.find(row => row.value.decisionRef === decision.decisionRef
      && row.value.result.kind === "adoption")!;
    const legacyAdoption = await service.observe({ ...originalAdoption.value, decisionRef: legacyRef, supersedes: null }, legacy.revision);

    assert.equal(legacyAdoption.status, "saved");
    if (legacyAdoption.status !== "saved") return;

    const legacyOutcome = await service.observe({ ...outcome.value, decisionRef: legacyRef, supersedes: null }, legacyAdoption.revision);

    assert.equal(legacyOutcome.status, "saved");
    if (legacyOutcome.status !== "saved") return;

    // This is an existing historical association, not permission to fan out new
    // source units to every same-issue decision after ownership became stricter.
    frame = { ...frame, sourceRef: "workflow-frame:correction", records: [frozenUse, { ...feedback("unknown", "feedback-record:corrected"),
      userAssessment: { judgment: "harmed", evidenceRef: "user:correction" } }] };
    const corrected = await refresh.refresh({ sourceRefs: ["issue:workflow"] }, new AbortController().signal);

    assert.equal(corrected.status, "ready");
    if (corrected.status !== "ready") return;

    const final = await service.read();
    assert.equal(final.status, "ready");
    if (final.status !== "ready") return;

    const originalRows = final.projection.feedback.filter(row => row.value.decisionRef === decision.decisionRef);

    assert.equal(originalRows.filter(row => row.value.result.kind === "outcome").length, 1);
    assert.equal(originalRows.find(row => row.value.result.kind === "outcome")?.value.result.kind, "outcome");
    const correction = originalRows.find(row => row.value.result.kind === "correction");
    assert.ok(correction);
    assert.ok(correction.value.result.kind === "correction" && correction.value.result.statement.includes("harmed"));
    assert.ok(corrected.materials.some(material => readOrganizationFeedbackMaterial(material, scope)?.factId === correction.factId));
    const finalOutcome = originalRows.find(row => row.value.result.kind === "outcome")!;

    assert.equal(finalOutcome.value.result.kind === "outcome" && finalOutcome.value.result.state, "unknown");
    assert.equal(finalOutcome.value.supersedes, outcome.factId);
    const legacyRows = final.projection.feedback.filter(row => row.value.decisionRef === legacyRef);
    const revisedLegacy = legacyRows.find(row => row.value.result.kind === "outcome")!;

    assert.equal(revisedLegacy.value.result.kind === "outcome" && revisedLegacy.value.result.state, "unknown",
      "an existing legacy background outcome must follow the original F correction instead of staying observed");
    assert.equal(revisedLegacy.value.supersedes, legacyOutcome.factId);
    assert.equal(revisedLegacy.value.unitRef, outcome.value.unitRef);
    assert.ok(revisedLegacy.value.result.kind === "outcome" && revisedLegacy.value.result.summary.includes("harmed"));
    assert.equal(legacyRows.length, 2, "updating legacy heads adds neither a new correction nor another source unit for E");
    assert.ok(!legacyRows.some(row => row.value.result.kind === "correction"));
    assert.ok(corrected.materials.some(material => {
      const body: unknown = JSON.parse(material.text);
      return typeof body === "object" && body !== null && "role" in body
        && body.role === "organization_feedback_relationship_catalog_not_read_body" && "entries" in body && Array.isArray(body.entries)
        && body.entries.some(entry => typeof entry === "object" && entry !== null && entry.decisionRef === legacyRef
          && entry.relation === "related_background" && entry.factId === revisedLegacy.factId);
    }));
    const other = await service.freezeDecision({ ...decision, decisionRef: "decision:other-from-same-planning-call" }, final.revision);

    assert.equal(other.status, "saved");
    const shared = await refresh.refresh({ decisionRefs: [decision.decisionRef] }, new AbortController().signal);

    assert.equal(shared.status, "ready");
    if (shared.status !== "ready") return;

    assert.ok(shared.materials.some(material => material.text.includes("shared_original_cost_units_not_additive_decision_spend")
      && material.text.includes("decision:other-from-same-planning-call") && material.text.includes('"allocatedCostForEachDecision":"unknown"')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("domain conversion keeps source identities stable, recognizes explicit non-use and never upgrades skill load", () => {
  const before = { sourceRef: "frame:1", sourceRefs: ["source:1"], records: [frozenUse, feedback("passed", "feedback-record:1")] };
  const rows = projectOrganizationDomainRows("decision:1", before, ["version:improvement"]);
  const after = projectOrganizationDomainRows("decision:1", { ...before, sourceRef: "frame:2", records: [...before.records,
    { kind: "native_approved", sourceRef: "skill-approval:1", grantId: "grant:skill" }] }, ["version:improvement"]);

  assert.deepEqual(after.filter(row => !row.sourceRefs.includes("skill-approval:1")), rows);
  assert.ok(!after.some(row => row.sourceRefs.includes("skill-approval:1") && row.result.kind !== "progress"));
  const skipped = projectOrganizationDomainRows("decision:1", { ...before, records: [frozenUse,
    { ...feedback("unknown", "feedback-record:skipped"), exposure: "skipped" }] }, ["version:improvement"]);

  assert.equal(skipped.find(row => row.result.kind === "outcome")?.unitRef, rows.find(row => row.result.kind === "outcome")?.unitRef);
  assert.ok(skipped.some(row => row.result.kind === "outcome" && row.result.state === "unknown"));
  assert.ok(skipped.some(row => row.result.kind === "adoption" && row.result.state === "not_observed"));
  const restored = indexOrganizationDomainRows({ sourceRef: "frame:source-revisions", sourceRefs: ["version:improvement"], records: [frozenUse,
    feedback("passed", "feedback-record:used-first"), { ...feedback("unknown", "feedback-record:skipped-middle"), exposure: "skipped" },
    feedback("passed", "feedback-record:used-latest")] }).map(row => row.feedback);

  assert.ok(restored.some(row => row.result.kind === "adoption" && row.result.state === "used"));
  assert.ok(!restored.some(row => row.result.kind === "adoption" && row.result.state === "not_observed"));
  assert.ok(restored.some(row => row.result.kind === "outcome" && row.result.state === "observed"));
  assert.equal(restored.find(row => row.result.kind === "adoption")?.unitRef, rows.find(row => row.result.kind === "adoption")?.unitRef);
  assert.equal(restored.find(row => row.result.kind === "outcome")?.unitRef, rows.find(row => row.result.kind === "outcome")?.unitRef);
});

test("reservation references cannot claim the same named reservation from another root", () => {
  const budget = (budgetId: string, tokens: number): CentralLearningBudget => ({ schemaVersion: 1, budgetId, scope,
    unit: "total_model_tokens", limits: { tokens: 1000, calls: 10, steps: 10 }, authorizationRef: "auth:explicit",
    mode: "exclusive_new_funding", openedAt: at, openedSequence: 1, accounting: [{ reservationId: "reservation:central",
      owner: { kind: "central_deliberation", ownerId: "central:scope" }, maxTokens: 100, reservedAt: at, reservedSequence: 2,
      state: "settled", usage: { kind: "reported", totalTokens: tokens } }] });
  const stored = { factId: "organization-record:decision", sequence: 1, value: decision };
  const costs = projectOrganizationCosts({ ...emptyBoardState(), centralLearningBudgets: [budget("budget:root", 10), budget("budget:other", 20)] },
    { scope, decisions: [stored], feedback: [], feedbackHistory: [], knowledge: [] }, stored);

  assert.equal(costs.length, 1);
  assert.deepEqual(costs[0]?.result, { kind: "cost", usage: { kind: "reported", tokens: 10, calls: 1, steps: 1 } });
});

