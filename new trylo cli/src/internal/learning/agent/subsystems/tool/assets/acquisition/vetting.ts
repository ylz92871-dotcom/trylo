import type {
  ToolCandidate,
  VettingConclusion,
} from "../../../../../../tooling/contract/types.js";
import { classifyLicense } from "./license-policy.js";

export type VettingEvidenceRequest = {
  readonly candidateId: string;
  readonly officialIdentity: ToolCandidate["officialIdentity"];
  readonly maintainerDepth: ToolCandidate["maintainerDepth"];
  readonly releaseMaturity: ToolCandidate["releaseMaturity"];
  readonly windowsEvidence: ToolCandidate["windowsEvidence"];
  readonly competingOptions: readonly string[];
  readonly boundedSpikeRequired: boolean;
  readonly exitPath: string;
  readonly proposedUse: ToolCandidate["proposedUse"];
  readonly starCount: number;
  readonly fromOpenTree: boolean;
};

export type VettingReport = {
  readonly conclusion: VettingConclusion;
  readonly reason: string;
  readonly evidenceRequest: VettingEvidenceRequest;
  readonly alternativesCompared: readonly string[];
};

const CORE_STAR_GATE = 5000;
const COWORK_MARKERS = ["cowork-os", "cowork_os", "coworkos"];

function isCoworkOs(candidate: ToolCandidate): boolean {
  const haystack = `${candidate.name} ${candidate.sourceUrl}`.toLowerCase();
  return COWORK_MARKERS.some((marker) => haystack.includes(marker));
}

export function requestVettingEvidence(
  candidate: ToolCandidate,
  alternatives: readonly ToolCandidate[],
): VettingEvidenceRequest {
  return {
    candidateId: candidate.candidateId,
    officialIdentity: candidate.officialIdentity,
    maintainerDepth: candidate.maintainerDepth,
    releaseMaturity: candidate.releaseMaturity,
    windowsEvidence: candidate.windowsEvidence,
    competingOptions: alternatives.map((item) => item.candidateId),
    boundedSpikeRequired: candidate.proposedUse === "invasive" || candidate.proposedUse === "core-fork",
    exitPath: candidate.exitPath,
    proposedUse: candidate.proposedUse,
    starCount: candidate.starCount,
    fromOpenTree: candidate.fromOpenTree,
  };
}

export function vetCandidate(
  candidate: ToolCandidate,
  alternatives: readonly ToolCandidate[],
  apacheUserApproved = false,
): VettingReport {
  const evidenceRequest = requestVettingEvidence(candidate, alternatives);
  const alternativesCompared = alternatives.map((item) => item.candidateId);

  if (isCoworkOs(candidate) && (candidate.proposedUse === "core-fork" || candidate.proposedUse === "invasive")) {
    return {
      conclusion: "reject",
      reason: "CoWork-OS is forbidden as core, forked, embedded, or invasive",
      evidenceRequest,
      alternativesCompared,
    };
  }

  if (candidate.fromOpenTree) {
    return {
      conclusion: "reference_only",
      reason: "open/ contents are reference only until independently vetted and approved",
      evidenceRequest,
      alternativesCompared,
    };
  }

  if (candidate.officialIdentity === "impersonation_risk") {
    return {
      conclusion: "reject",
      reason: "official identity impersonation risk",
      evidenceRequest,
      alternativesCompared,
    };
  }

  const license = classifyLicense(candidate.licenseSpdx, candidate.proposedUse, candidate);
  if (license.decision === "reject") {
    return {
      conclusion: "reject",
      reason: license.reason,
      evidenceRequest,
      alternativesCompared,
    };
  }

  if (license.decision === "apache_needs_audit") {
    if (license.missing.length > 0) {
      return {
        conclusion: "reference_only",
        reason: `Apache-2.0 blocked pending ${license.missing.join(", ")}`,
        evidenceRequest,
        alternativesCompared,
      };
    }

    if (!apacheUserApproved) {
      return {
        conclusion: "reference_only",
        reason: "Apache-2.0 blocked pending user approval",
        evidenceRequest,
        alternativesCompared,
      };
    }

    return {
      conclusion: "isolated_trial",
      reason: "Apache-2.0 leaf after NOTICE/SBOM/patent/bundle/type-leak audit and user approval",
      evidenceRequest,
      alternativesCompared,
    };
  }

  const invasive = candidate.proposedUse === "invasive" || candidate.proposedUse === "core-fork";
  if (invasive) {
    if (candidate.starCount < CORE_STAR_GATE) {
      return {
        conclusion: "reject",
        reason: `invasive/core-fork star gate ${CORE_STAR_GATE} not met`,
        evidenceRequest,
        alternativesCompared,
      };
    }

    if (candidate.maintainerDepth !== "deep" || candidate.releaseMaturity !== "stable") {
      return {
        conclusion: "reference_only",
        reason: "invasive/core-fork lacks maintainer depth or release maturity",
        evidenceRequest,
        alternativesCompared,
      };
    }

    if (candidate.windowsEvidence !== "tested") {
      return {
        conclusion: "isolated_trial",
        reason: "invasive candidate lacks tested Windows history",
        evidenceRequest,
        alternativesCompared,
      };
    }

    if (alternatives.length < 1) {
      return {
        conclusion: "reject",
        reason: "invasive/core-fork requires comparison against at least two alternatives",
        evidenceRequest,
        alternativesCompared,
      };
    }

    return {
      conclusion: "eligible",
      reason: "invasive/core-fork passed repository-vetting evidence gates",
      evidenceRequest,
      alternativesCompared,
    };
  }

  if (candidate.officialIdentity === "unverified") {
    return {
      conclusion: "reference_only",
      reason: "identity not verified as official",
      evidenceRequest,
      alternativesCompared,
    };
  }

  if (candidate.releaseMaturity === "stagnant") {
    return {
      conclusion: "reference_only",
      reason: "maintenance is stagnant",
      evidenceRequest,
      alternativesCompared,
    };
  }

  return {
    conclusion: "isolated_trial",
    reason: "preferred license leaf may enter assessed; acquire still requires approval",
    evidenceRequest,
    alternativesCompared,
  };
}
