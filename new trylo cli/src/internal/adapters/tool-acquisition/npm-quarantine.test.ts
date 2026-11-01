import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFilePermissionStore } from "../permission-store/file-ledger.js";
import { err, ok } from "../../tooling/contract/result.js";
import { acquireNpmQuarantine } from "./npm-quarantine.js";
import { decodeNpmQuarantinePlan, quarantinePlanId, type NpmQuarantinePlan } from "./npm-quarantine-plan.js";
import { sha256Bytes } from "./npm-package-check.js";
import { readNpmTarball } from "./ustar-reader.js";
import type { HttpTransport } from "./transport.js";
import { parseTools } from "../../surface/cli/args-tools.js";

type Entry = { readonly path: string; readonly text: string; readonly kind?: number };
/** TEST ONLY archive encoder. Production has a strict decoder and never synthesizes trusted archives. */
function archive(entries: readonly Entry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.text);
    header.write(entry.path, 0, 100, "utf8"); header.write("0000644\0", 100, 8); header.write("0000000\0", 108, 8); header.write("0000000\0", 116, 8);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12); header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156); header[156] = entry.kind ?? 48; header.write("ustar\0", 257, 6); header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks));
}
function packageData(change: Record<string, unknown> = {}, extra: readonly Entry[] = []) {
  const manifest = JSON.stringify({ name: "test-cli", version: "1.2.3", license: "MIT", repository: "https://github.com/test-owner/test-cli", bin: "cli.js", ...change });
  const license = "TEST ONLY MIT license fixture", entries = [{ path: "package/package.json", text: manifest }, { path: "package/cli.js", text: "throw new Error('TEST ONLY; must never execute');" }, { path: "package/LICENSE", text: license }, ...extra];
  const body = archive(entries), plan: NpmQuarantinePlan = { schemaVersion: 1, platform: "npm", name: "test-cli", version: "1.2.3", scope: "test:workspace", sha256: sha256Bytes(body), manifestSha256: sha256Bytes(Buffer.from(manifest)),
    licenseSpdx: "MIT", upstreamUrl: "https://github.com/test-owner/test-cli", sourceRevision: "a".repeat(40), licenses: [{ path: "LICENSE", sha256: sha256Bytes(Buffer.from(license)) }] };
  return { body, plan };
}
async function fixture(t: TestContext, data = packageData()) {
  const base = path.resolve("Temp/npm-quarantine-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(home), base); t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "quarantine"), store = createFilePermissionStore({ path: path.join(home, "permission/ledger.ndjson") });
  const requests: string[] = [], id = quarantinePlanId(data.plan);
  const transport: HttpTransport = { get: async request => { requests.push(request.url); return ok({ status: 200, body: data.body }); } };
  const grant = await store.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope: data.plan.scope, issuedAt: new Date(0).toISOString(), expiry: new Date(60_000).toISOString() }); assert.ok(grant.ok);
  const options = { root, approval: store, token: { grantId: grant.grant.grantId }, now: () => 0, signal: new AbortController().signal, transport };
  return { ...data, home, root, store, requests, id, options };
}

test("a real byte archive is quarantined once with a consumed grant, never executed or activated", async t => {
  const fx = await fixture(t), result = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(result.ok);
  assert.equal(result.receipt.verification, "not_production_verified"); assert.equal(result.receipt.files.length, 3);
  assert.match(await readFile(path.join(result.destination, "package/cli.js"), "utf8"), /must never execute/);
  const grant = await fx.store.getGrant(fx.options.token.grantId); assert.ok(grant.ok); assert.equal(grant.grant?.status, "consumed");
  const replay = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(replay.ok); assert.equal(replay.changed, false); assert.equal(fx.requests.length, 1);
  assert.deepEqual((await readdir(fx.home)).sort(), ["permission", "quarantine"]);
});
test("unknown authorization and altered binding never download or create a quarantine", async t => {
  const fx = await fixture(t), denied = await acquireNpmQuarantine(fx.plan, { ...fx.options, token: { grantId: "invented" } });
  assert.ok(!denied.ok); assert.equal(denied.code, "unknown_grant");
  const changed = await acquireNpmQuarantine({ ...fx.plan, scope: "different-workspace" }, fx.options); assert.ok(!changed.ok); assert.equal(changed.code, "candidate_mismatch");
  assert.equal(fx.requests.length, 0); assert.deepEqual(await readdir(fx.home), ["permission"]);
});
test("received bytes, manifest, and license hashes are checked independently", async t => {
  for (const field of ["sha256", "manifestSha256"] as const) {
    const data = packageData(), fx = await fixture(t, { ...data, plan: { ...data.plan, [field]: "0".repeat(64) } });
    const result = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, field === "sha256" ? "hash_mismatch" : "manifest_mismatch");
    assert.deepEqual(await readdir(fx.root), []);
  }
  const data = packageData(), fx = await fixture(t, { ...data, plan: { ...data.plan, licenses: [{ path: "LICENSE", sha256: "0".repeat(64) }] } });
  const result = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "license_mismatch");
});
test("runtime dependency closure and install hooks are refused before materialization", async t => {
  for (const [change, code] of [[{ dependencies: { evil: "latest" } }, "unsupported_dependency_closure"], [{ scripts: { postinstall: "run evil" } }, "install_hook_forbidden"]] as const) {
    const fx = await fixture(t, packageData(change)), result = await acquireNpmQuarantine(fx.plan, fx.options);
    assert.ok(!result.ok); assert.equal(result.code, code); assert.deepEqual(await readdir(fx.root), []);
  }
});
test("archive paths, links, case collisions, unsupported overrides and bad framing fail closed", () => {
  for (const entries of [[{ path: "package/../escape", text: "no" }], [{ path: "package/CON.txt", text: "no" }], [{ path: "package/x:stream", text: "no" }],
    [{ path: "package/link", text: "", kind: 50 }], [{ path: "package/pax", text: "", kind: 120 }], [{ path: "package/A", text: "a" }, { path: "package/a", text: "b" }]]) {
    assert.throws(() => readNpmTarball(archive(entries), "a".repeat(64)));
  }
  const valid = archive([{ path: "package/file", text: "ok" }]); assert.throws(() => readNpmTarball(valid.subarray(0, 30), "a".repeat(64)));
});
test("tampering with a quarantined tree refuses replay without replacing the original evidence", async t => {
  const fx = await fixture(t), first = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(first.ok);
  const target = path.join(first.destination, "package/cli.js"); await writeFile(target, "original corrupt bytes");
  const result = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "quarantine_corrupt");
  assert.equal(await readFile(target, "utf8"), "original corrupt bytes"); assert.equal(fx.requests.length, 1);
});
test("cancellation destroys the acquisition handoff and a stored reparse point never becomes an extraction root", async t => {
  const fx = await fixture(t), controller = new AbortController(); controller.abort();
  const cancelled = await acquireNpmQuarantine(fx.plan, { ...fx.options, signal: controller.signal }); assert.ok(!cancelled.ok); assert.equal(cancelled.code, "cancelled"); assert.equal(fx.requests.length, 0);
  const elsewhere = path.join(fx.home, "elsewhere"); await mkdir(elsewhere); await symlink(elsewhere, fx.root, "junction");
  const result = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "quarantine_unavailable"); assert.deepEqual(await readdir(elsewhere), []);
});
test("only an exact frozen request and explicit plan confirmation enter the command", () => {
  const { plan } = packageData(); assert.ok(decodeNpmQuarantinePlan(plan));
  for (const change of [{ version: "latest" }, { sourceRevision: "main" }, { upstreamUrl: "https://attacker.invalid/repo" }, { extra: true }]) assert.equal(decodeNpmQuarantinePlan({ ...plan, ...change }), undefined);
  assert.equal(parseTools(["acquire-plan", "request.json"]).kind, "acquire-plan");
  assert.equal(parseTools(["acquire", "request.json"]).kind, "error");
  assert.equal(parseTools(["acquire", "request.json", "--approve", quarantinePlanId(plan)]).kind, "acquire");
});

test("cancellation during an archive request reaches the transport and leaves no published tree", async t => {
  const fx = await fixture(t), controller = new AbortController(); let ready: (() => void) | undefined;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const transport: HttpTransport = { get: request => new Promise(resolve => {
    assert.equal(request.signal, controller.signal); request.signal.addEventListener("abort", () => resolve(err("cancelled", "TEST ONLY cancelled")), { once: true }); ready?.();
  }) };
  const pending = acquireNpmQuarantine(fx.plan, { ...fx.options, transport, signal: controller.signal });
  await started; controller.abort(); const result = await pending; assert.ok(!result.ok); assert.equal(result.code, "cancelled");
  assert.deepEqual(await readdir(fx.root), []);
});

test("a stale installation lock is retained for inspection and never starts another download", async t => {
  const fx = await fixture(t); await mkdir(fx.root); const lock = path.join(fx.root, `${fx.id}.lock`); await writeFile(lock, "original interrupted ownership");
  const result = await acquireNpmQuarantine(fx.plan, fx.options); assert.ok(!result.ok); assert.equal(result.code, "quarantine_busy");
  assert.equal(fx.requests.length, 0); assert.equal(await readFile(lock, "utf8"), "original interrupted ownership");
});
