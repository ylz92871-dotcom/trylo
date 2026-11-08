import { isMethodObservation, type MethodObservation } from "./inference.js";
import { isRecord, type MethodExperienceFact } from "./experience-facts.js";
import type { ExperienceSource } from "./experience-state.js";
import { experienceFactError } from "./experience-state.js";
import { canonicalCardJson } from "./contracts.js";
import { validCompilationExposure, type ExperienceExposureBinding } from "./exposure-binding.js";
import { isRepresentativeOpportunity } from "./opportunity-representative.js";
import { feedbackAdoptionOf } from "./feedback-adoption.js";
import { isCentralResearchMethodOrigin } from "./research-origin.js";

/** Structural read boundary: no dependency on Board, provider or persistence implementation. */
export type ExperienceBoardView = {
  readonly sequence: number;
  readonly assets: readonly { readonly versionId: string; readonly content: unknown }[];
  readonly feedbacks: readonly { readonly observation?: MethodObservation; readonly feedbackSequence?: number; readonly exposureId?: string }[];
  readonly methodExperienceFacts?: readonly MethodExperienceFact[];
  readonly fieldings?: readonly { readonly exposureId: string; readonly versionId: string; readonly turnId: string;
    readonly scope: string; readonly useSequence?: number; readonly beat?: number; readonly binding?: ExperienceExposureBinding }[];
};

export function experienceSourceOf(state: ExperienceBoardView): ExperienceSource {
  return { sequence: state.sequence, facts: state.methodExperienceFacts ?? [], ...(state.fieldings === undefined ? {} : { fieldings: state.fieldings }),
    observations: state.feedbacks.flatMap(item => item.observation === undefined ? [] : [item.observation]),
    versions: state.assets.flatMap(asset => {
      const content = asset.content;
      if (typeof content !== "object" || content === null || !("hint" in content) || typeof content.hint !== "string") return [];
      const research = "lineage" in content && isRecord(content.lineage) && isCentralResearchMethodOrigin(content.lineage.createdFrom);
      return [{ versionId: asset.versionId, hint: content.hint, ...(research ? { researchDerived: true as const } : {}) }];
    }) };
}

export function validObservationRevision(previous: readonly MethodObservation[], next: MethodObservation): boolean {
  if (!isMethodObservation(next)) return false;

  const same = previous.filter(item => item.versionId === next.versionId && item.taskId === next.taskId &&
    item.opportunityId === next.opportunityId && item.source === next.source);
  if (same.length === 0) return next.revision === 0 && !previous.some(item => item.observationId === next.observationId);

  const latest = same.reduce((left, right) => left.revision > right.revision ? left : right);
  const sorted = (value: Readonly<Record<string, string>>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

  return next.observationId === latest.observationId && next.revision === latest.revision + 1 &&
    next.sequence === latest.sequence && next.scopeId === latest.scopeId && next.correlationId === latest.correlationId &&
    next.opportunitySequence === latest.opportunitySequence &&
    next.clusterRepresentative === latest.clusterRepresentative &&
    next.compilationId === latest.compilationId &&
    sorted(next.features) === sorted(latest.features);
}

export function validObservationBinding(state: ExperienceBoardView, exposureId: string, observation: MethodObservation): boolean {
  const fielding = state.fieldings?.find(item => item.exposureId === exposureId && item.versionId === observation.versionId &&
    item.turnId === observation.taskId && item.scope === observation.scopeId);
  if (fielding === undefined) return false;

  if (fielding.binding !== undefined && (fielding.useSequence === undefined ||
    !validCompilationExposure(state.methodExperienceFacts ?? [], fielding, fielding.useSequence))) return false;

  if (observation.opportunitySequence !== undefined && observation.opportunitySequence !== fielding.useSequence) return false;

  const binding = fielding.binding;
  if (binding?.compilationId !== observation.compilationId) return false;

  // A provenance-bearing exposure is a new-format write. Do not let a direct
  // command opt into legacy counting by omitting its precommitted identity.
  // Unbound historical rows retain their original replay contract.
  if (binding !== undefined && observation.adoption === "adopted" &&
    (typeof observation.clusterRepresentative !== "boolean" || observation.correlationId !== observation.taskId ||
      observation.opportunitySequence !== fielding.useSequence)) return false;

  if (binding !== undefined && (binding.context.taskId !== observation.taskId ||
    binding.context.opportunityId !== observation.opportunityId ||
    canonicalCardJson(binding.context.features) !== canonicalCardJson(observation.features))) return false;

  const originFieldings = (state.fieldings ?? []).filter(item => item.versionId === observation.versionId && item.turnId === observation.taskId);
  if (originFieldings.some(item => item.useSequence === undefined)) return false;

  const originSequence = Math.min(...originFieldings.map(item => item.useSequence!));
  if (observation.sequence !== originSequence) return false;

  const origin = state.feedbacks.find(row => row.observation?.observationId === observation.observationId && row.observation.source === observation.source);
  const beforeSequence = origin?.feedbackSequence ?? state.sequence + 1;
  const adoption = feedbackAdoptionOf(state.methodExperienceFacts ?? [], observation, beforeSequence);
  if (binding !== undefined && observation.adoption !== adoption) return false;

  const representative = observation.adoption === "adopted" && isRepresentativeOpportunity(state.methodExperienceFacts ?? [], observation, beforeSequence);
  if (observation.clusterRepresentative !== undefined && observation.clusterRepresentative !== representative) return false;

  return observation.adoption !== "adopted" || adoption === "adopted";
}

/** Restore each historical transition using only feedback that existed then.
 * Corrections remain raw rows, so a later revision does not rewrite history. */
export function validExperienceSnapshot(state: ExperienceBoardView): boolean {
  try { return validateHistory(state); }
  catch { return false; } // Terminal fail-closed decoding; the store may replay its authoritative log.
}

function validateHistory(state: ExperienceBoardView): boolean {
  const full = experienceSourceOf(state);

  for (const fielding of state.fieldings ?? []) {
    if (fielding.binding !== undefined && (fielding.useSequence === undefined ||
      !validCompilationExposure(full.facts, fielding, fielding.useSequence))) return false;
  }

  const prior: MethodExperienceFact[] = [];
  const seen: MethodObservation[] = [];

  for (const row of state.feedbacks) {
    if (row.observation !== undefined && (!Number.isSafeInteger(row.feedbackSequence) ||
      row.feedbackSequence === undefined || row.feedbackSequence < 1 || row.feedbackSequence > state.sequence)) return false;
    if (row.observation !== undefined) {
      if (row.exposureId === undefined || !validObservationRevision(seen, row.observation) ||
        !validObservationBinding(state, row.exposureId, row.observation)) return false;
      seen.push(row.observation);
    }
  }

  for (const fact of full.facts) {
    const observations = state.feedbacks.flatMap(row => row.observation !== undefined &&
      row.feedbackSequence !== undefined && row.feedbackSequence < fact.sequence ? [row.observation] : []);
    if (experienceFactError({ ...full, sequence: fact.sequence - 1, facts: prior, observations }, fact) !== undefined) return false;
    prior.push(fact);
  }

  return true;
}
