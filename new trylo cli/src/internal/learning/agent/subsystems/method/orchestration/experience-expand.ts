import { canonicalObservations, type MethodObservation } from "../domain/inference-observations.js";
import { isCompilationApplied } from "../domain/compilation-review.js";
import { effectivePredicate, matureReview, scopesOf, type ReviewFact } from "../domain/experience-state.js";
import { renderExperience } from "../domain/experience-render.js";
import type { ExperienceReview } from "../experience-port.js";
import type { ExperienceView } from "./experience-runtime.js";
import { compilationBlockFor } from "../domain/compilation-block.js";
import { scopeCaption } from "../domain/scope-description.js";

type Rationale = NonNullable<ExperienceReview["procedure"]>["eliminatedDecisions"][number];

/** Expansion explains the actually bound program and its source. Whole-record
 * omission keeps JSON valid and respects the existing tool's byte ceiling. */
export function expandExperience(view: ExperienceView, versionId: string, compilationId?: string): string {
  const variant = view.variants.find(item => item.versionId === versionId);
  if (variant === undefined) throw new Error("method_source_missing");

  const focus = [...view.facts].reverse().find((item): item is ReviewFact => item.kind === "review" && item.versionId === versionId &&
    (compilationId === undefined ? isCompilationApplied(view.facts, item) : item.factId === compilationId));
  const latest = [...view.facts].reverse().find((item): item is ReviewFact => item.kind === "review" && item.versionId === versionId);
  const scope = focus === undefined ? undefined : scopesOf(view, versionId).find(item => item.hypothesis.scopeId === focus.scopeId);
  const current = scope === undefined ? undefined : matureReview(view, scope.hypothesis);
  const evidence: MethodObservation[] = [], rationale: Rationale[] = [];
  const scopeDetails: { readonly scopeId: string; readonly predicate: ReturnType<typeof effectivePredicate> }[] = [];
  const blocking: BlockDetail[] = [];
  const assessments: AssessmentDetail[] = [];
  const omitted = { evidence: 0, rationale: 0, scopes: 0, blocking: 0, latestAssessment: 0 };
  const base = { versionId, original: variant.card, ...(focus?.review.compact === undefined ? {} : { compilation: {
    compilationId: focus.factId, scopeId: focus.scopeId, currentDefault: current?.factId === focus.factId,
    execution: renderExperience({ compact: focus.review.compact, ...(focus.review.procedure === undefined ? {} : { procedure: focus.review.procedure }) }),
    snapshotId: focus.snapshotId, judgment: focus.review.reason.slice(0, 240),
  } }) };
  const encode = () => JSON.stringify({ ...base, scopes: scopeDetails, blocking, rationale, evidence,
    ...(assessments.length === 0 ? {} : { latestAssessment: assessments[0] }), omitted });
  const priorBlock = focus === undefined ? undefined : compilationBlockFor(view.facts,
    { versionId, scopeId: focus.scopeId, compilationId: focus.factId });
  if (priorBlock !== undefined && !appendWithinBudget(blocking, { context: priorBlock.context,
    decision: priorBlock.decision }, encode)) omitted.blocking += 1;

  for (const item of focus?.review.procedure?.eliminatedDecisions ?? []) {
    if (!appendWithinBudget(rationale, item, encode)) omitted.rationale += 1;
  }

  for (const item of scopesOf(view, versionId)) {
    if (!appendWithinBudget(scopeDetails, { scopeId: item.hypothesis.scopeId, predicate: effectivePredicate(view, item.hypothesis) }, encode)) omitted.scopes += 1;
  }

  if (latest !== undefined && latest.factId !== focus?.factId && !appendWithinBudget(assessments, {
    reviewId: latest.factId, snapshotId: latest.snapshotId, scopeId: latest.scopeId,
    decision: latest.review.decision, score: latest.review.score, reason: scopeCaption(latest.review.reason, 1000),
    excerpted: latest.review.reason.length > 1000,
  }, encode)) omitted.latestAssessment += 1;

  const history = canonicalObservations(view.observations).filter(item => item.versionId === versionId &&
    (focus === undefined || item.compilationId === undefined || item.compilationId === focus.factId));

  for (const item of history.slice(-6).reverse()) if (!appendWithinBudget(evidence, item, encode)) omitted.evidence += 1;

  omitted.evidence += Math.max(0, history.length - 6);

  return encode();
}

type BlockDetail = Pick<Extract<ExperienceView["facts"][number], { kind: "decision" }>, "context" | "decision">;

type AssessmentDetail = { readonly reviewId: string; readonly snapshotId: string; readonly scopeId: string;
  readonly decision: ExperienceReview["decision"]; readonly score: number; readonly reason: string; readonly excerpted: boolean };

function appendWithinBudget<T>(items: T[], item: T, encode: () => string): boolean {
  items.push(item);
  // Leave headroom for omitted counters and the outer tool-result wrapper.
  if (new TextEncoder().encode(JSON.stringify(encode())).length <= 10_000) return true;
  items.pop();
  return false;
}
