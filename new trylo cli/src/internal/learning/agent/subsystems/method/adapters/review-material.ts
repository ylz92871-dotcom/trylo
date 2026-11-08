import type { ExperienceReviewRequest } from "../experience-port.js";

type MaterialCounts = {
  readonly observations: number;
  readonly counterexamples: number;
  readonly compiledObservations: number;
  readonly experiences: number;
  readonly executionTraces: number;
  readonly relatedSources: number;
};

type PackedRequest = ExperienceReviewRequest & {
  readonly packing: { readonly available: MaterialCounts; readonly omitted: MaterialCounts;
    readonly notice: string };
};

export type ReviewMaterialResult = { readonly ok: true; readonly supplied: ExperienceReviewRequest; readonly material: string } |
  { readonly ok: false; readonly reason: "method_review_prompt_limit" | "method_review_source_evidence_limit" };

/** Whole-record packing preserves identity, denominators and adverse evidence.
 * Counts disclose omitted detail; omission never means a missing counterexample
 * did not occur. Only supplied observations may be cited by the compiler. */
export function packReviewMaterial(request: ExperienceReviewRequest, maxMaterialChars: number,
  maxMaterialBytes = Number.POSITIVE_INFINITY): ReviewMaterialResult {
  const { observations, counterexamples, experiences, executionTraces, relatedSources, reconsideration, ...identity } = request;
  const available = countsOf(request);
  let supplied: ExperienceReviewRequest = { ...identity, observations: [], counterexamples: [],
    ...(experiences === undefined ? {} : { experiences: [] }),
    ...(executionTraces === undefined ? {} : { executionTraces: [] }),
    ...(relatedSources === undefined ? {} : { relatedSources: [] }),
    ...(reconsideration === undefined ? {} : { reconsideration: { ...reconsideration, observations: [] } }) };
  const encode = (value: ExperienceReviewRequest) => encodeMaterial(value, available);
  const fits = (value: ExperienceReviewRequest) => {
    const material = encode(value);
    return material.length <= maxMaterialChars && new TextEncoder().encode(material).length <= maxMaterialBytes;
  };
  if (!Number.isSafeInteger(maxMaterialChars) || maxMaterialChars < 0 || maxMaterialBytes < 0 ||
    (maxMaterialBytes !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(maxMaterialBytes)) || !fits(supplied)) {
    return { ok: false, reason: "method_review_prompt_limit" };
  }

  const append = (candidate: ExperienceReviewRequest): boolean => {
    if (!fits(candidate)) return false;
    supplied = candidate;
    return true;
  };
  const anchors = representativeOrder(observations).filter(item => item.versionId === request.versionId &&
    item.compilationId === undefined && item.adoption === "adopted" && item.outcome === "helped");
  if (anchors.length > 0 && !anchors.some(item => append({ ...supplied, observations: [item] }))) {
    return { ok: false, reason: "method_review_source_evidence_limit" };
  }

  for (const item of materialOrder(request)) {
    const candidate = withMaterial(supplied, item);
    if (candidate !== undefined) append(candidate);
  }

  return { ok: true, supplied, material: encode(supplied) };
}

type MaterialItem =
  | { readonly kind: "observation" | "compiled"; readonly value: ExperienceReviewRequest["observations"][number] }
  | { readonly kind: "counterexample"; readonly value: string }
  | { readonly kind: "experience"; readonly value: NonNullable<ExperienceReviewRequest["experiences"]>[number] }
  | { readonly kind: "trace"; readonly value: NonNullable<ExperienceReviewRequest["executionTraces"]>[number] }
  | { readonly kind: "related"; readonly value: NonNullable<ExperienceReviewRequest["relatedSources"]>[number] };

/** Reserve early space for semantic application/failure material and a possible
 * synthesis source. Filling the prompt with bool rows would hide how to learn. */
function materialOrder(request: ExperienceReviewRequest): readonly MaterialItem[] {
  const observations = representativeOrder(request.observations).map(value => ({ kind: "observation" as const, value }));
  const adverse = [...(request.reconsideration?.observations ?? [])].reverse().filter(item => item.outcome === "unhelpful")
    .map(value => ({ kind: "compiled" as const, value }));
  const otherCompiled = [...(request.reconsideration?.observations ?? [])].reverse().filter(item => item.outcome !== "unhelpful")
    .map(value => ({ kind: "compiled" as const, value }));
  const negatives = [...request.counterexamples].reverse().map(value => ({ kind: "counterexample" as const, value }));
  const experiences = [...(request.experiences ?? [])].sort((a, b) => Number(b.blocking !== undefined) - Number(a.blocking !== undefined))
    .map(value => ({ kind: "experience" as const, value }));
  const traces = [...(request.executionTraces ?? [])].reverse().map(value => ({ kind: "trace" as const, value }));
  const related = (request.relatedSources ?? []).map(value => ({ kind: "related" as const, value }));

  return [...adverse.slice(0, 1), ...negatives.slice(0, 1), ...experiences.slice(0, 2), ...traces.slice(0, 1),
    ...related.slice(0, 1), ...observations, ...related.slice(1), ...adverse.slice(1), ...negatives.slice(1),
    ...otherCompiled, ...experiences.slice(2), ...traces.slice(1)];
}

function withMaterial(supplied: ExperienceReviewRequest, item: MaterialItem): ExperienceReviewRequest | undefined {
  const sameObservation = (old: ExperienceReviewRequest["observations"][number]) =>
    (item.kind === "observation" || item.kind === "compiled") && old.observationId === item.value.observationId && old.revision === item.value.revision;
  switch (item.kind) {
    case "observation": return supplied.observations.some(sameObservation) ? undefined :
      { ...supplied, observations: [...supplied.observations, item.value] };
    case "compiled": return supplied.reconsideration === undefined || supplied.reconsideration.observations.some(sameObservation) ? undefined :
      { ...supplied, reconsideration: { ...supplied.reconsideration, observations: [...supplied.reconsideration.observations, item.value] } };
    case "counterexample": return supplied.counterexamples.includes(item.value) ? undefined :
      { ...supplied, counterexamples: [...supplied.counterexamples, item.value] };
    case "experience": return supplied.experiences?.some(old => old.observationId === item.value.observationId) ? undefined :
      { ...supplied, experiences: [...(supplied.experiences ?? []), item.value] };
    case "trace": return supplied.executionTraces?.some(old => old.exposureId === item.value.exposureId) ? undefined :
      { ...supplied, executionTraces: [...(supplied.executionTraces ?? []), item.value] };
    case "related": return supplied.relatedSources?.some(old => old.versionId === item.value.versionId) ? undefined :
      { ...supplied, relatedSources: [...(supplied.relatedSources ?? []), item.value] };
  }
}

/** Deterministic representatives: recent, earliest, middle, then the remaining
 * history in reverse. This is prompt selection, never a statistical recount. */
function representativeOrder<T>(items: readonly T[]): readonly T[] {
  const positions = new Set([items.length - 1, 0, Math.floor(items.length / 2),
    ...Array.from({ length: items.length }, (_value, index) => items.length - index - 1)]);
  return [...positions].flatMap(index => index < 0 || index >= items.length ? [] : [items[index]!]);
}

function countsOf(request: ExperienceReviewRequest): MaterialCounts {
  return { observations: request.observations.length, counterexamples: request.counterexamples.length,
    compiledObservations: request.reconsideration?.observations.length ?? 0,
    experiences: request.experiences?.length ?? 0, executionTraces: request.executionTraces?.length ?? 0,
    relatedSources: request.relatedSources?.length ?? 0 };
}

function encodeMaterial(supplied: ExperienceReviewRequest, available: MaterialCounts): string {
  const included = countsOf(supplied);
  const omitted: MaterialCounts = { observations: available.observations - included.observations,
    counterexamples: available.counterexamples - included.counterexamples,
    compiledObservations: available.compiledObservations - included.compiledObservations,
    experiences: available.experiences - included.experiences, executionTraces: available.executionTraces - included.executionTraces,
    relatedSources: available.relatedSources - included.relatedSources };
  const value: PackedRequest = { ...supplied, packing: { available, omitted,
    notice: "Omitted detail is unknown, not absent evidence. Counts and snapshot identity remain the full original qualification." } };

  return JSON.stringify(value);
}
