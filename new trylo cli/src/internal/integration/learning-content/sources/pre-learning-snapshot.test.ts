import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoardState, type BoardState } from "../../../learning/control/state.js";
import type { LearningIssue } from "../../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import * as snapshots from "./pre-learning-snapshot.js";
import { sessionSourceAddressCatalogForIssue } from "./session-issue-address.js";
import { sessionContentAddress } from "./session-address.js";

const scope = "workspace:snapshot", at = "2026-11-04T18:00:00Z";

function board(): BoardState {
  const issue: LearningIssue = { schemaVersion: 1, issueId: "issue:original", scope, problemKey: "original", revision: 2,
    createdAt: at, updatedAt: at, reports: [{ reportId: "report:original", source: { subsystem: "skill", taskId: "turn:original", versionId: "skill:original" },
      facts: ["The original task supplied source material."], evidenceRefs: ["session:original/turn:original"] }],
    decision: { kind: "focused_learning", revision: 2, reason: "Inspect the original skill use", sourceRefs: ["report:original"], decidedAt: at } };
  const content = { requirement: "Preserve the original requirement", body: "x".repeat(40000) };

  return { ...emptyBoardState(), sequence: 7, learningIssues: [issue], assets: [
    { versionId: "skill:original", kind: "skill", scope, schemaVersion: 1, source: "inferred", content, contentHash: contentHashOf(content), createdAt: at },
    { versionId: "skill:unrelated", kind: "skill", scope, schemaVersion: 1, source: "inferred", content: {}, contentHash: contentHashOf({}), createdAt: at }],
    activations: [{ activationId: "activation:original", scope, assetKind: "skill", pointer: "active", versionId: "skill:original", boardSequence: 6, generation: 1 }] };
}

function rehash(value: snapshots.PreLearningSourceSnapshot): snapshots.PreLearningSourceSnapshot {
  const { sourceHash: _sourceHash, snapshotId: _snapshotId, ...body } = value;
  const sourceHash = contentHashOf(body);
  return { ...body, sourceHash, snapshotId: `pre-learning-source:${sourceHash}` };
}

test("source snapshots freeze only exact original sources, and persisted schema/hash guards reject corruption without inventing a baseline", () => {
  const built = snapshots.buildPreLearningSourceSnapshot({ board: board(), scope, issueId: "issue:original" });
  if (!built.ok) assert.fail(built.reason);

  assert.equal(built.value.domain, "skill");
  assert.deepEqual(built.value.assets.map(row => row.versionId), ["skill:original"]);
  assert.equal(built.value.assets[0]?.contentHash, board().assets[0]?.contentHash);
  assert.equal(built.value.qualification, "source_snapshot_not_counterfactual_or_learning_gain");
  assert.equal(built.value.responseRegistrations.selected.length, 0);
  assert.ok(built.value.missingSources.some(row => row.ref === "session:original/turn:original"));
  assert.ok(Object.isFrozen(built.value.assets[0]));
  assert.ok(JSON.stringify(built.value).length < 5000);
  const check = snapshots.isPreLearningSourceSnapshot, read = snapshots.readPreLearningSourceSnapshot;

  assert.equal(typeof check, "function", "persisted source snapshots need an owner shape/hash guard");
  assert.equal(typeof read, "function");
  const persisted: unknown = JSON.parse(JSON.stringify(built.value));

  assert.equal(check(persisted), true);
  assert.deepEqual(read(persisted), built);
  assert.equal(check({ ...built.value, sourceHash: "0".repeat(64) }), false);
  assert.equal(read({ ...built.value, sourceHash: "0".repeat(64) }).ok, false);
  assert.equal(check({ ...built.value, snapshotId: "pre-learning-source:wrong" }), false);
  assert.equal(check({ ...built.value, scope: "workspace:tampered" }), false);
  assert.equal(check(rehash({ ...built.value, knownAtBoardSequence: 5 })), false, "a recomputed hash cannot move an activation into the future");
  assert.equal(check(rehash({ ...built.value, actualUses: { ...built.value.actualUses,
    toolUses: { available: 1, selected: [], omitted: 0 } } })), false, "a recomputed hash cannot hide omitted source records");
  assert.equal(check({ ...built.value, counterfactual: {} }), false);
  assert.equal(check(null), false);
});

test("research request sources preserve request and intent refs without inventing a business task address", () => {
  const original = board(), legacy = snapshots.buildPreLearningSourceSnapshot({ board: original, scope, issueId: "issue:original" });
  const source = { kind: "research_request" as const, domain: "skill" as const, requestRef: "research-request:one", intentRef: "research-intent:one" };
  const issue: LearningIssue = { ...original.learningIssues![0]!, issueId: "issue:research",
    reports: [{ reportId: "report:research", source, facts: ["Investigate the requested skill knowledge without a business-task claim."], evidenceRefs: [] }],
    decision: { kind: "focused_learning", revision: 2, reason: "Preserve the original research request and intent.",
      sourceRefs: [source.requestRef, source.intentRef], decidedAt: at } };
  const research: BoardState = { ...original, learningIssues: [issue] };
  const built = snapshots.buildPreLearningSourceSnapshot({ board: research, scope, issueId: issue.issueId });
  if (!built.ok) assert.fail(built.reason);

  assert.equal(built.value.schemaVersion, 1);
  assert.equal(built.value.domain, "skill");
  assert.equal(built.value.qualification, "source_snapshot_not_counterfactual_or_learning_gain");
  assert.deepEqual(built.value.originalReports.selected[0]?.source, source);
  assert.deepEqual(built.value.assets, []);

  for (const ref of [source.requestRef, source.intentRef]) {
    assert.ok(built.value.sourceRefs.includes(ref));
    assert.ok(built.value.missingSources.some(row => row.ref === ref && row.reason === "external_or_unknown_source"));
  }

  assert.ok(built.value.sourceRefs.every(ref => typeof ref === "string"));
  assert.deepEqual(snapshots.readPreLearningSourceSnapshot(JSON.parse(JSON.stringify(built.value))), built);
  const absent = sessionSourceAddressCatalogForIssue(issue, research);

  assert.equal(absent.available, 0);
  assert.deepEqual(absent.entries, []);
  const explicit = sessionContentAddress({ sessionId: "research-evidence-session", turnId: "evidence-turn", journalSequence: 3 });
  const withEvidence: LearningIssue = { ...issue, reports: [{ ...issue.reports[0]!, evidenceRefs: [source.requestRef, explicit] }] };
  const catalog = sessionSourceAddressCatalogForIssue(withEvidence, { ...research, learningIssues: [withEvidence] });

  assert.equal(catalog.available, 1);
  assert.deepEqual(catalog.entries.map(entry => entry.ref), [explicit]);
  assert.deepEqual(catalog.entries[0]?.sourceRefs, ["report:research"]);
  assert.deepEqual(snapshots.buildPreLearningSourceSnapshot({ board: original, scope, issueId: "issue:original" }), legacy,
    "The pre-existing fixture and its exact snapshot value must remain unchanged.");
});
