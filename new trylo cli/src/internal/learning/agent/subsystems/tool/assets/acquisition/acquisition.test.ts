import assert from "node:assert/strict";
import test from "node:test";
import { candidate } from "../../../../../../tooling/testing/fixtures.js";
import { assessCandidates } from "./comparator.js";
import { createFakeDiscoveryPort, normalizeHits } from "./discovery.js";
import { classifyLicense } from "./license-policy.js";
import { vetCandidate } from "./vetting.js";

const mit = candidate({ candidateId: "cand-mit", name: "pdf-lint" });
const mitAlt = candidate({ candidateId: "cand-mit-alt", name: "pdf-lint-alt", starCount: 800 });

test("MIT healthy leaf can be assessed and is not auto-acquired", () => {
  const assessed = assessCandidates([mit, mitAlt]);

  assert.equal(assessed.ok, true);

  if (!assessed.ok) {
    return;
  }

  assert.equal(assessed.value.kind, "compared");

  if (assessed.value.kind === "compared") {
    assert.equal(assessed.value.suitable.length > 0, true);
    assert.equal(
      assessed.value.suitable.every((item) => item.vetting.conclusion !== "eligible" || item.candidate.proposedUse !== "leaf"),
      true,
    );
  }
});

test("Apache-2.0 without NOTICE/SBOM/user approval cannot isolated-trial", () => {
  const apache = candidate({
    candidateId: "cand-apache",
    name: "apache-leaf",
    licenseSpdx: "Apache-2.0",
    noticePresent: false,
    sbomPresent: false,
    patentAudit: "missing",
    bundleAudit: "missing",
  });
  const report = vetCandidate(apache, [mit], false);

  assert.equal(report.conclusion, "reference_only");
});

test("Apache-2.0 leaf with full audit and user approval is isolated trial only", () => {
  const apache = candidate({
    candidateId: "cand-apache-ok",
    name: "apache-leaf",
    licenseSpdx: "Apache-2.0",
  });
  const report = vetCandidate(apache, [mit], true);

  assert.equal(report.conclusion, "isolated_trial");
});

test("high comparator score cannot pass a GPL candidate", () => {
  const gpl = candidate({
    candidateId: "gpl-star",
    name: "gpl-star",
    licenseSpdx: "GPL-3.0-only",
    starCount: 90000,
    maintainerDepth: "deep",
    releaseMaturity: "stable",
    windowsEvidence: "tested",
  });
  const mit = candidate({ candidateId: "cand-mit", name: "pdf-lint" });
  const assessed = assessCandidates([gpl, mit]);

  assert.equal(assessed.ok, true);

  if (assessed.ok && assessed.value.kind === "compared") {
    const row = assessed.value.ranked.find((item) => item.candidate.candidateId === "gpl-star");
    assert.equal(row?.vetting.conclusion, "reject");
    assert.equal(
      assessed.value.suitable.some((item) => item.candidate.candidateId === "gpl-star"),
      false,
    );
  }
});

test("GPL AGPL unknown and source-available default reject", () => {
  for (const spdx of ["GPL-3.0-only", "AGPL-3.0-only", "UNKNOWN", "SOURCE-AVAILABLE"] as const) {
    const report = classifyLicense(spdx, "leaf", mit);
    assert.equal(report.decision, "reject");
  }
});

test("impersonation and stagnant invasive fail vetting", () => {
  const fake = candidate({
    candidateId: "cand-fake",
    name: "official-pdf",
    officialIdentity: "impersonation_risk",
  });

  assert.equal(vetCandidate(fake, [mit]).conclusion, "reject");
  const stagnant = candidate({
    candidateId: "cand-stagnant",
    name: "old-runtime",
    proposedUse: "invasive",
    starCount: 9000,
    releaseMaturity: "stagnant",
    maintainerDepth: "shallow",
  });

  assert.notEqual(vetCandidate(stagnant, [mit]).conclusion, "eligible");
});

test("open/ hits remain reference only", () => {
  const openHit = candidate({ candidateId: "cand-open", name: "voyager", fromOpenTree: true });
  assert.equal(vetCandidate(openHit, [mit]).conclusion, "reference_only");
});

test("CoWork-OS core-fork is rejected", () => {
  const cowork = candidate({
    candidateId: "cand-cowork",
    name: "CoWork-OS",
    sourceUrl: "https://example.invalid/cowork-os",
    proposedUse: "core-fork",
    starCount: 9000,
  });
  assert.equal(vetCandidate(cowork, [mit]).conclusion, "reject");
});

test("single candidate without an alternative fails assessment", () => {
  const assessed = assessCandidates([mit]);
  assert.equal(assessed.ok, false);
});

test("empty discovery yields no suitable candidate", () => {
  const port = createFakeDiscoveryPort([mit, mitAlt]);
  const hits = port.search("spreadsheet");

  assert.equal(hits.ok, true);

  if (!hits.ok) {
    return;
  }

  assert.equal(normalizeHits(hits.value).length, 0);
  const assessed = assessCandidates([]);

  assert.equal(assessed.ok, true);

  if (assessed.ok) {
    assert.equal(assessed.value.kind, "no_suitable_candidate");
  }
});

test("unknown binary license mismatch rejects", () => {
  const binary = candidate({
    candidateId: "cand-bin",
    name: "mystery",
    hasVendoredBinary: true,
    licenseMatchesVendored: false,
  });
  assert.equal(classifyLicense("MIT", "leaf", binary).decision, "reject");
});
