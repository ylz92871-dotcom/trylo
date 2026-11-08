import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { centralDeliveredSourceRefs } from "./deliberation-context.js";
import { ORGANIZATION_PUBLICATION_CONDITION_PREFIX, readOrganizationPublicationCondition } from "./organization-publication-material.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { readOrganizationCandidateView, readOrganizationKnowledgeView } from "./organization-publication-view.js";

export const isPublicationConditionRef = (ref: string): boolean => ref.startsWith(ORGANIZATION_PUBLICATION_CONDITION_PREFIX);

/** Only the complete, canonical finite refusal message consumes its one repair
 * opportunity. A navigation address or a proposal body is not that message. */
export function deliveredPublicationConditions(request: CentralDeliberationRequest): readonly CentralRuntimeMaterial[] {
  return [...request.materials, ...request.organization].filter(material =>
    readOrganizationPublicationCondition(material, request.scope) !== undefined);
}

export function deliveredSourcesWithPublicationConditions(request: CentralDeliberationRequest): readonly string[] {
  return [...new Set([...centralDeliveredSourceRefs(request).filter(ref => !isPublicationConditionRef(ref)),
    ...deliveredPublicationConditions(request).map(material => material.ref)])];
}

/** Confirm one original result's exact live purpose. The original Board reader
 * owns receipt lookup; broad subject collections cannot manufacture ownership. */
export function publicationCorrectionFor(state: CentralLearningRuntimeState, materials: readonly CentralRuntimeMaterial[],
  consumedSourceRefs: readonly string[]): {
    readonly materials: readonly CentralRuntimeMaterial[]; readonly purposes: readonly CentralLearningIntentDraft[];
  } | undefined {
  const active = state.intents.filter(intent => intent.continuation.kind !== "ended");
  if (active.length === 0) return undefined;

  const details = [...materials].reverse().map(material => ({ material, value: readOrganizationPublicationRejection(material, state.scope) }));

  for (const condition of materials) {
    if (consumedSourceRefs.includes(condition.ref) || readOrganizationPublicationCondition(condition, state.scope) === undefined) continue;

    const detail = details.find(row => row.value?.conditionRef === condition.ref && row.value.bindings.state === "bound"
      && active.some(intent => row.value!.bindings.intentIds.includes(intent.intentId)));
    if (detail?.value === undefined || detail.value.bindings.state !== "bound") continue;

    const binding = detail.value.bindings;
    // Exact original intent identities are the only automatic ownership route.
    // Broad subject/agenda issue collections cannot expand a proven binding.
    const purposes = active.filter(intent => binding.intentIds.includes(intent.intentId));
    if (purposes.length === 0) continue;

    const value = detail.value;
    const linked = materials.filter(material => {
      const head = readOrganizationKnowledgeView(material, state.scope), candidate = readOrganizationCandidateView(material, state.scope);
      return head?.factId === value.currentHead?.factId && head !== undefined
        || candidate?.deliveryRef === value.deliveryRef && candidate.index === value.candidateIndex
        || value.evidenceReadRefs.includes(material.ref);
    });

    return { materials: [condition, detail.material, ...linked], purposes };
  }

  return undefined;
}
