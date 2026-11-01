import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";
import { createToolProductionPlan, toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import { VALIDATION_STAGE_ORDER, type ValidationRecord } from "../../tooling/contract/types.js";
import { createToolEvolutionArchive } from "../tool-learning/evolution-archive.js";
import { saveToolProductionPlan, TOOL_PRODUCTION_GENERATOR, TOOL_PRODUCTION_VERIFIER } from "../tool-learning/production-assets.js";
import { admitToolProductionVerification } from "../tool-learning/production-evidence.js";
import { openRegistryHarness, issueAgentMethodReceipt } from "./authority-fixtures.js";

export const productionTestTime = "2026-10-31T00:00:00.000Z";

/** TEST ONLY shape fixtures: these records prove wiring, never native production verification. */
export async function seedToolProduction(t: TestContext) {
  const base = path.resolve("Temp/tool-production-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await openRegistryHarness(); t.after(harness.close);
  const request: ToolEvolutionArtifact["request"] = { schemaVersion: 1, requestId: "test-training", scope: "test", capability: "double", operation: "create", evidence: [
    { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } },
    { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
    { sampleId: "v", role: "variation", input: 4, expected: { kind: "value", value: 8 } },
    { sampleId: "n", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
  ] };
  const candidate: ToolEvolutionArtifact["candidate"] = { identity: "double", description: "TEST ONLY double", source: "module.exports = input => input * 2;", inputSchema: { type: "number" }, mastery: { whenToUse: ["Double a number"], preconditions: [], pitfalls: [] } };
  const artifact: ToolEvolutionArtifact = { schemaVersion: 1, candidate, request, generatedAt: productionTestTime,
    verification: { verdict: "pass", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(row => ({ sampleId: row.sampleId, role: row.role, outcome: "passed", detail: "TEST ONLY" })) } };
  const origin = await createToolEvolutionArchive(root).save(artifact); assert.ok(origin.ok);
  const checks = { ...request, requestId: "test-fresh", evidence: request.evidence.map((row, i) => i === 2 ? { ...row, input: 11, expected: { kind: "value" as const, value: 22 } } : i === 3 ? { ...row, input: "invalid" } : row) };
  const created = createToolProductionPlan({ workspaceId: "workspace-test", originVersionId: origin.versionId, artifact, checks, license: "MIT" }); assert.ok(created.ok);
  const saved = await saveToolProductionPlan(root, created.plan, productionTestTime); assert.ok(saved.ok);
  const record: ValidationRecord = { validationId: "test-only-checks", packageVersionId: created.versionId, actor: "verifier", verdict: "pass",
    stages: VALIDATION_STAGE_ORDER.map(stage => ({ stage, passed: true, detail: "TEST ONLY contract wiring" })) };
  const selection = { boardRoot: root, versionId: created.versionId, workspaceId: created.plan.workspaceId, authority: { verify: harness.registry.verify } };
  const issue = (overrides: Parameters<typeof issueAgentMethodReceipt>[2] = {}) => issueAgentMethodReceipt(harness, record,
    { scope: toolProductionScope(created.plan), verifierId: TOOL_PRODUCTION_VERIFIER, generatorId: TOOL_PRODUCTION_GENERATOR, ...overrides });
  const admit = async () => {
    const receipt = await issue();
    const admitted = await admitToolProductionVerification({ ...selection, receiptId: receipt.receiptId, issuedAt: productionTestTime }); assert.ok(admitted.ok);
    return receipt;
  };
  return { root, harness, origin, plan: created.plan, record, selection, issue, admit };
}
