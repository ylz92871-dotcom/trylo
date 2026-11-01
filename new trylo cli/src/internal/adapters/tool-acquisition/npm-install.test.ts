import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFilePermissionStore } from "../permission-store/file-ledger.js";
import { err, ok } from "../../tooling/contract/result.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { decodeNpmInstallPlan, npmInstallId } from "./npm-install-plan.js";
import { installNpmTree } from "./npm-install.js";
import { npmTreeTestData } from "./npm-install-test-support.js";
import { readNpmInstall } from "./npm-install-files.js";
import type { HttpTransport } from "./transport.js";
import { parseTools } from "../../surface/cli/args-tools.js";
import { readNpmInstallStaging } from "./npm-install-files.js";
import { publishNpmInstall } from "./npm-install-publication.js";

async function fixture(t: TestContext, data = npmTreeTestData()) {
  const base = path.resolve("Temp/npm-install-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(home), base); t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "installations"), store = createFilePermissionStore({ path: path.join(home, "permissions/ledger.ndjson") });
  const id = npmInstallId(data.plan), requests: string[] = [];
  const transport: HttpTransport = { get: async request => { requests.push(request.url); const body = data.bodies.get(request.url); return body === undefined ? err("network_failure", "TEST ONLY no fixture") : ok({ status: 200, body }); } };
  const grant = await store.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope: data.plan.tree.scope, issuedAt: new Date(0).toISOString(), expiry: new Date(120_000).toISOString() }); assert.ok(grant.ok);
  return { ...data, home, root, store, id, requests, options: { root, target: data.target, approval: store, token: { grantId: grant.grant.grantId }, now: () => 0, signal: new AbortController().signal, transport } };
}
test("complete dependency tree installs once with consumed permission and independently checked physical bytes", async t => {
  const fx = await fixture(t), result = await installNpmTree(fx.plan, fx.options); assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.receipt.verification, "not_production_verified"); assert.equal(result.receipt.files.length, 6);
  assert.ok(await readNpmInstall(result.destination, fx.plan));
  assert.match(await readFile(path.join(result.destination, "node_modules/leaf/cli.cjs"), "utf8"), /must not execute/);
  const replay = await installNpmTree(fx.plan, fx.options); assert.ok(replay.ok); assert.equal(replay.changed, false); assert.equal(fx.requests.length, 2);
  const grant = await fx.store.getGrant(fx.options.token.grantId); assert.ok(grant.ok); assert.equal(grant.grant?.status, "consumed");
  assert.deepEqual((await readdir(fx.home)).sort(), ["installations", "permissions"]);
});
test("missing permission, foreign target and changed graph cannot download", async t => {
  const fx = await fixture(t);
  const missing = await installNpmTree(fx.plan, { ...fx.options, token: { grantId: "invented" } }); assert.ok(!missing.ok); assert.equal(missing.code, "unknown_grant");
  const target = await installNpmTree(fx.plan, { ...fx.options, target: { ...fx.target, cpu: "arm64" } }); assert.ok(!target.ok); assert.equal(target.code, "npm_install_target_mismatch");
  const changed = structuredClone(fx.plan); changed.tree.packages[0]!.edges.length; assert.equal(decodeNpmInstallPlan({ ...changed, packages: changed.packages.slice(1) }), undefined);
  assert.equal(fx.requests.length, 0);
});
test("SRI, reviewed manifest, license and actual dependency closure cannot be forged by a lock", async t => {
  for (const change of ["integrity", "manifest", "license", "edges"] as const) {
    const data = npmTreeTestData(), plan = structuredClone(data.plan);
    if (change === "integrity") {
      const location = plan.tree.packages[0]!.location;
      const raw = plan.lock.packages as Record<string, Record<string, unknown>>; raw[location]!.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      (plan.tree.packages[0] as { integrity: string }).integrity = raw[location]!.integrity as string;
      (plan.tree as { lockHash: string }).lockHash = contentHashOf(plan.lock);
    } else if (change === "manifest") (plan.packages[0]!.review as { manifestSha256: string }).manifestSha256 = "0".repeat(64);
    else if (change === "license") (plan.packages[0]!.review.licenses[0] as { sha256: string }).sha256 = "0".repeat(64);
    else {
      const raw = plan.lock.packages as Record<string, Record<string, unknown>>; raw["node_modules/test-cli"]!.dependencies = { leaf: "*" };
      const pkg = plan.tree.packages.find(row => row.name === "test-cli")!; (pkg.edges[0] as { range: string }).range = "*";
      (plan.tree as { lockHash: string }).lockHash = contentHashOf(plan.lock);
    }
    const fx = await fixture(t, { ...data, plan }), result = await installNpmTree(plan, fx.options); assert.ok(!result.ok, change);
    assert.equal(result.code, change === "license" ? "license_mismatch" : change === "edges" ? "unsupported_dependency_closure" : "manifest_mismatch");
    assert.deepEqual(await readdir(fx.root), []);
  }
});
test("an installation hook hidden by an edited lock remains forbidden", async t => {
  const fx = await fixture(t, npmTreeTestData({ leaf: { scripts: { postinstall: "never run this" } } }));
  const result = await installNpmTree(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "install_hook_forbidden");
  assert.deepEqual(await readdir(fx.root), []);
});
test("published prepare/build commands remain inert data, while native builds remain unsupported", async t => {
  const fx = await fixture(t, npmTreeTestData({ leaf: { scripts: { prepare: "throw this must never execute", build: "never execute me" } } }));
  const installed = await installNpmTree(fx.plan, fx.options); assert.ok(installed.ok, JSON.stringify(installed));
  const native = await fixture(t, npmTreeTestData({ leaf: { gypfile: true } }));
  const refused = await installNpmTree(native.plan, native.options); assert.ok(!refused.ok); assert.equal(refused.code, "unsupported_dependency_closure");
});
test("extensionless native images are rejected even when their source hashes and licenses match", async t => {
  const fx = await fixture(t, npmTreeTestData({ leafFiles: [{ path: "bin/native-tool", text: "\u007fELF_TEST_ONLY_NOT_EXECUTABLE" }] }));
  const result = await installNpmTree(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "unsupported_dependency_closure");
  assert.deepEqual(await readdir(fx.root), []);
});
test("editing both a package file and its receipt checksum still refuses replay from original archive authority", async t => {
  const fx = await fixture(t), installed = await installNpmTree(fx.plan, fx.options); assert.ok(installed.ok);
  const target = path.join(installed.destination, "node_modules/leaf/cli.cjs"); await writeFile(target, "corrupt original");
  const receipt = JSON.parse(await readFile(path.join(installed.destination, "receipt.json"), "utf8"));
  const item = receipt.files.find((row: { path: string }) => row.path === "node_modules/leaf/cli.cjs"); item.sha256 = "0".repeat(64); item.bytes = 16;
  await writeFile(path.join(installed.destination, "receipt.json"), JSON.stringify(receipt));
  const result = await installNpmTree(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "quarantine_corrupt");
  assert.equal(await readFile(target, "utf8"), "corrupt original"); assert.equal(fx.requests.length, 2);
});
test("cancellation, retained staging/locks and reparse destinations never replay or follow external paths", async t => {
  const fx = await fixture(t), controller = new AbortController(); controller.abort();
  const cancelled = await installNpmTree(fx.plan, { ...fx.options, signal: controller.signal }); assert.ok(!cancelled.ok); assert.equal(cancelled.code, "cancelled");
  const elsewhere = path.join(fx.home, "elsewhere"); await mkdir(elsewhere); await symlink(elsewhere, fx.root, "junction");
  const refused = await installNpmTree(fx.plan, fx.options); assert.ok(!refused.ok); assert.equal(refused.code, "quarantine_unavailable"); assert.deepEqual(await readdir(elsewhere), []);
  const busy = await fixture(t); await mkdir(busy.root); await writeFile(path.join(busy.root, `${busy.id}.lock`), "original lost owner");
  const blocked = await installNpmTree(busy.plan, busy.options); assert.ok(!blocked.ok); assert.equal(blocked.code, "quarantine_busy"); assert.equal(busy.requests.length, 0);
  const staged = await fixture(t); await mkdir(staged.root); const stage = path.join(staged.root, `${staged.id}.staging`); await mkdir(stage); await writeFile(path.join(stage, "original.txt"), "retain interrupted stage");
  const interrupted = await installNpmTree(staged.plan, staged.options); assert.ok(!interrupted.ok); assert.equal(interrupted.code, "quarantine_busy");
  assert.equal(await readFile(path.join(stage, "original.txt"), "utf8"), "retain interrupted stage");
});
test("cancellation during fetching stops before publication and a second owner never duplicates a download", { timeout: 20_000 }, async t => {
  const cancelled = await fixture(t), controller = new AbortController();
  const aborting: HttpTransport = { get: async () => { controller.abort(); return err("cancelled", "TEST ONLY"); } };
  const stopped = await installNpmTree(cancelled.plan, { ...cancelled.options, transport: aborting, signal: controller.signal });
  assert.ok(!stopped.ok); assert.equal(stopped.code, "cancelled"); assert.deepEqual(await readdir(cancelled.root), []);
  const fx = await fixture(t); let release: (() => void) | undefined, started: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
  const transport: HttpTransport = { get: async request => { started?.(); await gate; return fx.options.transport.get(request); } };
  const first = installNpmTree(fx.plan, { ...fx.options, transport }); await ready;
  try {
    const grant = await fx.store.issue({ action: "acquire", candidateId: fx.id, packageVersionId: fx.id, scope: fx.plan.tree.scope, issuedAt: new Date(0).toISOString(), expiry: new Date(120_000).toISOString() }); assert.ok(grant.ok);
    const second = await installNpmTree(fx.plan, { ...fx.options, token: { grantId: grant.grant.grantId }, transport: { get: async () => { assert.fail("another owner cannot download"); } } });
    assert.ok(!second.ok); assert.equal(second.code, "quarantine_busy");
  } finally { release?.(); }
  assert.ok((await first).ok); assert.equal(fx.requests.length, 2);
});
test("explicit installation command contract and separate production-plan entry remain fail closed", () => {
  const id = `npm-install_v1_${"a".repeat(64)}`;
  assert.equal(parseTools(["install-plan", "request.json"]).kind, "install-plan");
  for (const args of [["install", "request.json"], ["install", "request.json", "--approve", "latest"], ["install-show", "../escape"], ["install-production", id, "interface.json"]]) assert.equal(parseTools(args).kind, "error");
  assert.equal(parseTools(["install", "request.json", "--approve", id]).kind, "install");
  assert.equal(parseTools(["install-production", id, "interface.json", "checks.json"]).kind, "install-production");
  assert.equal(parseTools(["install-inspect", id, "test-cli", "--allow-tools", "run_shell"]).kind, "install-inspect");
  for (const args of [["--protocol", "2099-01-01"], ["--allow-tools", "run_shell,fs_read"], ["--allow-tools", "run_shell", "--allow-tools", "run_shell"]]) assert.equal(parseTools(["install-inspect", id, "test-cli", ...args]).kind, "error");
});

test("publication retries only transient rename errors and returns independently readable installed bytes", async t => {
  const fx = await fixture(t); let attempts = 0;
  const result = await installNpmTree(fx.plan, { ...fx.options, publicationIo: {
    rename: async (source, destination) => { if (++attempts < 3) throw Object.assign(new Error("TEST ONLY busy"), { code: "EPERM" }); await rename(source, destination); },
    wait: async () => {},
  } });
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(attempts, 3); assert.equal(fx.requests.length, 2);
  assert.ok(await readNpmInstall(result.destination, fx.plan)); assert.equal(await readNpmInstallStaging(result.destination), undefined);
});

async function blockedPublication(t: TestContext) {
  const fx = await fixture(t); let attempts = 0;
  const result = await installNpmTree(fx.plan, { ...fx.options, publicationIo: {
    rename: async () => { attempts++; throw Object.assign(new Error("TEST ONLY persistent busy"), { code: "EBUSY" }); }, wait: async () => {},
  } });
  assert.ok(!result.ok); assert.equal(result.code, "npm_install_publish_blocked"); assert.equal(attempts, 6);
  const destination = path.join(fx.root, fx.id); assert.equal(await readNpmInstall(destination), undefined);
  const staged = await readNpmInstallStaging(destination, fx.plan); assert.ok(staged);
  return { ...fx, destination, staged };
}
async function freshAcquire(fx: Awaited<ReturnType<typeof fixture>>) {
  const grant = await fx.store.issue({ action: "acquire", candidateId: fx.id, packageVersionId: fx.id, scope: fx.plan.tree.scope, issuedAt: new Date(0).toISOString(), expiry: new Date(120_000).toISOString() });
  assert.ok(grant.ok); return { grantId: grant.grant.grantId };
}
test("completed interrupted publication requires a new grant, revalidates bytes and never downloads again", async t => {
  const fx = await blockedPublication(t), original = await readFile(path.join(`${fx.destination}.staging`, "receipt.json"), "utf8");
  const spent = await installNpmTree(fx.plan, fx.options); assert.ok(!spent.ok); assert.equal(spent.code, "replayed");
  const token = await freshAcquire(fx);
  const result = await installNpmTree(fx.plan, { ...fx.options, token, transport: { get: async () => { assert.fail("verified staging must not download"); } } });
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.resumed, true); assert.equal(result.publicationGrantId, token.grantId);
  assert.equal(await readFile(path.join(fx.destination, "receipt.json"), "utf8"), original);
  assert.equal(result.receipt.approvalGrantId, fx.staged.receipt.approvalGrantId); assert.equal(fx.requests.length, 2);
});
test("changed interrupted bytes cannot be published even after an edited receipt checksum", async t => {
  const fx = await blockedPublication(t), stage = `${fx.destination}.staging`, target = path.join(stage, "node_modules/leaf/cli.cjs");
  await writeFile(target, "changed"); const receipt = JSON.parse(await readFile(path.join(stage, "receipt.json"), "utf8"));
  const row = receipt.files.find((file: { path: string }) => file.path === "node_modules/leaf/cli.cjs"); row.bytes = 7; row.sha256 = "0".repeat(64);
  await writeFile(path.join(stage, "receipt.json"), JSON.stringify(receipt));
  const result = await installNpmTree(fx.plan, { ...fx.options, token: await freshAcquire(fx) });
  assert.ok(!result.ok); assert.equal(result.code, "quarantine_corrupt"); assert.equal(await readNpmInstall(fx.destination), undefined);
  assert.equal(await readFile(target, "utf8"), "changed"); assert.equal(fx.requests.length, 2);
});
test("publication cancellation and an existing destination retain staging without replacement", async t => {
  const fx = await blockedPublication(t), controller = new AbortController(); let calls = 0;
  const cancelled = await installNpmTree(fx.plan, { ...fx.options, token: await freshAcquire(fx), signal: controller.signal, publicationIo: {
    rename: async () => { calls++; throw Object.assign(new Error("TEST ONLY busy"), { code: "EPERM" }); },
    wait: async milliseconds => { if (milliseconds > 0) controller.abort(); },
  } });
  assert.ok(!cancelled.ok); assert.equal(cancelled.code, "cancelled"); assert.equal(calls, 1); assert.ok(await readNpmInstallStaging(fx.destination));
  await mkdir(fx.destination); await writeFile(path.join(fx.destination, "retain.txt"), "prior evidence");
  await assert.rejects(publishNpmInstall(fx.destination, new AbortController().signal), { code: "quarantine_busy" });
  assert.equal(await readFile(path.join(fx.destination, "retain.txt"), "utf8"), "prior evidence"); assert.ok(await readNpmInstallStaging(fx.destination));
});
test("the install lock rechecks a concurrent publication before starting a second download", async t => {
  const fx = await fixture(t), token = await freshAcquire(fx); let concurrent = false;
  const approval = { ...fx.store, consume: async (...args: Parameters<typeof fx.store.consume>) => {
    const consumed = await fx.store.consume(...args);
    if (!concurrent) { concurrent = true; assert.ok((await installNpmTree(fx.plan, fx.options)).ok); }
    return consumed;
  } };
  const result = await installNpmTree(fx.plan, { ...fx.options, approval, token, transport: { get: async () => { assert.fail("second owner must observe the completed installation"); } } });
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.changed, false); assert.equal(fx.requests.length, 2);
});
