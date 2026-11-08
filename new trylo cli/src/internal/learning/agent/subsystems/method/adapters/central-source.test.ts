import assert from "node:assert/strict";
import test from "node:test";
import { shortId } from "../../../../domains/shared/hash.js";
import type { ExperienceReviewRequest } from "../experience-port.js";
import { methodCentralCondition, methodCentralPolicyFamilyRef, methodCentralStageIdentity } from "./central-source.js";

// TEST ONLY condition metadata. Empty observations supply no utility or result.
const request: ExperienceReviewRequest = { snapshotId: "snapshot:metadata", versionId: "method:metadata", method: "Inspect before editing.",
  confidence: 0, observations: [], counterexamples: [], scope: { id: "range:metadata", versionId: "method:metadata", scopeId: "json",
    proposedSequence: 1, predicate: { all: [{ feature: "format", value: "json" }, { feature: "operation", value: "edit" }],
      exclude: [{ feature: "schema", value: "unknown" }] } } };

test("method condition identity follows actual effective applicability, not source, order, time or task prose", () => {
  const first = methodCentralCondition(request);
  assert.ok(first);
  const independent = methodCentralCondition({ ...request, snapshotId: "snapshot:another-source", versionId: "method:independent",
    method: "A different independently trialed method.", scope: { ...request.scope, id: "range:another-source", versionId: "method:independent",
      scopeId: "another-scope-id", proposedSequence: 100, predicate: { ...request.scope.predicate, all: [...request.scope.predicate.all].reverse() } } });

  assert.equal(independent?.ref, first.ref);
  const narrowed = methodCentralCondition({ ...request, effectivePredicate: { ...request.scope.predicate,
    exclude: [...request.scope.predicate.exclude, { feature: "document", value: "signed" }] } });

  assert.notEqual(narrowed?.ref, first.ref, "an actual excluded class changes applicability");
  assert.deepEqual(first.features.all, request.scope.predicate.all);
});

test("an automatic version-specific enrollment feature cannot masquerade as a reusable condition class", () => {
  const feature = `use_${shortId("s", [request.versionId])}`;
  assert.equal(methodCentralCondition({ ...request, scope: { ...request.scope, scopeId: "base",
    predicate: { all: [{ feature, value: "yes" }], exclude: [] } } }), undefined);
});

test("a full host model identity separates method families and exact stages while preserving actual-model receipt compatibility", () => {
  const legacy = methodCentralStageIdentity(request, "actual-model");

  assert.deepEqual(methodCentralStageIdentity(request, "actual-model", "actual-model"), legacy);
  const first = methodCentralStageIdentity(request, "actual-model", "config:provider-endpoint-effort:first");
  const other = methodCentralStageIdentity(request, "actual-model", "config:provider-endpoint-effort:other");

  assert.equal(first.policyRef, legacy.policyRef);
  assert.equal(other.policyRef, legacy.policyRef);
  assert.notEqual(first.stageRef, other.stageRef);
  assert.notEqual(first.sourceBindingRef, other.sourceBindingRef);
  assert.notEqual(methodCentralPolicyFamilyRef("actual-model", "config:provider-endpoint-effort:first"),
    methodCentralPolicyFamilyRef("actual-model", "config:provider-endpoint-effort:other"));
  assert.equal(methodCentralPolicyFamilyRef("actual-model"), legacy.policyRef);
});
