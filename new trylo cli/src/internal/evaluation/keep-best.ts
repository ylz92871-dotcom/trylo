import type {
  ConfidenceInterval,
  EvaluationEvidenceDraft,
  KeepBestResult,
} from "./types.js";

export function wilsonInterval(passes: number, n: number): ConfidenceInterval {
  if (n <= 0 || !Number.isFinite(n) || !Number.isFinite(passes)) {
    return { n: 0, low: 0, high: 0 };
  }

  const z = 1.96;
  const p = Math.min(1, Math.max(0, passes / n));
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);

  return {
    n,
    low: clamp01((center - margin) / denom),
    high: clamp01((center + margin) / denom),
  };
}

export function keepBest(bundle: EvaluationEvidenceDraft): KeepBestResult {
  if (bundle.externalPass === true && bundle.verdict === "recommend_shadow") {
    return {
      kind: "keep_candidate",
      activationEligible: false,
      proposalId: bundle.proposalId,
    };
  }
  return { kind: "keep_baseline", reason: bundle.verdict };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
