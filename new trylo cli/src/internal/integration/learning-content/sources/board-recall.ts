import type { ContentRecallCandidate } from "./board-contract.js";

/** Cheap candidate recall only; shared words never establish that two questions are the same. */
export function rankContentRecall(candidates: readonly ContentRecallCandidate[], taskPurpose: string): readonly ContentRecallCandidate[] {
  const terms = recallTerms(taskPurpose), score = (candidate: ContentRecallCandidate): number => {
    const available = recallTerms(candidate.description);
    return [...terms].reduce((sum, term) => sum + (available.has(term) ? 1 : 0), 0);
  };
  const scores = new Map(candidates.map(candidate => [candidate.id, score(candidate)]));

  return [...candidates].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
    || Number(b.active) - Number(a.active) || b.sequence - a.sequence || a.id.localeCompare(b.id));
}

function recallTerms(text: string): ReadonlySet<string> {
  const normalized = text.slice(0, 8192).toLowerCase(), terms: string[] = [...(normalized.match(/[\p{L}\p{N}_]{2,}/gu) ?? [])];
  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let index = 0; index + 1 < run.length; index++) terms.push(run.slice(index, index + 2));
  }
  return new Set(terms);
}
