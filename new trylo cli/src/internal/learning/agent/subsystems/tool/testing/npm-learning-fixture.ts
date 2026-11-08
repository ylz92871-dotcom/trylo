import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { ok, err } from "../../../../../tooling/contract/result.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { installNpmTree } from "../adapters/acquisition/npm-install.js";
import { enqueueToolLearningPlan } from "../runtime/pipeline-queue.js";
import { executeNpmTool } from "../adapters/acquisition/npm-runtime.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { NpmAdaptationServices } from "../runtime/npm-adaptation-types.js";
import { localNodeContract } from "./local-node-contract.js";

export const npmLearningTime = "2026-11-04T00:00:00.000Z";
export const npmLearningAdapter = "module.exports=input=>{if(!input||typeof input.value!=='string')throw Object.assign(new Error('invalid input'),{code:'invalid_input'});return require('leaf')(input.value);};";

export async function npmLearningFixture(t: TestContext) {
  const base = testScratchPath("npm-learning-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = npmTreeTestData({ leaf: { main: "api.cjs" }, leafFiles: [{ path: "api.cjs", text: "module.exports=value=>value.trim().toLowerCase();" }] });
  const installationRoot = path.join(root, "installed"), boardRoot = path.join(root, "board"), scope = data.plan.tree.scope;
  const permission = createFilePermissionStore({ path: path.join(root, "permissions.ndjson") }), id = npmInstallId(data.plan);
  const grant = await permission.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope,
    issuedAt: npmLearningTime, expiry: "2026-11-04T00:10:00.000Z" });
  assert.ok(grant.ok);
  const installed = await installNpmTree(data.plan, { root: installationRoot, target: data.target, approval: permission,
    token: { grantId: grant.grant.grantId }, now: () => Date.parse(npmLearningTime), signal: new AbortController().signal,
    transport: { get: async request => {
      const body = data.bodies.get(request.url);
      return body === undefined ? err("network_failure", "TEST ONLY") : ok({ status: 200, body });
    } } });

  assert.ok(installed.ok, JSON.stringify(installed));
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "Normalize text through the existing leaf npm API",
    trigger: { action: "user_requested", runId: "npm-learning-test", proposalKey: "normalize", evidenceRefs: [] }, createdAt: npmLearningTime };
  const queued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(queued.ok);
  const started = await withBoardWriter(boardRoot, store => store.apply({ type: "start_job", commandId: "test-start", issuedAt: npmLearningTime, jobId: queued.jobId }));
  assert.ok(started.ok);
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "npm-frozen-checks", scope, capability: plan.capability, operation: "create", maxAttempts: 1,
    evidence: [{ sampleId: "a", role: "source", input: { value: " HELLO " }, expected: { kind: "value", value: "hello" } },
      { sampleId: "b", role: "source", input: { value: " WORLD " }, expected: { kind: "value", value: "world" } },
      { sampleId: "held-out", role: "variation", input: { value: " HELD_OUT_SENTINEL " }, expected: { kind: "value", value: "held_out_sentinel" } },
      { sampleId: "bad", role: "counterexample", input: { value: null }, expected: { kind: "error", code: "invalid_input" } }] };
  const candidate = (source: string) => ({ action: "candidate", interface: { descriptor: { identity: "normalize", description: "Normalize text using the installed leaf API",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, mastery: { whenToUse: ["Normalize whitespace and case"], preconditions: [], pitfalls: [] } },
    runtime: { profile: "confined_npm_library_v1", source } } });
  const execute: NonNullable<NpmAdaptationServices["execute"]> = (subject, input, signal) => executeNpmTool(subject, input,
    { installationRoot, scratchRoot: path.join(root, "scratch"), target: data.target, nodeExecutable: process.execPath, isolation: localNodeContract }, signal);

  return { root, boardRoot, scope, data, plan, checks, candidate, execute, installationRoot, installed,
    admission: { jobId: queued.jobId, attempt: 1 }, now: () => Date.parse(npmLearningTime), signal: new AbortController().signal,
    contract: { checks, origins: checks.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "requirement:normalize" })) } };
}
