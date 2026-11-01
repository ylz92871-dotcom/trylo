import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../learning/control/hash.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface, decodeNpmToolProductionPlan, NPM_CLI_INPUT_SCHEMA } from "../../learning/domains/tool/evolution/npm-production-plan.js";
import { decodeToolProductionPlan, toolProductionScope, toolProductionVersion } from "../../learning/domains/tool/evolution/production-plan.js";
import type { ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import { validateManifest } from "../../tooling/package-spi/manifest.js";
import { npmInstallId } from "../../tooling/contract/npm-install.js";
import { npmTreeTestData } from "./npm-install-test-support.js";
import { verifyNpmToolProduction } from "./npm-production-verifier.js";

function fixture() {
  const data = npmTreeTestData();
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "caller-frozen", scope: data.plan.tree.scope, capability: "test pure CLI", operation: "create", evidence: [
    { sampleId: "a", role: "source", input: { argv: [], stdin: "1" }, expected: { kind: "value", value: null } },
    { sampleId: "b", role: "source", input: { argv: [], stdin: "2" }, expected: { kind: "value", value: null } },
    { sampleId: "v", role: "variation", input: { argv: [], stdin: "3" }, expected: { kind: "value", value: null } },
    { sampleId: "c", role: "counterexample", input: { argv: [], stdin: "bad" }, expected: { kind: "error", code: "cli_exit_1" } } ] };
  const selected = { descriptor: { identity: "test-installed-cli", description: "TEST ONLY reviewed package", inputSchema: NPM_CLI_INPUT_SCHEMA,
    mastery: { whenToUse: ["TEST ONLY"], preconditions: [], pitfalls: [] } }, runtime: { profile: "confined_npm_cli_v1" as const, bin: "test-cli", entrypoint: "cli.cjs" } };
  const plan = createNpmToolProductionPlan({ workspaceId: "test-workspace", installation: data.plan, checks, ...selected }); assert.ok(plan);
  return { ...data, checks, selected, production: plan };
}
test("reviewed dependency packages use a distinct ABI and descriptor without generated source or implied authority", () => {
  const fx = fixture(), plan = fx.production;
  assert.ok(decodeToolProductionPlan(plan)); assert.ok(validateManifest(plan.manifest).ok);
  assert.equal(plan.manifest.runtimeProfile, "confined_npm_cli_v1"); assert.equal(plan.manifest.version, fx.plan.tree.root.version);
  assert.equal(Object.hasOwn(plan.candidate, "source"), false); assert.equal(Object.hasOwn(plan, "verdict"), false); assert.equal(Object.hasOwn(plan, "active"), false);
  assert.equal(plan.origin.versionId, npmInstallId(fx.plan));
  assert.notEqual(toolProductionVersion(plan), toolProductionVersion({ ...plan, runtime: { ...plan.runtime, bin: "other-bin" } }));
  assert.notEqual(toolProductionScope(plan), toolProductionScope({ ...plan, workspaceId: "other" }));
});
test("interface and persisted package plans refuse permissions, hidden source, profile mixing and fake verdict fields", () => {
  const { production: plan, selected } = fixture();
  for (const raw of [{ ...selected, descriptor: { ...selected.descriptor, source: "module.exports=()=>0" } }, { ...selected, runtime: { ...selected.runtime, env: { TOKEN: "forbidden" } } }]) assert.equal(decodeNpmToolInterface(raw), undefined);
  for (const raw of [{ ...plan, verified: true }, { ...plan, manifest: { ...plan.manifest, permissions: ["fs.read"] } },
    { ...plan, manifest: { ...plan.manifest, envWhitelist: ["TOKEN"] } }, { ...plan, manifest: { ...plan.manifest, runtimeProfile: "confined_json_function_v1" } },
    { ...plan, manifest: { ...plan.manifest, mcpTransport: "stdio" } }]) assert.equal(decodeNpmToolProductionPlan(raw), undefined);
  assert.equal(validateManifest({ ...plan.manifest, mcpTransport: "stdio" } as typeof plan.manifest).ok, false);
});
test("caller-owned regression roles cannot duplicate one input or silently change source scope", () => {
  const fx = fixture();
  const duplicate = { ...fx.checks, evidence: fx.checks.evidence.map((row, index) => index === 2 ? { ...row, input: fx.checks.evidence[0]!.input } : row) };
  assert.equal(createNpmToolProductionPlan({ workspaceId: "test-workspace", installation: fx.plan, checks: duplicate, ...fx.selected }), undefined);
  assert.equal(createNpmToolProductionPlan({ workspaceId: "test-workspace", installation: fx.plan, checks: { ...fx.checks, scope: "other" }, ...fx.selected }), undefined);
});
test("shape-valid persisted data with a forged npm lock never reaches isolation or becomes a passing check", async () => {
  const fx = fixture(), installation = { ...fx.plan, lock: { ...fx.plan.lock, lockfileVersion: 2 } };
  const forged = { ...fx.production, installation, origin: { ...fx.production.origin, versionId: npmInstallId(installation), contentHash: contentHashOf(installation) } };
  assert.ok(decodeNpmToolProductionPlan(forged), "a persistence decoder establishes shape, not npm source authority");
  const result = await verifyNpmToolProduction(forged, { installationRoot: "unused", scratchRoot: "unused", nodeExecutable: "unused", target: fx.target,
    isolation: { probe: async () => { assert.fail("forged source cannot probe or execute"); }, run: async () => { assert.fail("forged source cannot run"); } } }, new AbortController().signal);
  assert.equal(result.kind, "failed"); assert.equal(result.record.verdict, "fail"); assert.equal(result.record.stages.length, 10); assert.equal(result.record.stages.some(row => row.passed), false);
});
