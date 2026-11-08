import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { contentHashOf } from "../../../../../control/hash.js";
import { decodeNpmQuarantinePlan, quarantinePlanId, npmRegistryArchiveUrl } from "../../../../../../tooling/contract/npm-source.js";
import { decodeNpmInstallData } from "../../../../../../tooling/contract/npm-install.js";
import { npmTreeTestData } from "./npm-install-test-support.js";
import { inspectNpmInstallContent } from "./npm-install-content.js";
import { parseTools } from "../../../../../../surface/cli/args-tools.js";
import { prepareNpmInstallation, npmPreparationId } from "./npm-install-preparation.js";
import { createFilePermissionStore } from "../../../../../../adapters/permission-store/file-ledger.js";
import { ok } from "../../../../../../tooling/contract/result.js";
import { recordOf } from "../../domain/evolution/parse.js";
import type { NpmLockedPackage } from "../../../../../../tooling/contract/npm-tree.js";

function fixture() {
  const data = npmTreeTestData(), row = data.plan.packages[0]!, pkg = data.plan.tree.packages.find(item => item.location === row.location)!;

  assert.ok(row.review.schemaVersion === 1);
  const { upstreamUrl, sourceRevision: _sourceRevision, ...base } = row.review;
  const raw = { ...base, schemaVersion: 2, sourceIdentity: { kind: "registry_archive", archiveUrl: pkg.archiveUrl, integrity: pkg.integrity,
    claims: { kind: "publisher_claimed", repository: upstreamUrl } } };
  const review = decodeNpmQuarantinePlan(raw);
  assert.ok(review?.schemaVersion === 2);
  const plan = { ...data.plan, packages: data.plan.packages.map(item => item.location === row.location ? { ...item, review } : item) };

  return { ...data, prior: row.review, raw, review, pkg, plan };
}

test("legacy source reviews keep every field, hash and quarantine identity unchanged", () => {
  const fx = fixture(), decoded = decodeNpmQuarantinePlan(fx.prior);
  assert.deepEqual(decoded, fx.prior);
  assert.ok(decoded);
  assert.equal(contentHashOf(decoded), contentHashOf(fx.prior));
  assert.equal(quarantinePlanId(decoded), `npm-quarantine_v1_${contentHashOf(fx.prior)}`);
});

test("a registry archive has its own identity and does not invent a commit or verified provenance", () => {
  const fx = fixture();
  assert.ok(decodeNpmInstallData(fx.plan));
  assert.equal(quarantinePlanId(fx.review), `npm-quarantine_v2_${contentHashOf(fx.review)}`);
  assert.equal(Object.hasOwn(fx.review, "upstreamUrl"), false);
  assert.equal(Object.hasOwn(fx.review, "sourceRevision"), false);
  assert.equal(fx.review.sourceIdentity.claims?.kind, "publisher_claimed");
  assert.equal(fx.review.sourceIdentity.claims?.revision, undefined);
  assert.deepEqual(parseTools(["acquire", "review.json", "--approve", quarantinePlanId(fx.review)]), {
    kind: "acquire", requestFile: "review.json", approvedPlanId: quarantinePlanId(fx.review) });

  for (const changes of [{ sourceRevision: "a".repeat(40) }, { verified: true }, { upstreamUrl: "https://github.com/test/repo" }]) {
    assert.equal(decodeNpmQuarantinePlan({ ...fx.raw, ...changes }), undefined);
  }
});

test("V2 retains the exact case of canonical prerelease coordinates while legacy identities keep their original decoder", () => {
  const fx = fixture(), version = "1.0.0-RC.1";
  const raw = { ...fx.raw, version, sourceIdentity: { ...fx.raw.sourceIdentity,
    archiveUrl: npmRegistryArchiveUrl(fx.review.name, version) } };
  const decoded = decodeNpmQuarantinePlan(raw);
  assert.ok(decoded?.schemaVersion === 2);
  assert.equal(decoded.version, version);
  assert.equal(decoded.sourceIdentity.archiveUrl, raw.sourceIdentity.archiveUrl);
  assert.equal(decodeNpmQuarantinePlan({ ...raw, version: version.toLowerCase() }), undefined,
    "case normalization cannot silently retarget the reviewed archive");
  assert.equal(decodeNpmQuarantinePlan({ ...fx.prior, version }), undefined,
    "the original V1 acceptance and hash contract is retained");
});

test("registry provenance refuses different hosts, package coordinates, noncanonical integrity and claimed authority", () => {
  const fx = fixture();
  for (const sourceIdentity of [
    { ...fx.raw.sourceIdentity, archiveUrl: "https://attacker.invalid/archive.tgz" },
    { ...fx.raw.sourceIdentity, archiveUrl: npmRegistryArchiveUrl(fx.review.name, "9.9.9") },
    { ...fx.raw.sourceIdentity, integrity: "sha512-not-a-digest" },
    { ...fx.raw.sourceIdentity, claims: { kind: "verified", repository: "https://github.com/test/repo" } },
    { ...fx.raw.sourceIdentity, claims: { kind: "publisher_claimed", repository: "https://secret@github.com/test/repo" } },
    { ...fx.raw.sourceIdentity, sha256: "a".repeat(64) },
  ]) assert.equal(decodeNpmQuarantinePlan({ ...fx.raw, sourceIdentity }), undefined);
});

test("archive identity binds the locked physical package and the real tar bytes", () => {
  const fx = fixture(), archives = new Map(fx.plan.tree.packages.map(pkg => [pkg.location, fx.bodies.get(pkg.archiveUrl)!]));

  assert.equal(inspectNpmInstallContent(fx.plan, archives).length, 6);
  const differentIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const mismatch = { ...fx.plan, packages: fx.plan.packages.map(row => row.location === fx.pkg.location
    ? { ...row, review: { ...fx.review, sourceIdentity: { ...fx.review.sourceIdentity, integrity: differentIntegrity } } } : row) };

  assert.equal(decodeNpmInstallData(mismatch), undefined);
  assert.throws(() => inspectNpmInstallContent(fx.plan, new Map([...archives, [fx.pkg.location, Buffer.from("wrong archive")]])));
  const wrongUrl = { ...fx.plan, tree: { ...fx.plan.tree, packages: fx.plan.tree.packages.map(pkg => pkg.location === fx.pkg.location
    ? { ...pkg, archiveUrl: "https://registry.npmjs.org/another/-/another-1.0.0.tgz" } : pkg) } };

  assert.equal(decodeNpmInstallData(wrongUrl), undefined);
});

test("authorized source preparation automatically records exact registry archives when gitHead is absent", async t => {
  const base = testScratchPath("npm-registry-source-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fx = npmTreeTestData(), request = { scope: fx.plan.tree.scope, name: fx.plan.tree.root.name, version: fx.plan.tree.root.version,
    target: fx.target, lock: fx.plan.lock };
  const store = createFilePermissionStore({ path: path.join(root, "permission.ndjson") });
  const preparationId = npmPreparationId(request), grant = await store.issue({ action: "acquire", candidateId: preparationId,
    packageVersionId: preparationId, scope: request.scope, issuedAt: new Date(0).toISOString(), expiry: new Date(60_000).toISOString() });
  assert.ok(grant.ok);
  assert.ok(recordOf(fx.plan.lock.packages));
  const packages = fx.plan.lock.packages;
  const prepared = await prepareNpmInstallation(request, { approval: store, token: { grantId: grant.grant.grantId }, now: () => 0,
    signal: new AbortController().signal, transport: { get: async fetch => {
      const body = fx.bodies.get(fetch.url);
      if (body !== undefined) return ok({ status: 200, body });
      const pkg = fx.plan.tree.packages.find(row => fetch.url === `https://registry.npmjs.org/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`);
      assert.ok(pkg);
      const metadata = packages[pkg.location];
      assert.ok(recordOf(metadata));
      return ok({ status: 200, body: Buffer.from(JSON.stringify({ ...metadata, name: pkg.name, version: pkg.version })) });
    } } });

  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.ok(decodeNpmInstallData(prepared.plan));

  for (const row of prepared.plan.packages) {
    assert.ok(row.review.schemaVersion === 2);
    assert.equal(row.review.sourceIdentity.claims?.kind, "publisher_claimed");
    assert.equal(row.review.sourceIdentity.claims?.revision, undefined);
    assert.equal(Object.hasOwn(row.review, "sourceRevision"), false);
    const pkg: NpmLockedPackage | undefined = prepared.plan.tree.packages.find(item => item.location === row.location);
    assert.ok(pkg);
    assert.equal(row.review.sourceIdentity.archiveUrl, pkg.archiveUrl);
    assert.equal(row.review.sourceIdentity.integrity, pkg.integrity);
  }
});
