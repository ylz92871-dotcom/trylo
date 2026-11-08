import type { CentralDeliberationRequest, CentralLearningSubject } from "../../learning/central/runtime/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { OrganizationPublicationPurposeEvidence } from "./organization-service.js";

export interface OrganizationPublicationBindings {
  readonly state: "bound" | "unbound";
  readonly intentIds: readonly string[];
  readonly subjects: readonly CentralLearningSubject[];
}

/** Bind only cited original feedback's frozen coordinates to the request's
 * already known purposes. A new output or a shared agenda is not such proof. */
export function resolveOrganizationPublicationBindings(request: CentralDeliberationRequest,
  purposeEvidence: readonly OrganizationPublicationPurposeEvidence[]): OrganizationPublicationBindings {
  const intents = new Map(request.state.intents.filter(intent => intent.intentId !== "central:agenda")
    .map(intent => [intent.intentId, intent]));
  const knownIntentIds = new Set(intents.keys()), operationOwners = new Map<string, Set<string>>();
  const recordOperation = (operationId: string, intentId: string) => {
    if (intentId === "central:agenda") return;
    knownIntentIds.add(intentId);
    const owners = operationOwners.get(operationId) ?? new Set<string>();
    owners.add(intentId);
    operationOwners.set(operationId, owners);
  };

  for (const row of [...request.state.completed, ...request.state.running]) recordOperation(row.operation.operationId, row.intentId);

  const actualOperation = canonicalJson(request.operation);

  for (const intent of intents.values()) if (intent.continuation.kind === "ready"
    && canonicalJson(intent.continuation.operation) === actualOperation) recordOperation(request.operation.operationId, intent.intentId);

  const bound = new Set<string>();

  for (const evidence of purposeEvidence) {
    if (knownIntentIds.has(evidence.purposeRef)) bound.add(evidence.purposeRef);
    for (const ref of [evidence.purposeRef, evidence.decisionRef]) {
      const owners = operationOwners.get(ref);
      // Contradictory ownership does not justify choosing or broadcasting owners.
      if (owners?.size === 1) for (const intentId of owners) bound.add(intentId);
    }
  }

  // Agenda issueRefs can name every output purpose. They are audit coordinates,
  // not native-unit proof; neither they nor a bound intent widen the wake subject.
  return { state: bound.size === 0 ? "unbound" : "bound", intentIds: [...bound].sort(),
    subjects: [] };
}
