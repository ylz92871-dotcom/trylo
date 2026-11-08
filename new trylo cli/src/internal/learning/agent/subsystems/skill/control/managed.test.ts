import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createSkillCoordination } from "./coordination.js";
import { resolveManagedSkillSource } from "./managed.js";
import { journalExperienceFixture } from "../host/journal-experience-fixture.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";

test("managed Hermes source reads the exact canonical terminal and stays stable after a later task", async t => {
  const f = await journalExperienceFixture(t), turn = f.turn("turn:source");

  await turn.start("Implement a repeatable packaging procedure.");
  await turn.item({ kind: "assistant_text", blockId: "source-answer", text: "The corrected packaging command now works." });
  await turn.terminal();
  let state = emptyBoardState();
  const scope = path.dirname(f.filename);
  const coordination = createSkillCoordination({ board: {
    load: async () => ({ ok: true, state, generation: 0 }),
    apply: async command => {
      const next = reduce(state, command);
      if (next.ok) state = next.state;
      return next;
    },
  }, scope, ownerId: "managed-source-contract", now: () => "2026-11-04T13:00:00.000Z" });
  const report = await coordination.report({ sourceRef: "source:canonical-terminal", taskId: "turn:source", versionId: f.sessionId,
    facts: ["Actual test journal terminal"], evidenceRefs: ["journal:source"] });

  assert.ok(report.ok);
  const resolve = () => resolveManagedSkillSource({ issue: report.issue, scope,
    read: source => f.opportunity(source.turnId) }, new AbortController().signal);
  const first = await resolve();

  assert.equal(first.status, "ready");

  if (first.status !== "ready") throw new Error("source_not_ready");

  assert.equal(first.opportunity.sessionId, f.sessionId);
  assert.equal(first.opportunity.turnId, "turn:source");
  assert.equal(first.opportunity.trigger, "implicit");
  const later = f.turn("turn:later");
  await later.start("Different task.");
  await later.terminal();
  const again = await resolve();

  assert.equal(again.status, "ready");

  if (again.status !== "ready") throw new Error("source_not_ready");

  assert.equal(again.source.sourceBindingRef, first.source.sourceBindingRef);
  assert.equal(again.source.stageRef, first.source.stageRef);
  const context = { ref: "central-content:one", text: "Known: use the existing release recipe only for npm. Residual: retain the observed lockfile repair; other package managers remain untested." };
  const withContext = await resolveManagedSkillSource({ issue: report.issue, scope, context,
    read: source => f.opportunity(source.turnId) }, new AbortController().signal);

  assert.equal(withContext.status, "ready");

  if (withContext.status !== "ready") throw new Error("context_not_ready");

  const supplied = withContext.opportunity.experience?.centralLearningContext;

  assert.ok(supplied !== null && typeof supplied === "object" && "text" in supplied && "reference" in supplied);
  assert.equal(supplied.text, context.text);
  assert.equal(supplied.reference, context.ref);
  assert.notEqual(withContext.source.sourceBindingRef, first.source.sourceBindingRef);
});

test("a substituted session source cannot be consumed under another canonical report", async t => {
  const f = await journalExperienceFixture(t), turn = f.turn("turn:one");

  await turn.start("Bound source.");
  await turn.terminal();
  const issue = { schemaVersion: 1 as const, issueId: "issue:source", scope: "workspace:managed-source", problemKey: "problem:source",
    revision: 1, reports: [{ reportId: "report:source", source: { subsystem: "skill" as const,
      taskId: "turn:one", versionId: "different-session" }, facts: ["Source identity"], evidenceRefs: ["journal:source"] }],
    decision: { kind: "unreviewed" as const }, createdAt: "2026-11-04T13:00:00.000Z", updatedAt: "2026-11-04T13:00:00.000Z" };
  const result = await resolveManagedSkillSource({ issue, scope: issue.scope,
    read: source => f.opportunity(source.turnId) }, new AbortController().signal);

  assert.equal(result.status, "unavailable");

  if (result.status === "unavailable") assert.equal(result.reason, "hermes_skill_source_unavailable");
});
