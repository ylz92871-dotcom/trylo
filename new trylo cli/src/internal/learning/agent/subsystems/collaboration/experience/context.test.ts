import assert from "node:assert/strict";
import test from "node:test";
import { experienceResponsibilities } from "./context.js";
import { EXPERIENCE_RESPONSIBILITY_LIMITS } from "./contracts.js";
import { isExperienceConditions, isPrepareExperienceInput, isPublishExperienceInput } from "./parse.js";
import { createCollaborationExperienceStore } from "./store.js";
import { createCollaborationControl } from "../control/index.js";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import type { BoardStore } from "../../../../control/store-port.js";

const scope = "workspace:retrieval-responsibility", NOW = "2026-11-04T00:00:00.000Z";
const owner = { kind: "legacy_member" as const, workspace: scope, profileId: "profile:actual", memberId: "producer" };

test("responsibility retrieval keys remain whole, unique and bounded without mutating the supplied descriptions", () => {
  const exact = "d".repeat(200), tooLong = "x".repeat(201), supplied = ["", "  ", "bad\0key", tooLong, exact, exact, " worker ", "worker"];
  const before = [...supplied], result = experienceResponsibilities(supplied);

  assert.deepEqual(result, [exact, " worker ", "worker"]);
  assert.deepEqual(supplied, before);
  assert.ok(!result.includes(tooLong.slice(0, 200)), "an overlong description must not become a fabricated truncated retrieval key");
  assert.deepEqual(experienceResponsibilities([tooLong, "worker"]), ["worker"], "the host can supply its known base role after unusable description prose");
  const bounded = experienceResponsibilities(Array.from({ length: 12 }, (_, index) => `duty:${index}`));

  assert.equal(bounded.length, EXPERIENCE_RESPONSIBILITY_LIMITS.maxItems);
  assert.deepEqual(bounded, Array.from({ length: 8 }, (_, index) => `duty:${index}`));
});

test("legacy keys and 121–200 character keys share the same condition and runtime context bounds", () => {
  for (const length of [120, 121, 200]) {
    const responsibility = "d".repeat(length);
    assert.equal(isExperienceConditions({ responsibility }), true);
    assert.equal(isPrepareExperienceInput({ owner, maxChars: 600, context: { responsibilities: [responsibility] } }), true);
  }
  for (const responsibility of ["d".repeat(201), "bad\0key", " "]) {
    assert.equal(isExperienceConditions({ responsibility }), false);
    assert.equal(isPrepareExperienceInput({ owner, maxChars: 600, context: { responsibilities: [responsibility] } }), false);
  }
});

test("a real stored condition longer than 120 characters is retrieved by its full key while card display limits stay unchanged", async () => {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "responsibility-contract-owner" }), responsibility = "d".repeat(200);
  const report = await control.report({ scope, problemKey: "actual-duty", report: { reportId: "report:duty",
    source: { teamRunId: "team:actual", taskId: "task:actual", memberId: "producer" }, facts: ["The current artifact handoff lacks consumer context."], evidenceRefs: [] } });

  assert.ok(report.ok);
  const focused = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision, decision: "focused_learning",
    reason: "PA selected this actual handoff issue.", sourceRefs: ["report:duty"] });
  assert.ok(focused.ok);
  const store = createCollaborationExperienceStore({ board, scope, now: () => NOW });
  const publication = { issueId: report.issue.issueId, owner, familyId: "artifact-duty", situation: "When producing a consumer handoff",
    responsibilities: ["artifact producer"], practice: "Supply the current consumer contract and unfinished work.", sourceRefs: ["report:duty"], conditions: { responsibility } };
  const published = await store.publishExperience(publication);
  assert.ok(published.ok);
  const matched = await store.prepareExperience({ owner, maxChars: 600, context: { responsibilities: experienceResponsibilities([responsibility, "worker"]) } });

  assert.ok(matched.ok);
  assert.deepEqual(matched.versionIds, [published.versionId]);
  const short = await store.prepareExperience({ owner, maxChars: 600, context: { responsibilities: [responsibility.slice(0, 120)] } });

  assert.ok(short.ok);
  assert.deepEqual(short.versionIds, []);
  const filtered = await store.prepareExperience({ owner, maxChars: 600, context: { responsibilities: experienceResponsibilities(["x".repeat(2000), "worker"]) } });

  assert.ok(filtered.ok);
  assert.deepEqual(filtered.versionIds, [], "an unusable host description no longer poisons the whole request");
  assert.equal(isPublishExperienceInput({ ...publication, responsibilities: ["d".repeat(120)] }), true);
  assert.equal(isPublishExperienceInput({ ...publication, responsibilities: ["d".repeat(121)] }), false, "display/card duty text is still bounded to 120");
});
