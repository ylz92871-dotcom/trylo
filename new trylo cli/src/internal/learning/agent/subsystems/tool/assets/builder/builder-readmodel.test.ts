import assert from "node:assert/strict";
import test from "node:test";
import { admitBuiltPackage } from "./admit.js";
import { executeContribution, prepareContributionBundle, scanSensitive } from "../contribution/bundle.js";
import { archive, issuedGrantRef, memoryPermissionStore, passingSignals } from "../../../../../../tooling/testing/fixtures.js";
import { projectMyTools } from "../my-tools/projector.js";
import { assertNewVersion } from "../../../../../../tooling/package-spi/manifest.js";
import { design, manifest, pkg, provenance } from "../../../../../../tooling/testing/fixtures.js";
import { buildPackageVersion, refineDescription } from "./design.js";

test("modify without approval does not build", async () => {
  const result = await buildPackageVersion({
    now: "2026-09-12T00:00:00Z",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.1.0",
    scope: "docs",
    design: design(),
    origin: "self_created",
    noSuitableCandidate: true,
    narrowGap: false,
    taskLocal: false,
    manifest: manifest({ version: "1.1.0", origin: "self_created" }),
    provenance: provenance(),
    contentHash: "hash-2",
  });
  assert.equal(result.ok, false);
});

test("modify without an injected port does not build", async () => {
  const result = await buildPackageVersion({
    token: { grantId: "grant:unused" },
    now: "2026-09-12T00:00:00Z",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:3.0.0",
    scope: "docs",
    design: design(),
    origin: "self_created",
    noSuitableCandidate: true,
    narrowGap: false,
    taskLocal: false,
    manifest: manifest({ version: "3.0.0", origin: "self_created" }),
    provenance: provenance(),
    contentHash: "hash-3",
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "no_port");
  }
});

test("self_created packages still go through quarantine verification", async () => {
  const store = memoryPermissionStore();
  const built = await buildPackageVersion({
    approvalPort: store,
    token: await issuedGrantRef(store, "modify", { packageVersionId: "pkg:pdf-lint:2.0.0" }),
    now: "2026-09-12T00:00:00Z",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:2.0.0",
    scope: "docs",
    design: design(),
    origin: "self_created",
    noSuitableCandidate: true,
    narrowGap: false,
    taskLocal: false,
    manifest: manifest({ version: "2.0.0", origin: "self_created" }),
    provenance: provenance(),
    contentHash: "hash-self",
  });

  assert.equal(built.ok, true);

  if (!built.ok) {
    return;
  }

  assert.equal(built.value.origin, "self_created");
  assert.equal(built.value.catalogState, "quarantined");
  const admitted = admitBuiltPackage({
    pkg: built.value,
    archive: archive(),
    compressedBytes: 32,
    signals: passingSignals(),
  });

  assert.equal(admitted.ok, true);

  if (admitted.ok) {
    assert.equal(admitted.value.pkg.catalogState, "verified");
  }
});

test("contribution scan rejects Trylo worktree paths", () => {
  const hits = scanSensitive("see worktrees\\wp-p01-d\\src");
  assert.equal(hits.includes("worktrees\\wp-p01-d"), true);
});

test("task-local scripts do not enter My Tools even when successful", async () => {
  const store = memoryPermissionStore();
  const result = await buildPackageVersion({
    approvalPort: store,
    token: await issuedGrantRef(store, "modify", { packageVersionId: "pkg:pdf-lint:1.1.0" }),
    now: "2026-09-12T00:00:00Z",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.1.0",
    scope: "docs",
    design: design(),
    origin: "self_created",
    noSuitableCandidate: true,
    narrowGap: false,
    taskLocal: true,
    manifest: manifest({ version: "1.1.0", origin: "self_created" }),
    provenance: provenance(),
    contentHash: "hash-2",
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "task_local_not_cataloged");
  }
});

test("optimized tools keep upstream parent provenance and new versions", async () => {
  const store = memoryPermissionStore();
  const parent = pkg();
  const built = await buildPackageVersion({
    approvalPort: store,
    token: await issuedGrantRef(store, "modify", { packageVersionId: "pkg:pdf-lint:1.1.0" }),
    now: "2026-09-12T00:00:00Z",
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.1.0",
    scope: "docs",
    design: design(),
    origin: "optimized",
    parent,
    noSuitableCandidate: false,
    narrowGap: true,
    taskLocal: false,
    manifest: manifest({ version: "1.1.0", origin: "optimized" }),
    provenance: provenance({ parentVersionId: parent.packageVersionId }),
    contentHash: "hash-2",
  });

  assert.equal(built.ok, true);

  if (!built.ok) {
    return;
  }

  assert.equal(built.value.origin, "optimized");
  assert.equal(built.value.provenance.parentVersionId, parent.packageVersionId);
  const overwrite = assertNewVersion(parent, parent);

  assert.equal(overwrite.ok, false);
});

test("DRAFT description refinement requires trajectories and a new version", () => {
  const missing = refineDescription("pkg:1", "old", [], "new");
  assert.equal(missing.ok, false);
  const same = refineDescription("pkg:1", "old", ["t1"], "old");
  assert.equal(same.ok, false);
  const next = refineDescription("pkg:1", "old", ["t1"], "new hint");
  assert.equal(next.ok, true);
});

test("My Tools is a rebuildable read model and cannot self-write active", () => {
  const local = pkg({ catalogState: "verified" });
  const entries = projectMyTools({
    packages: [local],
    validations: [
      {
        validationId: "v1",
        packageVersionId: local.packageVersionId,
        stages: [],
        verdict: "pass",
        actor: "verifier",
      },
    ],
    activations: [],
    contributionByPackage: {},
  });

  assert.equal(entries[0]?.lifecycle, "verified");
  assert.equal("active" in (entries[0] ?? {}), false);
  const activated = projectMyTools({
    packages: [local],
    validations: [
      {
        validationId: "v1",
        packageVersionId: local.packageVersionId,
        stages: [],
        verdict: "pass",
        actor: "verifier",
      },
    ],
    activations: [
      {
        packageVersionId: local.packageVersionId,
        scope: "docs",
        state: "active",
        boardSequence: 4,
      },
    ],
    contributionByPackage: {},
  });

  assert.equal(activated[0]?.lifecycle, "active");
  assert.equal(activated[0]?.scopeBinding, "docs");
});

test("contribution bundle stays local and never publishes", async () => {
  const optimized = pkg({
    origin: "optimized",
    manifest: manifest({ origin: "optimized" }),
    provenance: provenance({ parentVersionId: "pkg:pdf-lint:1.0.0" }),
  });
  const bundle = prepareContributionBundle({
    pkg: optimized,
    diff: "diff --git a/server.mjs b/server.mjs\n",
    tests: ["bounds"],
    changeSummary: "narrow pdf table fix",
  });

  assert.equal(bundle.ok, true);

  if (bundle.ok) {
    assert.deepEqual(bundle.value.externalActions, []);
  }

  const store = memoryPermissionStore();
  const published = await executeContribution(
    store,
    await issuedGrantRef(store, "contribute"),
    "2026-09-12T00:00:00Z",
    "cand-mit",
    "pkg:pdf-lint:1.0.0",
    "docs",
    "pull_request",
  );

  assert.equal(published.ok, false);

  if (!published.ok) {
    assert.equal(published.code, "external_action_forbidden");
  }
});
