import { shortId } from "../../../../domains/shared/hash.js";
import type { ExperienceReview } from "../experience-port.js";
import type { MethodExperienceFact } from "./experience-facts.js";
import { isCompiledProcedure } from "./procedure.js";
import { scopePredicateKey } from "./scope-learning.js";

type CompilationReviewShape = Pick<ExperienceReview, "decision" | "compact" | "procedure">;

type ReviewFact = Extract<MethodExperienceFact, { kind: "review" }>;

/** Historical promote/expression compacts remain readable. A narrowing can
 * become a fresh compilation only when it also supplies complete practice. */
export function isCompilationReview(review: CompilationReviewShape): review is CompilationReviewShape & {
  readonly compact: NonNullable<ExperienceReview["compact"]>;
} {
  return review.compact !== undefined && (review.decision === "promote" || review.decision === "expression" ||
    (review.decision === "narrow" && isCompiledProcedure(review.procedure)));
}

/** The review is durable before its effects. A narrowed compilation is not
 * fieldable until this review's exact restriction has committed. This tests
 * application, not whether a later compilation superseded or withdrew it. */
export function isCompilationApplied(facts: readonly MethodExperienceFact[], fact: ReviewFact,
  beforeSequence = Number.POSITIVE_INFINITY): boolean {
  if (!isCompilationReview(fact.review) || fact.sequence >= beforeSequence) return false;

  if (fact.review.decision !== "narrow") return true;

  const narrowed = fact.review.scopes?.find(scope => scope.scopeId === fact.scopeId && scope.versionId === fact.versionId);
  if (narrowed === undefined) return false;

  const effectId = shortId("method-restriction", [fact.snapshotId]);

  return facts.some(effect => effect.kind === "restriction" && effect.factId === effectId &&
    effect.versionId === fact.versionId && effect.scopeId === fact.scopeId && effect.sequence > fact.sequence &&
    effect.sequence < beforeSequence && scopePredicateKey(effect.predicate) === scopePredicateKey(narrowed.predicate));
}
