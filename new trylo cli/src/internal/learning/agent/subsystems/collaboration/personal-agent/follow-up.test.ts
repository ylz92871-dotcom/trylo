import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import { createCollaborationExperienceStore } from "../experience/index.js";
import { createCollaborationRuntimeReceiptWriter } from "../runtime/receipts/index.js";
import { collaborationFollowUp } from "./follow-up.js";

const scope = "workspace:follow-up", NOW = "2026-11-04T00:00:00.000Z";
const owner = { kind: "legacy_member", workspace: scope, profileId: "profile:follow-up", memberId: "worker" } as const;

async function fixture() {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "owner:follow-up" });
  const reported = await control.report({ scope, problemKey: "handoff", report: { reportId: "report:follow-up",
    source: { teamRunId: "team:follow-up", taskId: "task:old", memberId: "worker" }, facts: ["The handoff omitted its source."], evidenceRefs: [] } });

  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Evaluate a reusable handoff repair.", sourceRefs: ["report:follow-up"] });
  assert.ok(focused.ok);
  const writer = createCollaborationRuntimeReceiptWriter({ board, scope });
  const experience = createCollaborationExperienceStore({ board, scope, now: () => NOW, recordRuntimeReceipt: writer.record });
  const publish = async (familyId: string, practice: string) => {
    const result = await experience.publishExperience({ issueId: focused.issue.issueId, owner, familyId, situation: "A dependent handoff",
      responsibilities: ["worker"], practice, sourceRefs: ["report:follow-up"] });
    assert.ok(result.ok);
    return result.versionId;
  };
  const dispatch = async (receiptId: string, taskId: string, versionIds: readonly string[], teamRunId?: string) => {
    assert.ok((await experience.recordDispatch({ receiptId, owner, versionIds, recordedAt: NOW,
      boundary: { executionId: `execution:${receiptId}`, taskId, round: 1, role: "worker", memberId: "worker",
        configurationRef: "legacy-member:profile:follow-up:worker", requestId: `request:${receiptId}`,
        ...(teamRunId === undefined ? {} : { teamRunId }) } })).ok);
  };

  return { state: () => state, experience, publish, dispatch };
}

test("pending actual uses survive recent-receipt truncation and page across tasks without rewriting evidence", async () => {
  const h = await fixture(), oldVersion = await h.publish("handoff", "Include the original source.");

  await h.dispatch("dispatch:old", "task:old", [oldVersion]);
  const latestVersion = await h.publish("handoff", "Include the source and explicit pending dependencies.");

  for (let index = 0; index < 36; index++) await h.dispatch(`dispatch:current:${index}`, "task:current", [latestVersion]);

  const before = JSON.stringify(h.state()), received: string[] = [];
  let afterReceiptId: string | undefined;

  do {
    const page = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current", limit: 7,
      ...(afterReceiptId === undefined ? {} : { afterReceiptId }) });
    assert.equal(page.totalPending, 37);
    assert.equal(page.currentTaskPending, 36);
    assert.ok(page.items.length <= 7);
    received.push(...page.items.map(item => item.usageReceiptId));
    afterReceiptId = page.page.nextAfterReceiptId;
    const old = page.items.find(item => item.usageReceiptId === "dispatch:old");
    if (old) {
      assert.equal(old.currentTask, false);
      assert.deepEqual(old.supersededVersionIds, [oldVersion]);
    }
  } while (afterReceiptId !== undefined);

  assert.equal(received.length, 37);
  assert.equal(new Set(received).size, 37);
  assert.equal(received[received.length - 1], "dispatch:old");
  assert.equal(JSON.stringify(h.state()), before);
  const view = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current" });

  Reflect.set(view.items[0]!.boundary, "taskId", "caller:tampered");
  assert.equal(JSON.stringify(h.state()), before, "a read-only DTO must not expose a mutable Board record");
});

test("child assignment uses belong to the current frozen team-run while a same-name historical team stays historical", async () => {
  const h = await fixture(), version = await h.publish("handoff", "Include sources.");

  await h.dispatch("dispatch:historical-child", "task:child-old", [version], "team:previous");
  await h.dispatch("dispatch:current-child", "task:child-new", [version], "team:current");
  const page = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:parent", currentTeamRunId: "team:current" });

  assert.equal(page.currentTaskPending, 1);
  assert.deepEqual(page.items.map(item => [item.usageReceiptId, item.currentTask]), [
    ["dispatch:current-child", true], ["dispatch:historical-child", false],
  ]);
});

test("whole-dispatch feedback closes exactly that actual use and its completed cursor still advances", async () => {
  const h = await fixture(), one = await h.publish("handoff", "Include sources."), two = await h.publish("review", "Name unverified assumptions.");

  await h.dispatch("dispatch:one", "task:current", [one, two]);
  await h.dispatch("dispatch:two", "task:current", [one, two]);
  const first = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current", limit: 1 });

  assert.equal(first.page.nextAfterReceiptId, "dispatch:one");
  assert.ok((await h.experience.recordUseFeedback({ receiptId: "feedback:one", usageReceiptId: "dispatch:one", owner,
    versionIds: [one, two], summary: "The handoff improved, but the review contribution is uncertain.", outcome: "uncertain",
    sourceRefs: ["report:follow-up"], recordedAt: NOW })).ok);
  const next = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current", afterReceiptId: "dispatch:one", limit: 1 });

  assert.equal(next.totalPending, 1);
  assert.equal(next.page.cursor, "continued");
  assert.deepEqual(next.items.map(item => item.usageReceiptId), ["dispatch:two"]);
  assert.deepEqual(next.items[0]!.pendingVersionIds, [one, two]);
  const issueId = next.items[0]!.issueIds[0]!;

  assert.equal(collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current", issueId }).totalPending, 1);
  const otherIssue = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current", issueId: "issue:unrelated" });

  assert.equal(otherIssue.issueId, "issue:unrelated");
  assert.equal(otherIssue.totalPending, 0);
  const invalid = collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current", afterReceiptId: "not-an-actual-dispatch" });

  assert.equal(invalid.page.cursor, "invalid");
  assert.deepEqual(invalid.items, []);
  assert.equal(invalid.totalPending, 1);
});

test("loads and withdrawn components never become requests for partial attribution", async () => {
  const h = await fixture(), one = await h.publish("handoff", "Include sources."), two = await h.publish("review", "Name unverified assumptions.");

  assert.ok((await h.experience.recordLoad({ receiptId: "loaded:only", owner, versionIds: [one], recordedAt: NOW,
    boundary: { executionId: "execution:loaded", taskId: "task:current", round: 1, role: "worker" } })).ok);
  assert.equal(collaborationFollowUp(h.state(), { scope, currentTaskId: "task:current" }).totalPending, 0);
  await h.dispatch("dispatch:compound", "task:current", [one, two]);
  const withdrawn = { ...h.state(), tombstones: [{ entityId: two, entityType: "asset" as const, boardSequence: h.state().sequence, reason: "User withdrew this content." }] };

  assert.equal(collaborationFollowUp(withdrawn, { scope, currentTaskId: "task:current" }).totalPending, 0);
  assert.equal(collaborationFollowUp(h.state(), { scope: "workspace:foreign", currentTaskId: "task:current" }).totalPending, 0);
});
