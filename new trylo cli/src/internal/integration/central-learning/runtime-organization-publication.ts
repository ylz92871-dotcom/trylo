import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { createCentralDeliberationReceiptsAtRoot, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { createCentralOrganizationService, type CentralOrganizationOptions } from "./organization-service.js";
import { publishOrganizationWithCas } from "./organization-cas.js";
import { createOrganizationPublicationResults, type OrganizationPublicationResultEntry } from "./organization-publication-results.js";
import { createOrganizationPublicationProjection } from "./organization-publication-projection.js";

/** Only determined candidate relation failures become public return materials.
 * Native publication, prefix safety and unknown-write semantics stay authoritative. */
export function createRuntimeOrganizationKnowledgePublisher(options: CentralOrganizationOptions,
  service: ReturnType<typeof createCentralOrganizationService>, fail: (reason: string) => never) {
  const results = createOrganizationPublicationResults(options);
  const check = (scope: string, signal: AbortSignal) => {
    if (scope !== options.scope) fail("organization_scope_mismatch");
    if (signal.aborted) fail("organization_cancelled");
    if (!options.enabled()) fail("collect_disabled");
  };

  return async (input: { readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput;
    readonly decisionRef: string; readonly effects?: "record_only"; readonly deliveryRef?: string }, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]> => {
    if (input.effects === "record_only") return [];

    const ready = input.output.intents.flatMap(intent => intent.continuation.kind === "ready" ? [intent.continuation.operation.operationId] : []);
    if (ready.length > 0 && ready.at(-1) !== input.decisionRef) return [];

    const candidates = input.output.organizationKnowledge ?? [];
    if (candidates.length === 0) return [];

    let original: CentralDeliberationDelivery | undefined;
    const verifyOriginal = async () => {
      if (input.deliveryRef === undefined) return fail("organization_publication_delivery_required");

      original ??= await createCentralDeliberationReceiptsAtRoot({ ...options, budgetId: input.request.budgetId })
        .read(input.request.operation.operationId, signal);
      check(input.request.scope, signal);

      if (original === undefined || original.deliveryRef !== input.deliveryRef
        || canonicalJson(original.output.organizationKnowledge ?? []) !== canonicalJson(candidates)) return fail("organization_publication_delivery_mismatch");

      return original;
    };
    const previous = input.deliveryRef === undefined ? undefined
      : await results.read(input.request.operation.operationId, input.request.budgetId, input.deliveryRef, signal);
    if (previous !== undefined) {
      await verifyOriginal();
      const validated = await createOrganizationPublicationProjection(options).readResult(previous.factId, signal);
      if (validated.length !== previous.value.entries.length) return fail("organization_publication_result_corrupt");
      return [];
    }

    const entries: OrganizationPublicationResultEntry[] = [];

    for (const [candidateIndex, knowledge] of candidates.entries()) {
      check(input.request.scope, signal);
      const result = await publishOrganizationWithCas({ record: knowledge, phase: "publication", read: service.read,
        publish: service.proposeKnowledge, enabled: options.enabled, signal });
      check(input.request.scope, signal);

      if (result.status === "saved") continue;

      if (result.status !== "candidate_rejected") return fail(result.status === "rejected" ? result.reason : `organization_${result.status}`);

      await verifyOriginal();
      entries.push({ candidateIndex, knowledgeId: knowledge.knowledgeId, reason: result.reason, verifiedRevision: result.revision,
        currentHeadFactId: result.currentHead?.factId ?? null });
    }

    if (entries.length > 0) {
      const delivery = await verifyOriginal();
      await results.save({ deliveryRef: delivery.deliveryRef, operationId: input.request.operation.operationId,
        budgetId: input.request.budgetId, entries }, signal);
    }

    // Publication outcomes have their own bounded original-Board receipt. Even
    // a pointer must not consume capacity in an already-full valid agenda.
    return [];
  };
}
