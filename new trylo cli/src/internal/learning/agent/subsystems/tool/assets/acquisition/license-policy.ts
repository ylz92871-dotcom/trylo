import type {
  LicenseDecision,
  LicenseSpdx,
  ProposedUse,
  ToolCandidate,
} from "../../../../../../tooling/contract/types.js";

const PREFERRED: ReadonlySet<LicenseSpdx> = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
]);

const COPYLEFT: ReadonlySet<LicenseSpdx> = new Set([
  "GPL-2.0-only",
  "GPL-3.0-only",
  "AGPL-3.0-only",
]);

export function classifyLicense(
  spdx: LicenseSpdx,
  proposedUse: ProposedUse,
  candidate: Pick<
    ToolCandidate,
    "noticePresent" | "sbomPresent" | "patentAudit" | "bundleAudit" | "typeLeakRisk" | "hasVendoredBinary" | "licenseMatchesVendored"
  >,
): LicenseDecision {
  if (COPYLEFT.has(spdx) || spdx === "UNKNOWN" || spdx === "UNLICENSED" || spdx === "SOURCE-AVAILABLE") {
    return { decision: "reject", spdx, reason: `license ${spdx} is default-deny` };
  }

  if (candidate.hasVendoredBinary && !candidate.licenseMatchesVendored) {
    return {
      decision: "reject",
      spdx,
      reason: "LICENSE does not match vendored binary provenance",
    };
  }

  if (PREFERRED.has(spdx)) {
    return { decision: "prefer", spdx };
  }

  if (spdx === "Apache-2.0") {
    if (proposedUse === "core-fork" || proposedUse === "invasive") {
      return {
        decision: "reject",
        spdx,
        reason: "Apache-2.0 cannot enter core or invasive without a product-owner ADR",
      };
    }

    const missing: string[] = [];

    if (!candidate.noticePresent) {
      missing.push("NOTICE");
    }

    if (!candidate.sbomPresent) {
      missing.push("SBOM");
    }

    if (candidate.patentAudit !== "complete") {
      missing.push("patent");
    }

    if (candidate.bundleAudit !== "complete") {
      missing.push("bundle");
    }

    if (candidate.typeLeakRisk !== "none") {
      missing.push("type_leak");
    }

    return { decision: "apache_needs_audit", spdx: "Apache-2.0", missing };
  }

  return { decision: "reject", spdx, reason: `license ${spdx} is not in the default-allow set` };
}
