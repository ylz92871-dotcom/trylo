import assert from "node:assert/strict";
import test from "node:test";
import { createSkillCoordination } from "./coordination.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { skillStageFunding } from "./stage-funding.js";

const scope = "workspace:managed-skill-dispatch", now = "2026-11-04T13:00:00.000Z";

async function fixture() {
  let state = emptyBoardState(), race = false;
  const board: Pick<BoardStore, "load" | "apply"> = {
    load: async () => ({ ok: true, state, generation: 0 }),
    async apply(command) {
      if (race && command.type === "coordinate_learning" && command.action.kind === "claim") {
        race = false;
        const issue = state.learningIssues![0]!;
        const changed = reduce(state, { type: "coordinate_learning", commandId: "race:new-source-report", issuedAt: now,
          action: { kind: "report", scope, issueId: issue.issueId, problemKey: issue.problemKey,
            report: { reportId: "report:later-source", source: { subsystem: "skill", taskId: "turn:later", versionId: "session:one" },
              facts: ["New actual source arrived before the writer admitted the claim."], evidenceRefs: ["journal:later"] } } });

        assert.ok(changed.ok);
        state = changed.state;
      }

      const next = reduce(state, command);
      if (next.ok) state = next.state;
      return next;
    },
  };
  const coordination = createSkillCoordination({ board, scope, ownerId: "managed-skill-contract", now: () => now });
  const report = await coordination.report({ sourceRef: "journal:one", taskId: "turn:one", versionId: "session:one",
    facts: ["Synthetic source used only to test claim identity."], evidenceRefs: ["journal:one"] });

  assert.ok(report.ok);
  const focus = await coordination.focus({ issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    reason: "Contract-only bounded allocation", sourceRefs: ["journal:one"], allowance: { schemaVersion: 2,
      unit: "total_model_tokens", maxTokens: 10000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } });

  assert.ok(focus.ok);

  return { coordination, focus, state: () => state, race: () => { race = true; } };
}

test("managed dispatch never substitutes another grant of the selected issue", async () => {
  const f = await fixture(), before = JSON.stringify(f.state());
  let invoked = false;
  const result = await f.coordination.run({ issueId: f.focus.issue.issueId, expectedGrantId: "grant:other",
    expectedIssueRevision: f.focus.issue.revision, signal: new AbortController().signal,
    async worker() {
      invoked = true;
      return { kind: "completed", resultRefs: [] };
    } });
  assert.deepEqual(result, { ok: false, reason: "hermes_managed_binding_stale" });
  assert.equal(invoked, false);
  assert.equal(JSON.stringify(f.state()), before);
});

test("the original Board writer rejects a source revision racing managed skill claim without closing its grant", async () => {
  const f = await fixture();
  f.race();
  let invoked = false;
  const result = await f.coordination.run({ issueId: f.focus.issue.issueId, expectedGrantId: f.focus.grant.grantId,
    expectedIssueRevision: f.focus.issue.revision, signal: new AbortController().signal,
    async worker() {
      invoked = true;
      return { kind: "completed", resultRefs: [] };
    } });

  assert.ok(!result.ok);
  assert.equal(invoked, false);
  assert.equal(f.state().centralLearningGrants![0]!.status, "open");
  assert.equal(f.state().centralLearningGrants![0]!.claim, undefined);
  assert.equal(f.state().jobs[0]!.attempt, 0);
});

test("a selected stage cannot spend a larger lifetime grant or regain spent calls through token refunds", async () => {
  const f = await fixture();
  const result = await f.coordination.run({ issueId: f.focus.issue.issueId, expectedGrantId: f.focus.grant.grantId,
    expectedIssueRevision: f.focus.issue.revision, signal: new AbortController().signal,
    async worker(work) {
      const funding = skillStageFunding(work, { tokens: 500, calls: 1, steps: 1 });
      const opened = await funding.inspect();
      assert.ok(opened.ok);
      assert.deepEqual(opened.remaining, { tokens: 500, calls: 1, steps: 1 });
      const reservation = await funding.reserve({ reservationId: "bounded:one", maxTokens: 400 });

      assert.ok(reservation.ok);
      assert.deepEqual(reservation.remaining, { tokens: 100, calls: 0, steps: 0 });
      const settlement = await funding.settle({ reservationId: "bounded:one", usage: { kind: "reported", totalTokens: 100 } });

      assert.ok(settlement.ok);
      assert.deepEqual(settlement.remaining, { tokens: 400, calls: 0, steps: 0 });
      assert.ok(settlement.grant.allowance.maxTokens > 500, "the original lifetime cap stays intact");
      assert.deepEqual(await funding.reserve({ reservationId: "bounded:second", maxTokens: 100 }),
        { ok: false, reason: "learning_grant_exhausted" });

      return { kind: "completed", resultRefs: [] };
    } });

  assert.ok(result.ok);
  assert.equal(f.state().centralLearningGrants![0]!.reservations.length, 1);
});
