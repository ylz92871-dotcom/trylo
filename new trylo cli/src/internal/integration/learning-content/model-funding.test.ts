import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { createContentGrantFundingAtRoot } from "./model-funding.js";

test("original Board writer rejects a late disabled reservation but admits its terminal usage settlement", async t => {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "trylo-content-model-funding-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const scope = "project:content-root", now = "2026-11-04T12:00:00.000Z";
  let command = 0;
  const act = (action: CoordinationAction) => withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning",
    commandId: `seed:${command++}`, issuedAt: now, action }));

  for (const action of [
    { kind: "report", issueId: "issue:root", problemKey: "source-content", scope, report: { reportId: "report:root",
      source: { subsystem: "method", taskId: "task:root", versionId: "method:root" }, facts: ["Apply the original requirements."], evidenceRefs: [] } },
    { kind: "decide", issueId: "issue:root", expectedRevision: 1, decision: "focused_learning", reason: "Use the original source material.", sourceRefs: [] },
    { kind: "fund", issueId: "issue:root", expectedRevision: 2, grantId: "grant:root", domain: "prompt", allowance: {
      schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } },
  ] satisfies CoordinationAction[]) {
    const result = await act(action);
    if (!result.ok) assert.fail(result.reason);
  }

  const seed = await createBoardReader(boardRoot).load();
  if (!seed.ok) assert.fail(seed.reason);

  const claimed = await act({ kind: "claim", jobId: seed.state.centralLearningGrants![0]!.jobId, expectedAttempt: 0,
    claimId: "claim:root", ownerId: "worker:root", expiresAt: "2026-11-04T12:05:00.000Z" });
  if (!claimed.ok) assert.fail(claimed.reason);

  let enabled = true, disableAtIssue = false;
  const funding = createContentGrantFundingAtRoot({ boardRoot, scope, domain: "prompt", grantId: "grant:root", claimId: "claim:root",
    enabled: () => enabled, now: () => {
      if (disableAtIssue) enabled = false;
      return now;
    } });
  // A structurally compatible caller object cannot retarget this bound capability.
  const supplied = { reservationId: "request:one", maxTokens: 1000, grantId: "grant:unrelated", claimId: "claim:unrelated" };
  const first = await funding.reserve(supplied);
  if (!first.ok) assert.fail(first.reason);

  const before = await createBoardReader(boardRoot).load();
  if (!before.ok) assert.fail(before.reason);

  disableAtIssue = true;
  const refused = await funding.reserve({ reservationId: "request:two", maxTokens: 1000 });

  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "collect_disabled");

  const after = await createBoardReader(boardRoot).load();
  if (!after.ok) assert.fail(after.reason);

  assert.equal(after.state.sequence, before.state.sequence);
  assert.equal(after.state.centralLearningGrants![0]!.reservations.length, 1);
  const settled = await funding.settle({ reservationId: "request:one", usage: { kind: "reported", totalTokens: 5 } });
  if (!settled.ok) assert.fail(settled.reason);

  assert.equal(settled.grant.reservations[0]!.state, "settled");
  assert.deepEqual(settled.grant.reservations[0]!.usage, { kind: "reported", totalTokens: 5 });
});
