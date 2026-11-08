import assert from "node:assert/strict";
import test from "node:test";
import type { ExpertRequest, ExpertUseScope } from "../../subagent/experts/index.js";
import { temporaryExpertIdentityForScope } from "./collaboration-expert-owners.js";

const scope: ExpertUseScope = { workspaceId: "workspace:authorized", taskId: "task:authorized" };
const common: ExpertRequest = { requestId: "request:expert", expertId: "expert:unit", experienceKey: "experience:unit",
  origin: "collaboration", instruction: "Prepare a unit-handoff specialist.", baseVersion: 4, state: "temporary", revision: 3,
  createdAt: 0, userEdits: {} };
const request: ExpertRequest = { ...common, useScope: scope, creationAuthorization: "creation-consent:actual",
  configuration: { displayName: "Units specialist", specialty: "Unit conversion", situations: ["Artifact conversion"], responsibilities: ["Carry source units"],
    constraints: ["Follow user instructions"], collaboration: ["Share the source artifact"], baseRole: "worker", role: { name: "worker", description: "Unit conversion" },
    toolRefs: [], methods: [], sources: [] } };

test("temporary expert owner candidates require a completed authorized state and the exact workspace/task scope", () => {
  const expected = { expertId: request.expertId, version: 5, experienceKey: request.experienceKey,
    draft: { requestId: request.requestId, revision: request.revision } };

  for (const state of ["temporary", "awaiting_retention"] as const) {
    assert.deepEqual(temporaryExpertIdentityForScope({ ...request, state }, scope), expected);
  }

  assert.equal(temporaryExpertIdentityForScope(request, { ...scope, workspaceId: "workspace:other" }), undefined);
  assert.equal(temporaryExpertIdentityForScope(request, { ...scope, taskId: "task:other" }), undefined);

  for (const state of ["awaiting_creation", "authorized", "revision_requested", "saved", "rejected"] as const) {
    assert.equal(temporaryExpertIdentityForScope({ ...request, state }, scope), undefined, `state ${state} is not a usable temporary candidate`);
  }

  assert.equal(temporaryExpertIdentityForScope(undefined, scope), undefined);
  assert.equal(temporaryExpertIdentityForScope({ ...common, useScope: scope, creationAuthorization: "consent" }, scope), undefined);
  assert.equal(temporaryExpertIdentityForScope({ ...common, useScope: scope, configuration: request.configuration! }, scope), undefined);
  assert.equal(temporaryExpertIdentityForScope({ ...common, configuration: request.configuration!, creationAuthorization: "consent" }, scope), undefined);
});
