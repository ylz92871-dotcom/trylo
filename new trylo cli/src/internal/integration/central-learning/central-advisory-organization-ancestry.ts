import type { BoardState } from "../../learning/control/state.js";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { OrganizationProjection, OrganizationRecallPacket, OrganizationStored } from "../../learning/central/organization/contracts.js";
import { ORGANIZATION_ALGORITHM, buildOrganizationRecord, readOrganizationRecords } from "../../learning/central/organization/records.js";
import { retrieveOrganizationExperience, retrieveOrganizationExperienceV1, retrieveLegacyOrganizationExperience } from "../../learning/central/organization/retrieval.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { centralInputMaterials } from "./deliberation-input-sources.js";
import { createOriginalOrganizationDecisionMaterial } from "./organization-decision-material.js";
import { readAppliedCentralDecisions } from "./central-advisory-applied-decisions.js";
import { readCentralDeliberationDeliveriesFromFacts } from "./deliberation-receipts.js";
import { deliveredOrganizationRecallPacket, organizationRecallNavigationMaterial } from "./runtime-organization-memory.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { readOrganizationEvidenceMaterial } from "./organization-evidence-material.js";
import { createOrganizationCandidateView, createOrganizationKnowledgeView, readOrganizationCandidateView,
  readOrganizationKnowledgeRevisionLocator, readOrganizationKnowledgeView, readOrganizationPublicationFragment } from "./organization-publication-view.js";
import { organizationDecisionForOperation } from "./organization-feedback-runtime.js";
import { createOrganizationPublicationFactsProjection } from "./organization-publication-projection.js";
import { readOrganizationPublicationCondition } from "./organization-publication-material.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { fields, identity } from "../../validation/json-shape.js";
import { organizationFeedbackViews } from "./organization-feedback-views.js";

export interface CentralAdvisoryOrganizationInput {
  readonly controlRefs: ReadonlySet<string>;
  /** Only directories/query contracts; their advertised unread refs are not bodies. */
  readonly navigationRefs: ReadonlySet<string>;
  readonly materialEdges: ReadonlyMap<string, readonly string[]>;
}

export type CentralAdvisoryOrganizationRecord = { readonly status: "missing" }
  | { readonly status: "found"; readonly controlRefs: readonly string[]; readonly sourceRefs: readonly string[];
      readonly authorDeliveryRefs: readonly string[]; readonly authorUnavailable: boolean };

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const unique = (refs: readonly string[]) => [...new Set(refs)];

/** Native organization decoders remain the only record/recall/result owners.
 * This ephemeral join classifies exact wrappers and exposes their real parent
 * edges; it does not decide destination access or turn a hypothesis into evidence. */
export function createCentralAdvisoryOrganizationAncestry(board: BoardState, scope: string) {
  const facts = board.rewardV2Facts ?? [], byId = new Map(facts.map(fact => [fact.id, fact]));
  const views = new Map<number, OrganizationProjection>();
  const decisions = readAppliedCentralDecisions(facts, scope, board.sequence);
  const knowledgeAuthors = new Map<string, typeof decisions[number][]>();

  for (const decision of decisions) for (const knowledge of decision.output.organizationKnowledge ?? []) {
    const ref = buildOrganizationRecord(scope, knowledge).id, rows = knowledgeAuthors.get(ref) ?? [];
    rows.push(decision);
    knowledgeAuthors.set(ref, rows);
  }

  function view(sequence: number): OrganizationProjection {
    let result = views.get(sequence);
    if (result === undefined) {
      result = readOrganizationRecords(facts.filter(fact => fact.sequence <= sequence), scope, sequence);
      views.set(sequence, result);
    }
    return result;
  }

  function stored(ref: string, through: number): OrganizationStored | undefined {
    const fact = byId.get(ref);
    if (fact === undefined || fact.scope !== scope || fact.algorithmVersion !== ORGANIZATION_ALGORITHM || fact.sequence > through) return undefined;
    const original = view(fact.sequence);
    return [...original.decisions, ...original.feedbackHistory, ...original.knowledge].find(row => row.factId === ref);
  }

  function packetOriginal(packet: OrganizationRecallPacket, through: number): boolean {
    const retrieve = packet.schemaVersion === 2 ? retrieveOrganizationExperience
      : packet.navigation === undefined ? retrieveLegacyOrganizationExperience : retrieveOrganizationExperienceV1;
    const cuts = unique([String(through), ...facts.filter(fact => fact.scope === scope
      && fact.algorithmVersion === ORGANIZATION_ALGORITHM && fact.sequence <= through).map(fact => String(fact.sequence)), "0"])
      .map(Number).sort((left, right) => right - left);
    return cuts.some(sequence => same(retrieve(view(sequence), packet.query), packet));
  }

  const inputs = new WeakMap<CentralDeliberationRequest, CentralAdvisoryOrganizationInput>();

  function isOriginalDecisionMaterial(material: CentralRuntimeMaterial, through: number): boolean {
    const original = stored(material.ref, through);
    return original?.value.kind === "decision" && same(material,
      createOriginalOrganizationDecisionMaterial({ ...original, value: original.value }));
  }

  function input(request: CentralDeliberationRequest): CentralAdvisoryOrganizationInput {
    const cached = inputs.get(request);
    if (cached !== undefined) return cached;

    const materials = centralInputMaterials(request), controlRefs = new Set<string>(), navigationRefs = new Set<string>();
    const materialEdges = new Map<string, readonly string[]>(), through = request.boardSequence;
    const bind = (material: CentralRuntimeMaterial, refs: readonly string[]) => {
      controlRefs.add(material.ref);
      materialEdges.set(material.ref, unique(refs));
    };
    const native = organizationRecallNavigationMaterial();

    for (const material of materials) {
      if (same(material, native)) {
        controlRefs.add(material.ref);
        navigationRefs.add(material.ref);
        continue;
      }

      if (material.kind === "organization" && material.ref.startsWith("organization-feedback-relations:")) {
        let body: unknown;
        try { body = JSON.parse(material.text); } catch { body = undefined; }

        if (fields(body, ["role", "unitRef", "resultKind", "representativeFactId", "entries", "interpretation"])
          && body.role === "organization_feedback_relationship_catalog_not_read_body"
          && material.text === canonicalJson(body) && material.ref === `organization-feedback-relations:${contentHashOf(material.text)}`
          && Array.isArray(body.entries) && body.entries.length > 0 && body.entries.length <= 16) {
          const representative = stored(String(body.representativeFactId), through);
          if (representative?.value.kind === "feedback" && representative.value.unitRef === body.unitRef
            && representative.value.result.kind === body.resultKind) {
            const example = organizationFeedbackViews(scope, [{ row: { ...representative, value: representative.value }, relation: "related_background" }])
              .find(row => row.ref.startsWith("organization-feedback-relations:"));
            const interpretation = example === undefined ? undefined : JSON.parse(example.text).interpretation;
            const valid = body.interpretation === interpretation && body.entries.every(entry => {
              if (!fields(entry, ["decisionRef", "relation", "factId", "readRef"]) || !identity(entry.factId)
                || entry.readRef !== entry.factId || !["produced_by", "selected_by", "related_background"].includes(String(entry.relation))) return false;
              const row = stored(entry.factId, through);
              return row?.value.kind === "feedback" && row.value.decisionRef === entry.decisionRef
                && row.value.unitRef === body.unitRef && row.value.result.kind === body.resultKind;
            });
            if (valid && same(material.sourceRefs, unique(body.entries.map(entry => String(entry.factId))))) {
              controlRefs.add(material.ref);
              navigationRefs.add(material.ref);
              continue;
            }
          }
        }
      }

      const packet = deliveredOrganizationRecallPacket(material, scope, materials);
      if (packet !== undefined && packetOriginal(packet, through)
        && same(material.sourceRefs, unique([packet.recallRef, ...packet.entries.map(entry => entry.factId)]))) {
        bind(material, packet.entries.flatMap(entry => [entry.factId, ...entry.evidence.map(row => row.factId)]));
        const text = canonicalJson({ role: "organization_retrieval_context_not_business_evidence", query: packet.query, recallRef: packet.recallRef });
        for (const query of materials) if (query.kind === "organization" && query.ref === `organization-query:${contentHashOf(text)}`
          && query.text === text && (same(query.sourceRefs, []) || same(query.sourceRefs, packet.query.sourceRefs))) {
          controlRefs.add(query.ref);
          navigationRefs.add(query.ref);
        }
      }

      const feedback = readOrganizationFeedbackMaterial(material, scope), knowledge = readOrganizationKnowledgeView(material, scope);
      const original = stored(feedback?.factId ?? knowledge?.factId ?? material.ref, through);
      if (original?.value.kind === "decision" && isOriginalDecisionMaterial(material, through)) bind(material, [original.factId]);

      if (feedback !== undefined && original?.value.kind === "feedback" && same(original.value, feedback.value)) bind(material, [original.factId]);

      if (knowledge !== undefined && original?.value.kind === "knowledge" && same(original.value, knowledge.value)) bind(material, [original.factId]);

      if (original?.value.kind === "feedback" && material.ref === original.factId && material.kind === "organization") {
        let value: unknown;
        try { value = JSON.parse(material.text); } catch { value = undefined; }
        if (same(value ?? null, original.value) || same(value ?? null, { role: "source_bound_organization_feedback_not_identified_economic_gain",
          factId: original.factId, sequence: original.sequence, value: original.value })) bind(material, [original.factId]);
      }

      const page = readOrganizationEvidenceMaterial(material, scope);
      if (page !== undefined && stored(page.knowledgeFactId, through)?.value.kind === "knowledge"
        && page.items.every(row => same(stored(row.factId, through)?.value ?? null, row.value))) {
        bind(material, [page.knowledgeFactId, ...page.items.map(row => row.factId)]);
      }

      const candidate = readOrganizationCandidateView(material, scope);
      if (candidate !== undefined && byId.get(candidate.deliveryRef)?.scope === scope
        && (byId.get(candidate.deliveryRef)?.sequence ?? Infinity) <= through) {
        const delivery = readCentralDeliberationDeliveriesFromFacts(facts, scope, board.sequence, [candidate.deliveryRef])[0];
        if (delivery !== undefined && same(delivery.output.organizationKnowledge?.[candidate.index] ?? null, candidate.value)) {
          bind(material, [candidate.deliveryRef, ...candidate.value.supportFactIds, ...candidate.value.counterexampleFactIds]);
        }
      }

      const fragment = readOrganizationPublicationFragment(material, scope);
      if (fragment !== undefined) {
        const owner = stored(material.sourceRefs[0]!, through);
        const originals: CentralRuntimeMaterial[] = [];

        if (owner?.value.kind === "knowledge") originals.push(createOrganizationKnowledgeView(scope, { ...owner, value: owner.value }));

        const deliveryRef = material.sourceRefs[0]!;
        if (byId.get(deliveryRef)?.scope === scope && (byId.get(deliveryRef)?.sequence ?? Infinity) <= through
          && byId.get(deliveryRef)?.algorithmVersion === "central-deliberation-delivery-v1") {
          const delivery = readCentralDeliberationDeliveriesFromFacts(facts, scope, board.sequence, [deliveryRef])[0];
          for (const [index, value] of (delivery?.output.organizationKnowledge ?? []).entries()) originals.push(createOrganizationCandidateView(scope, deliveryRef, index, value));
        }

        if (originals.some(body => body.ref === fragment.originalRef && contentHashOf(body.text) === fragment.sourceHash
          && body.text.length === fragment.totalChars && body.text.slice(fragment.start, fragment.end) === fragment.text)) bind(material, material.sourceRefs);
      }
    }

    for (const material of materials) {
      const locator = readOrganizationKnowledgeRevisionLocator(material, scope, materials);
      const original = locator === undefined ? undefined : stored(locator.factId, through);
      if (original?.value.kind === "knowledge" && original.value.knowledgeId === locator?.knowledgeId) bind(material, [original.factId]);
    }

    const resultMaterials = materials.filter(material => readOrganizationPublicationCondition(material, scope) !== undefined
      || readOrganizationPublicationRejection(material, scope) !== undefined || material.ref.startsWith("organization-publication-evidence:"));
    if (resultMaterials.length > 0) {
      const projection = createOrganizationPublicationFactsProjection({ facts: facts.filter(fact => fact.sequence <= through), scope, boardSequence: through });
      for (const row of projection.stored) for (const entry of row.value.entries) {
        const projected = projection.read(row.factId, entry.candidateIndex);
        if (projected === undefined) continue;
        for (const expected of [projected.condition, projected.detail, ...projected.evidence]) {
          const actual = resultMaterials.find(material => same(material, expected));
          if (actual !== undefined) {
            bind(actual, [row.value.deliveryRef]);
            controlRefs.add(row.factId);
          }
        }
      }
    }

    const result = { controlRefs, navigationRefs, materialEdges };
    inputs.set(request, result);
    return result;
  }

  function record(ref: string, through: number): CentralAdvisoryOrganizationRecord {
    const original = stored(ref, through) ?? view(through).decisions.find(row => row.value.decisionRef === ref);
    if (original === undefined) return { status: "missing" };

    const value = original.value, sourceRefs: string[] = [], controlRefs = [ref, original.factId], authorDeliveryRefs: string[] = [];
    let authorUnavailable = false;

    if (value.kind === "knowledge") {
      sourceRefs.push(...value.supportFactIds, ...value.counterexampleFactIds, ...(value.supersedes === null ? [] : [value.supersedes]));
      for (const author of knowledgeAuthors.get(original.factId) ?? []) {
        if (author.appliedSequence <= through && (byId.get(author.deliveryRef)?.sequence ?? Infinity) < original.sequence) authorDeliveryRefs.push(author.deliveryRef);
      }
      authorUnavailable = authorDeliveryRefs.length === 0;
    } else if (value.kind === "feedback") {
      sourceRefs.push(value.decisionRef, value.unitRef, ...value.sourceRefs, ...(value.supersedes === null ? [] : [value.supersedes]));
      if (value.result.kind === "progress") sourceRefs.push(...value.result.resultRefs);
      if (value.result.kind === "adoption") sourceRefs.push(...value.result.artifactRefs, ...(value.result.exposureRef === null ? [] : [value.result.exposureRef]));
      if (value.result.kind === "outcome" && value.result.exposureRef !== null) sourceRefs.push(value.result.exposureRef);
    } else {
      controlRefs.push(value.decisionRef);
      sourceRefs.push(value.purposeRef, ...value.sourceRefs);
      if (value.experienceUse !== null) sourceRefs.push(value.experienceUse.deliveryRef,
        ...value.experienceUse.packet.entries.flatMap(entry => [entry.factId, ...entry.evidence.map(row => row.factId)]));
      for (const author of decisions) if (author.appliedSequence <= through && organizationDecisionForOperation(scope, value, author.request.operation.operationId)) {
        authorDeliveryRefs.push(author.deliveryRef);
      }
    }

    return { status: "found", controlRefs: unique(controlRefs), sourceRefs: unique(sourceRefs),
      authorDeliveryRefs: unique(authorDeliveryRefs), authorUnavailable };
  }

  return { input, record, isOriginalDecisionMaterial };
}
