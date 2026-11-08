import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolPort } from "../../ports/tools.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { publishCollaborationArtifact } from "../../learning/agent/subsystems/collaboration/artifacts/publish.js";
import type { CollaborationPlan } from "../../learning/agent/subsystems/collaboration/orchestration/contracts.js";
import { createPersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createDenyAllPermission } from "./permission.js";

const NOW = "2026-11-04T00:00:00.000Z";
const unexpected = (): never => { throw new Error("Plan inspection must not execute models, permissions or business tools"); };

test("the original PA inspect tools retain an older selected issue's plan, share full freshness and reject a hidden plan withdrawal", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-plan-inspection-")), scope = path.join(root, "workspace");

  t.after(() => {
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^trylo-plan-inspection-/);
    rmSync(root, { recursive: true, force: true });
  });
  const board = createFileCollaborationBoard(methodBoardRoot(root, {}));
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "plan-inspection-contract" });
  const published: { issueId: string; versionId: string; revision: number }[] = [];

  for (let index = 0; index < 10; index++) {
    const reportId = `report:arrangement-${index}`, report = await control.report({ scope, problemKey: `arrangement-${index}`,
      report: { reportId, source: { teamRunId: "team:plan", taskId: `task:${index}`, memberId: "worker" }, facts: ["The task needs a concrete division adjustment."], evidenceRefs: [] } });
    assert.ok(report.ok);
    const focus = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision, decision: "focused_learning",
      reason: "PA selected this bounded arrangement.", sourceRefs: [reportId] });
    assert.ok(focus.ok);
    assert.ok(focus.issue.decision.kind === "focused_learning");
    const plan: CollaborationPlan = { schema: "collaboration-plan/v1", issueId: focus.issue.issueId, focusRevision: focus.issue.decision.revision,
      familyId: `arrangement-${index}`, title: `Arrangement ${index}`, summary: "A proposed assignment refinement.", sourceRefs: [reportId],
      adjustments: [{ memberId: "worker", kind: "division", instruction: "Keep the shared decision with the original owner." }], experienceVersionIds: [], needs: [] };
    const result = await publishCollaborationArtifact({ board, scope, now: () => NOW }, { issueId: plan.issueId, familyId: plan.familyId, title: plan.title,
      hypothesis: plan.summary, sourceRefs: plan.sourceRefs, content: plan, schemaVersion: 3, kind: "plan" });
    assert.ok(result.ok);
    published.push({ issueId: focus.issue.issueId, revision: focus.issue.revision, versionId: result.versionId });
  }

  const tools: ToolPort = { snapshot: () => [], execute: unexpected, cancel: unexpected };
  const runtime = createPersonalAgentRuntime({ homeDir: root, env: {}, scope, turnId: "turn:plan-inspection", choice: 1000,
    now: () => Date.parse(NOW), warn: unexpected, newOwnerId: () => "plan-inspection-runtime", model: "local-development-only",
    provider: { stream: unexpected }, tools, workspaceTools: tools, permission: createDenyAllPermission(), grants: createPermissionGrantCache(),
    sandbox: { policy: { mode: "deny_all", network: "restricted", workspaceRoot: scope, maxWriteBytes: 0, allowAbsoluteExecutable: false }, evaluate: unexpected } });

  t.after(() => runtime.close());
  let sequence = 0;
  const call = async (name: string, args: JsonObject) => {
    const result = await runtime.tools.execute({ name, arguments: args, toolCallId: `plan-inspect:${++sequence}` }, new AbortController().signal);
    assert.equal(result.outcome, "result");
    if (result.outcome !== "result") throw new Error("Missing original tool result");
    return JSON.parse(result.output);
  };
  const chosen = published[0]!, hidden = published[1]!;
  const full = await call("collaboration_inspect", {}), focused = await call("collaboration_inspect", { issueId: chosen.issueId });

  assert.equal(full.ok, true);
  assert.equal(focused.ok, true);
  assert.equal(full.inspectionId, focused.inspectionId);
  assert.equal(full.resources.plans.length, 8);
  assert.ok(!full.resources.plans.some((plan: { versionId: string }) => plan.versionId === hidden.versionId));
  assert.deepEqual(focused.resources.plans.map((plan: { versionId: string }) => plan.versionId), [chosen.versionId],
    "a known issue's qualified plan must survive unrelated issue traffic");
  assert.deepEqual(full.resources.owners.find((owner: { ref: string }) => owner.ref === "personal_agent").input.context,
    { surface: "code", useScope: { workspaceId: scope, taskId: "turn:plan-inspection" } },
    "PA discovery supplies the same actual task scope as its normal execution-side retrieval");
  assert.equal(full.resources.planSummary.availableProposalCount, 10);
  assert.equal(focused.resources.planSummary.matchingProposalCount, 1);
  assert.equal(focused.resources.planSummary.unrelatedProposalCount, 9);
  assert.ok((await board.apply({ type: "tombstone", commandId: "withdraw:hidden-plan", issuedAt: NOW, entityId: hidden.versionId,
    entityType: "asset", reason: "Withdraw a hidden arrangement." })).ok);
  assert.deepEqual(await call("collaboration_decide", { inspectionId: focused.inspectionId, issueId: chosen.issueId, expectedRevision: chosen.revision,
    decision: "ordinary_execution", reason: "Apply only the current original arrangement.", sourceRefs: [] }),
  { ok: false, reason: "collaboration_state_changed_inspect_again" });
  const fresh = await call("collaboration_inspect", { issueId: chosen.issueId });

  assert.notEqual(fresh.inspectionId, focused.inspectionId);
  assert.deepEqual(fresh.resources.plans, focused.resources.plans);
  assert.equal(fresh.resources.planSummary.availableProposalCount, 9);
  assert.equal((await call("collaboration_decide", { inspectionId: fresh.inspectionId, issueId: chosen.issueId, expectedRevision: chosen.revision,
    decision: "ordinary_execution", reason: "Use the current original scheduling tools.", sourceRefs: [] })).ok, true);
  const final = await board.load();
  assert.ok(final.ok);
  assert.equal(final.state.jobs.length, 0);
  assert.equal(final.state.centralLearningGrants?.length ?? 0, 0);
});
