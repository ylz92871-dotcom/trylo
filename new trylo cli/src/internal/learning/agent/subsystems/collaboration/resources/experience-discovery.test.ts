import assert from "node:assert/strict";
import test from "node:test";
import type { LearningIssue } from "../../../../control/coordination-contract.js";
import type { CollaborationExperienceStore, ExperienceQueryItem } from "../experience/index.js";
import { discoverCollaborationExperience, type ExperienceDiscoveryOwner } from "./experience-discovery.js";

const scope = "workspace:fair-experience", NOW = "2026-11-04T00:00:00.000Z";
const issue: LearningIssue = { schemaVersion: 1, issueId: "issue:fair", scope, problemKey: "handoff", revision: 1,
  decision: { kind: "unreviewed" }, createdAt: NOW, updatedAt: NOW,
  reports: ["producer", "reviewer"].map(memberId => ({ reportId: `report:${memberId}`, source: { teamRunId: "team:fair", taskId: "task:fair", memberId },
    facts: ["The artifact handoff needs attention."], evidenceRefs: [] })) };
const owner = (ref: string, key = ref): ExperienceDiscoveryOwner => ({ ref,
  input: { owner: { kind: ref === "personal_agent" ? "personal_agent" : "expert", experienceKey: key }, maxChars: 600 } });
const item = (key: string, index: number): ExperienceQueryItem => ({ versionId: `experience:${key}:${index}`, familyId: `family:${key}:${index}`,
  card: "A concrete owner-specific practice.", conditions: {}, applicability: { state: "eligible" } });

test("bounded discovery reserves related specialist slots and fairly shares remaining items with a large PA catalogue", async () => {
  const queried: string[] = [];
  const store: Pick<CollaborationExperienceStore, "inspectExperience"> = { async inspectExperience(input, options) {
    assert.ok(input.owner.kind === "expert" || input.owner.kind === "personal_agent");
    const key = input.owner.experienceKey;
    queried.push(key);
    const total = key === "personal_agent" ? 20 : key.startsWith("member:") ? 1 : 0;
    const items = Array.from({ length: Math.min(total, options?.limit ?? 12) }, (_, index) => item(key, index));
    return { ok: true, mode: "discovery_only", items, omittedCount: total - items.length };
  } };
  const owners = [owner("personal_agent"), ...Array.from({ length: 13 }, (_, index) => owner(`other:${index}`)), owner("member:producer"), owner("member:reviewer")];
  const found = await discoverCollaborationExperience(store, { issue, owners, query: "artifact contract", signal: new AbortController().signal });

  assert.deepEqual(queried.slice(0, 3), ["member:reviewer", "member:producer", "personal_agent"]);
  assert.equal(queried.length, 12);
  assert.equal(found.omittedOwnerCount, 4);
  assert.equal(found.sourceRefs.length, 12);

  for (const ref of ["member:producer", "member:reviewer"]) {
    const view = found.ownerViews.find(candidate => candidate.ownerRef === ref);
    assert.ok(view?.ok);
    assert.equal(view.items.length, 1);
  }

  const pa = found.ownerViews.find(view => view.ownerRef === "personal_agent");
  assert.ok(pa?.ok);
  assert.equal(pa.items.length, 10);
  assert.equal(pa.omittedItemCount, 10);
  assert.match(found.note, /Omitted owners\/items are not evidence/);
});

test("empty, failed and uninspected owners remain distinct in a discovery response", async () => {
  const store: Pick<CollaborationExperienceStore, "inspectExperience"> = { async inspectExperience(input) {
    assert.ok(input.owner.kind === "expert" || input.owner.kind === "personal_agent");
    return input.owner.experienceKey === "unavailable" ? { ok: false, reason: "board_unavailable" }
      : { ok: true, mode: "discovery_only", items: [], omittedCount: 0 };
  } };
  const owners = [owner("personal_agent"), owner("member:producer", "unavailable")];
  const found = await discoverCollaborationExperience(store, { issue, owners, query: "handoff", signal: new AbortController().signal });

  assert.equal(found.omittedOwnerCount, 0);
  assert.deepEqual(found.sourceRefs, []);
  assert.deepEqual(found.ownerViews, [{ ownerRef: "member:producer", ok: false, reason: "board_unavailable" },
    { ownerRef: "personal_agent", ok: true, items: [], omittedItemCount: 0 }]);
  const cancelled = new AbortController();
  cancelled.abort();
  const stopped = await discoverCollaborationExperience({ inspectExperience: async () => { throw new Error("Cancelled query cannot inspect"); } },
    { issue, owners, query: "handoff", signal: cancelled.signal });

  assert.equal(stopped.omittedOwnerCount, 2);
  assert.deepEqual(stopped.ownerViews, []);
});
