import { err, ok, type Result } from "../../../../../../tooling/contract/result.js";
import type { ToolCandidate } from "../../../../../../tooling/contract/types.js";
import { vetCandidate, type VettingReport } from "./vetting.js";

export type ScoredCandidate = {
  readonly candidate: ToolCandidate;
  readonly score: number;
  readonly vetting: VettingReport;
};

export type Assessment =
  | {
      readonly kind: "compared";
      readonly ranked: readonly ScoredCandidate[];
      readonly suitable: readonly ScoredCandidate[];
    }
  | { readonly kind: "no_suitable_candidate"; readonly ranked: readonly ScoredCandidate[] };

function scoreCandidate(candidate: ToolCandidate): number {
  let score = 0;

  score += candidate.capabilities.length * 3;

  if (candidate.windowsEvidence === "tested") {
    score += 8;
  } else if (candidate.windowsEvidence === "claimed") {
    score += 2;
  }

  if (candidate.maintainerDepth === "deep") {
    score += 6;
  }

  if (candidate.releaseMaturity === "stable") {
    score += 6;
  }

  if (candidate.interfaceKind === "mcp") {
    score += 4;
  }

  if (
    candidate.licenseSpdx === "MIT" ||
    candidate.licenseSpdx === "ISC" ||
    candidate.licenseSpdx === "BSD-2-Clause" ||
    candidate.licenseSpdx === "BSD-3-Clause" ||
    candidate.licenseSpdx === "0BSD"
  ) {
    score += 5;
  }

  if (candidate.officialIdentity === "official") {
    score += 5;
  }

  if (candidate.supplyChainRisk === "low") {
    score += 3;
  } else if (candidate.supplyChainRisk === "high") {
    score -= 6;
  }

  if (candidate.dependencySbom.length > 0) {
    score += 2;
  }

  if (candidate.exitPath.length > 0) {
    score += 2;
  }

  score -= candidate.requiredPermissions.length;

  return score;
}

export function assessCandidates(
  candidates: readonly ToolCandidate[],
  apacheUserApproved = false,
): Result<Assessment, "insufficient_alternatives"> {
  if (candidates.length === 0) {
    return ok({ kind: "no_suitable_candidate", ranked: [] });
  }

  if (candidates.length === 1) {
    return err("insufficient_alternatives", "assessment requires at least two alternatives or an explicit empty set");
  }

  const ranked: ScoredCandidate[] = candidates.map((candidate) => {
    const others = candidates.filter((item) => item.candidateId !== candidate.candidateId);
    return {
      candidate,
      score: scoreCandidate(candidate),
      vetting: vetCandidate(candidate, others, apacheUserApproved),
    };
  });

  ranked.sort((left, right) => right.score - left.score);
  const suitable = ranked.filter(
    (item) =>
      item.vetting.conclusion === "isolated_trial" || item.vetting.conclusion === "eligible",
  );
  if (suitable.length === 0) {
    return ok({ kind: "no_suitable_candidate", ranked });
  }

  return ok({ kind: "compared", ranked, suitable });
}
