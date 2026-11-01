import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../control/hash.js";
import { toolEvolutionVersionId, type ToolEvolutionArtifact } from "./artifact.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "./contracts.js";
import { createToolProductionPlan, decodeToolProductionPlan, toolProductionScope, toolProductionVersion } from "./production-plan.js";

const candidate: ToolEvolutionCandidate = { identity: "double", description: "TEST ONLY source", source: "module.exports = input => input * 2;", inputSchema: { type: "number" }, mastery: { whenToUse: ["double"], preconditions: [], pitfalls: [] } };
const source: ToolEvolutionRequest = { schemaVersion: 1, requestId: "training", scope: "test", capability: "double", operation: "create", evidence: [
  { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } }, { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
  { sampleId: "v", role: "variation", input: 4, expected: { kind: "value", value: 8 } }, { sampleId: "n", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } } ] };
const artifact: ToolEvolutionArtifact = { schemaVersion: 1, candidate, request: source, generatedAt: new Date(0).toISOString(), verification: { verdict: "pass", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(source.evidence), checks: source.evidence.map(row => ({ sampleId: row.sampleId, role: row.role, outcome: "passed", detail: "TEST ONLY fixture" })) } };
const checks: ToolEvolutionRequest = { ...source, requestId: "independent", evidence: source.evidence.map((row, index) => index < 2 ? row : index === 2
  ? { ...row, input: 11, expected: { kind: "value", value: 22 } } : { ...row, input: "bad", expected: { kind: "error", code: "invalid_input" } }) };
const input = { workspaceId: "workspace", originVersionId: toolEvolutionVersionId(artifact), artifact, checks, license: "MIT" as const };

test("production plan freezes source lineage, new oracle and workspace without an activation", () => {
  const result = createToolProductionPlan(input); assert.ok(result.ok); assert.ok(decodeToolProductionPlan(result.plan));
  assert.equal(result.versionId, toolProductionVersion(result.plan)); assert.deepEqual(result.plan.manifest.permissions, []);
  assert.equal(Object.hasOwn(result.plan, "active"), false); assert.equal(Object.hasOwn(result.plan, "verdict"), false);
  const copy = { ...structuredClone(result.plan), candidate: { ...result.plan.candidate, description: "changed" } };
  assert.notEqual(contentHashOf(copy), contentHashOf(result.plan));
});
test("a held-out role cannot relabel generation inputs or duplicate another sample", () => {
  assert.ok(!createToolProductionPlan({ ...input, checks: source }).ok);
  const duplicate = { ...checks, evidence: checks.evidence.map((row, index) => index === 2 ? { ...row, input: 2 } : row) };
  assert.ok(!createToolProductionPlan({ ...input, checks: duplicate }).ok);
});
test("workspace and tool identity give separate Board slots; versions of one tool share its slot", () => {
  const result = createToolProductionPlan(input); assert.ok(result.ok);
  const second = { ...result.plan, candidate: { ...candidate, identity: "triple" } };
  assert.notEqual(toolProductionScope(result.plan), toolProductionScope(second));
  assert.notEqual(toolProductionScope(result.plan), toolProductionScope({ ...result.plan, workspaceId: "other" }));
  assert.equal(toolProductionScope(result.plan), toolProductionScope({ ...result.plan, candidate: { ...candidate, source: "different immutable version" } }));
});
test("persisted plans reject permission smuggling, unsupported licenses, scope drift and extra fields", () => {
  const result = createToolProductionPlan(input); assert.ok(result.ok);
  for (const value of [{ ...result.plan, active: true }, { ...result.plan, manifest: { ...result.plan.manifest, permissions: ["fs.read"] } },
    { ...result.plan, manifest: { ...result.plan.manifest, licenseSpdx: "UNLICENSED" } }, { ...result.plan, checks: { ...checks, scope: "other" } }]) assert.equal(decodeToolProductionPlan(value), undefined);
  assert.ok(!createToolProductionPlan({ ...input, originVersionId: `tool-evolution_v1_${"0".repeat(64)}` }).ok);
});
