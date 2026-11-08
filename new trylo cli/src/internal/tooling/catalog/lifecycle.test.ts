import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyLicense } from "../../learning/agent/subsystems/tool/assets/acquisition/license-policy.js";
import { requestVettingEvidence } from "../../learning/agent/subsystems/tool/assets/acquisition/vetting.js";
import { prepareContributionBundle } from "../../learning/agent/subsystems/tool/assets/contribution/bundle.js";
import { validateManifest } from "../package-spi/manifest.js";
import { acquireToQuarantine } from "../../learning/agent/subsystems/tool/adapters/quarantine/acquire.js";
import { archive, candidate, issuedGrantRef, manifest, memoryPermissionStore, pkg, passingSignals, provenance } from "../testing/fixtures.js";
import { attachVerification, runValidationPipeline } from "../../learning/agent/subsystems/tool/assets/validation/pipeline.js";
import { detectToolGap } from "../../learning/agent/subsystems/tool/domain/gap-detector.js";
import { observation } from "../testing/fixtures.js";
import { catalogCannotBecomeActive, transitionCatalog } from "./lifecycle.js";
import { nextToolUsePhase } from "./phases.js";

test("acquire then verify never writes active on the catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-life-"));
  const store = memoryPermissionStore();

  try {
    const acquired = await acquireToQuarantine({
      approvalPort: store,
      token: await issuedGrantRef(store, "acquire"),
      now: "2026-09-12T00:00:00Z",
      candidateId: "cand-mit",
      packageVersionId: "pkg:pdf-lint:1.0.0",
      scope: "docs",
      quarantineRoot: root,
      archive: archive(),
      compressedBytes: 32,
      manifest: manifest(),
      provenance: provenance(),
    });

    assert.equal(acquired.ok, true);

    if (!acquired.ok) {
      return;
    }

    assert.equal(acquired.value.catalogState, "quarantined");
    const validated = runValidationPipeline({
      validationId: "v-life",
      pkg: acquired.value,
      archive: archive(),
      compressedBytes: 32,
      actor: "verifier",
      signals: passingSignals(),
    });

    assert.equal(validated.ok, true);

    if (!validated.ok) {
      return;
    }

    const attached = attachVerification(acquired.value, validated.value);

    assert.equal(attached.ok, true);

    if (!attached.ok) {
      return;
    }

    assert.equal(attached.value.catalogState, "verified");
    assert.equal((attached.value.catalogState as string) === "active", false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog lifecycle cannot jump to active or skip quarantine", () => {
  const discovered = pkg({ catalogState: "discovered" });
  const assessed = transitionCatalog(discovered, "assessed");

  assert.equal(assessed.ok, true);
  const skip = transitionCatalog(discovered, "verified");

  assert.equal(skip.ok, false);
  const waiting = pkg({ catalogState: "awaiting_activation_approval" });
  const active = transitionCatalog(waiting, "verified");

  assert.equal(active.ok, false);
  assert.equal(catalogCannotBecomeActive("verified"), true);
});

test("modify branch is designing then building then quarantined", () => {
  const waiting = pkg({ catalogState: "awaiting_modify_approval" });
  const designing = transitionCatalog(waiting, "designing");

  assert.equal(designing.ok, true);

  if (!designing.ok) {
    return;
  }

  const building = transitionCatalog(designing.value, "building");

  assert.equal(building.ok, true);

  if (!building.ok) {
    return;
  }

  const quarantined = transitionCatalog(building.value, "quarantined");

  assert.equal(quarantined.ok, true);
});

test("discovery schema load and execution are ordered", () => {
  assert.equal(nextToolUsePhase("discovery", "execute"), "execution_before_schema");
  assert.equal(nextToolUsePhase("discovery", "load_schema"), "schema_load");
  assert.equal(nextToolUsePhase("schema_load", "execute"), "execution");
});

test("gap kinds cover schema platform workaround and mismatch", () => {
  const kinds = [
    "schema_friction",
    "platform_incompatible",
    "manual_workaround",
    "capability_mismatch",
    "tool_not_found",
  ] as const;
  for (const kind of kinds) {
    const result = detectToolGap([
      observation({ observationId: `${kind}-1`, kind }),
      observation({ observationId: `${kind}-2`, kind }),
      observation({ observationId: `${kind}-3`, kind }),
    ]);

    assert.equal(result.ok, true);

    if (result.ok && result.value.decision === "gap") {
      assert.equal(result.value.gap.observationIds.length, 3);
    }
  }
});

test("ISC BSD and 0BSD are preferred licenses", () => {
  const leaf = candidate({ candidateId: "l", name: "l" });
  for (const spdx of ["ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"] as const) {
    assert.equal(classifyLicense(spdx, "leaf", leaf).decision, "prefer");
  }
});

test("invasive vetting evidence requests a bounded spike", () => {
  const invasive = candidate({
    candidateId: "inv",
    name: "inv",
    proposedUse: "invasive",
    starCount: 9000,
  });
  const evidence = requestVettingEvidence(invasive, [candidate({ candidateId: "alt", name: "alt" })]);

  assert.equal(evidence.boundedSpikeRequired, true);
});

test("third-party type leak fails the package SPI", () => {
  const leaked = validateManifest(manifest({ thirdPartyTypes: "leaked" }));
  assert.equal(leaked.ok, false);
});

test("contribution bundle includes a local-only commit plan", () => {
  const bundle = prepareContributionBundle({
    pkg: pkg({
      origin: "optimized",
      manifest: manifest({ origin: "optimized" }),
      provenance: provenance({ parentVersionId: "pkg:pdf-lint:1.0.0" }),
    }),
    diff: "diff --git a/a b/a\n",
    tests: ["unit"],
    changeSummary: "narrow fix",
  });

  assert.equal(bundle.ok, true);

  if (bundle.ok) {
    assert.equal(bundle.value.commitPlan.includes("do not git push"), true);
  }
});
