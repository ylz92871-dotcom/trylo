import { testScratchPath } from "../../../../../../testing/scratch.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createFilePermissionStore } from "../../../../../../adapters/permission-store/file-ledger.js";
import { err, ok } from "../../../../../../tooling/contract/result.js";
import { npmInstallId } from "../../../../../../tooling/contract/npm-install.js";
import { npmPreparationId, prepareNpmInstallation } from "./npm-install-preparation.js";
import { npmTreeTestData } from "./npm-install-test-support.js";
import { installNpmTree } from "./npm-install.js";
import { locateNpmCli, resolveNpmLearningLock } from "./npm-lock-resolver.js";
import { hostNpmTarget } from "./npm-platform.js";
import type { HttpTransport } from "./transport.js";
import { enqueueToolLearningPlan } from "../../runtime/pipeline-queue.js";
import { workToolLearningPipeline } from "../../runtime/pipeline-worker.js";
import { readToolAcquisition } from "../../runtime/acquisition-continuation.js";
import { acquireLearningChoice } from "./learning-acquisition-host.js";
import { parseTools } from "../../../../../../surface/cli/args-tools.js";

async function fixture(t: TestContext) {
  const base = testScratchPath("npm-preparation-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));

  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = npmTreeTestData(), calls: string[] = [];
  const store = createFilePermissionStore({ path: path.join(root, "permissions.ndjson") });
  const manifests: Record<string, Record<string, unknown>> = Object.fromEntries(data.plan.tree.packages.map(pkg => {
    const metadata = data.plan.lock.packages as Record<string, Record<string, unknown>>;
    return [pkg.name, { ...metadata[pkg.location], gitHead: "a".repeat(40), dist: { tarball: pkg.archiveUrl, integrity: pkg.integrity } }];
  }));
  const transport: HttpTransport = { get: async input => {
    calls.push(input.url);
    const bytes = data.bodies.get(input.url);
    if (bytes !== undefined) return ok({ status: 200, body: bytes });

    const parts = new URL(input.url).pathname.slice(1).split("/"), name = decodeURIComponent(parts[0] ?? ""), manifest = manifests[name];
    if (manifest === undefined) return err("network_failure", "TEST ONLY missing metadata");

    const payload = parts.length === 1 ? { name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest } } : manifest;

    return ok({ status: 200, body: Buffer.from(JSON.stringify(payload)) });
  } };
  const request = { scope: data.plan.tree.scope, name: "test-cli", version: "1.0.0", target: data.target, lock: data.plan.lock };
  const issue = async (id: string) => {
    const grant = await store.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope: request.scope,
      issuedAt: new Date(0).toISOString(), expiry: new Date(300_000).toISOString() });
    assert.ok(grant.ok);
    return { grantId: grant.grant.grantId };
  };

  return { root, data, calls, store, transport, request, issue, manifests };
}

test("npm resolves a real dependency lock through metadata only, then source preparation creates an installable plan", async t => {
  const fx = await fixture(t), npmCli = await locateNpmCli(process.execPath, process.env.PATH ?? "");

  assert.ok(npmCli, "this process integration test requires the repository's existing npm");
  const signal = new AbortController().signal;
  const target = hostNpmTarget();
  const resolved = await resolveNpmLearningLock({ scope: fx.request.scope, name: "test-cli", version: "1.0.0", target,
    transport: fx.transport, signal, host: { nodeExecutable: process.execPath, npmCli, scratchRoot: path.join(fx.root, "resolution"),
      ...(process.env.SystemRoot === undefined ? {} : { systemRoot: process.env.SystemRoot }) } });

  assert.ok(resolved.ok, JSON.stringify(resolved));
  assert.equal(resolved.tree.packages.length, 2);
  assert.ok(fx.calls.length >= 2);
  assert.ok(fx.calls.every(url => !url.endsWith(".tgz")));
  const request = { ...fx.request, target, lock: resolved.lock };
  const prepared = await prepareNpmInstallation(request, { approval: fx.store, token: await fx.issue(npmPreparationId(request)),
    now: () => 0, signal, transport: fx.transport });

  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.equal(prepared.plan.packages.length, 2);

  for (const row of prepared.plan.packages) {
    const original = fx.data.plan.packages.find(item => item.review.name === row.review.name)!;
    assert.ok(row.review.schemaVersion === 2);
    assert.ok(original.review.schemaVersion === 1);
    assert.equal(row.review.sha256, original.review.sha256);
    assert.equal(row.review.manifestSha256, original.review.manifestSha256);
    assert.equal(row.review.licenseSpdx, original.review.licenseSpdx);
    assert.deepEqual(row.review.licenses, original.review.licenses);
    assert.deepEqual(row.review.sourceIdentity.claims, { kind: "publisher_claimed", repository: original.review.upstreamUrl, revision: original.review.sourceRevision });
  }

  const installed = await installNpmTree(prepared.plan, { root: path.join(fx.root, "installed"), target,
    approval: fx.store, token: await fx.issue(npmInstallId(prepared.plan)), now: () => 0, signal, transport: fx.transport });

  assert.ok(installed.ok, JSON.stringify(installed));
  assert.equal(installed.receipt.files.length, 6);
});

test("preparation collects no source bytes without the exact request's approval", async t => {
  const fx = await fixture(t);
  const result = await prepareNpmInstallation(fx.request, { approval: fx.store, token: { grantId: "missing" }, now: () => 0,
    signal: new AbortController().signal, transport: fx.transport });
  assert.ok(!result.ok);
  assert.equal(result.code, "unknown_grant");
  assert.deepEqual(fx.calls, []);
});

test("registry metadata does not override the actual archive's license and dependency contracts", async t => {
  const fx = await fixture(t);
  fx.manifests.leaf!.license = "ISC";
  const result = await prepareNpmInstallation(fx.request, { approval: fx.store, token: await fx.issue(npmPreparationId(fx.request)), now: () => 0,
    signal: new AbortController().signal, transport: fx.transport });
  assert.ok(!result.ok);
  assert.equal(result.code, "manifest_mismatch");
});

test("a learner's acquisition choice resumes through approval and installation without a handwritten plan, including restart", async t => {
  const fx = await fixture(t), boardRoot = path.join(fx.root, "board"), scope = fx.request.scope;
  const queued = await enqueueToolLearningPlan(boardRoot, { type: "tool_learning_plan", schemaVersion: 1, scope,
    capability: "Use the existing test CLI", createdAt: new Date(0).toISOString(),
    trigger: { runId: "learning-acquisition", proposalKey: "requested-capability", action: "user_requested", evidenceRefs: [] } });

  assert.ok(queued.ok, JSON.stringify(queued));
  const reasoning = { rationale: "Existing open-source CLI supplies the requested operation", existingInsufficiency: "No local CLI is installed",
    expectedBenefit: "Reuse the existing implementation", constructionCost: "Resolve, inspect and install", alternatives: ["implement from scratch"] };
  let decisions = 0;
  const worked = await workToolLearningPipeline({ boardRoot, scope, now: () => 0, mode: "after_turn", signal: new AbortController().signal,
    services: { allowance: async () => ({ grantId: "test-grant", maxCalls: 4, maxTokens: 24000, callsRemaining: 4, tokensRemaining: 24000, maxPromptChars: 16000 }),
      search: async () => ({ status: "complete", candidates: [{ platform: "npm", id: "test-cli", version: "1.0.0", licenseSpdx: "MIT", sourceUrl: "https://www.npmjs.com/package/test-cli" }], failures: [] }),
      plan: async () => ++decisions === 1 ? { ...reasoning, action: "research", query: "test-cli" }
        : { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "test-cli", version: "1.0.0" }, adaptation: "Expose the CLI operation as a Trylo tool" },
      evolve: async () => { throw new Error("acquisition must not call the pure-function generator"); } } });

  assert.ok(worked.ok);
  const jobId = worked.results[0]?.jobId;
  assert.ok(jobId);
  const request = await readToolAcquisition(boardRoot, jobId, scope);
  assert.ok(request.ok, JSON.stringify(request));
  assert.equal(request.installation, undefined);
  assert.deepEqual(parseTools(["acquire-learning", jobId, "--approve", request.approvalId]), { kind: "acquire-learning", jobId, approvalId: request.approvalId });
  const npmCli = await locateNpmCli(process.execPath, process.env.PATH ?? "");
  assert.ok(npmCli);
  const input = { boardRoot, jobId, scope, approvalId: request.approvalId, installationRoot: path.join(fx.root, "installed"),
    resolution: { nodeExecutable: process.execPath, npmCli, scratchRoot: path.join(fx.root, "resolution"),
      ...(process.env.SystemRoot === undefined ? {} : { systemRoot: process.env.SystemRoot }) },
    target: hostNpmTarget(), transport: fx.transport, signal: new AbortController().signal, now: () => 0, approval: fx.store,
    issueGrant: (id: string) => fx.store.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope,
      issuedAt: new Date(0).toISOString(), expiry: new Date(300000).toISOString() }) };
  const stale = await acquireLearningChoice({ ...input, approvalId: "wrong-decision" });

  assert.ok(!stale.ok);
  assert.equal(stale.code, "approval_plan_mismatch");
  assert.deepEqual(fx.calls, []);
  const installed = await acquireLearningChoice(input);
  assert.ok(installed.ok, JSON.stringify(installed));
  assert.equal(installed.changed, true);
  assert.equal(installed.activated, false);
  const calls = fx.calls.length;
  const resumed = await acquireLearningChoice({ ...input, now: () => 1 });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(resumed.changed, false);
  assert.equal(fx.calls.length, calls);
  const saved = await readToolAcquisition(boardRoot, jobId, scope);
  assert.ok(saved.ok);
  assert.ok(saved.installation);
});
