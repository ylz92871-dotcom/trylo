import type { BoardState } from "../../learning/control/state.js";
import type { CentralCompletedOperation, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { readCentralRuntimePrefix, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { deliveredArchivedIntents, identifyDeliveredArchivedIntentClaims } from "../../learning/central/runtime/archived-intents.js";
import { readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { isCentralAgentResearchCapabilityMaterial } from "../../learning/central/runtime/material-role.js";
import { centralInputMaterials } from "./deliberation-input-sources.js";
import { centralBusinessSourceDirectory } from "./deliberation-business-sources.js";
import { createActivePurposeNavigation, createActivePurposeOriginal, parseActivePurposeReadRef, readActivePurposeDelivery } from "./active-purpose-delivery.js";
import { createCentralDeliberationDeliveryReader, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { centralResearchSourcePage } from "./research-intake-episode-sources.js";
import { readRuntimePublicSourceFrame } from "./runtime-source-frames.js";
import { isUserPeerStatusNavigation } from "../user-learning/central-status-navigation.js";
import { isCentralRuntimeEnvironmentCondition } from "./runtime-environment-condition.js";
import { readAppliedCentralDecisions, type AppliedCentralAdvisoryDecision } from "./central-advisory-applied-decisions.js";
import { centralAdvisoryKnowledgeHash, readCentralAdvisory, readCentralAdvisoryRecords } from "./central-advisory-records.js";
import { createCentralJudgmentProvenanceReader } from "./runtime-judgment-provenance.js";
import { centralAdvisoryPublicationMaterial, isOriginalCentralAdvisoryContextMaterial } from "./central-advisory-material.js";
import { createCentralAdvisoryOrganizationAncestry } from "./central-advisory-organization-ancestry.js";
import { readCentralAdvisoryPublicationSource } from "./central-advisory-source-binding.js";
import { createCentralAdvisoryRuntimeControls } from "./central-advisory-runtime-controls.js";
import { readCentralAdvisoryTransportControl } from "./central-advisory-transport-controls.js";
import { readCentralMaterialPageRef } from "./deliberation-material.js";

/** A representation bound, never permission to discard an unresolved source. */
export const CENTRAL_ADVISORY_ACCESS_SOURCE_CAPACITY = 4096;

export type CentralAdvisorySourceFailureReason = "central_advisory_source_delivery_unconfirmed"
  | "central_advisory_source_author_unavailable" | "central_advisory_source_capacity"
  | "central_advisory_source_scope" | "central_advisory_access_source_binding_invalid";

/** A definite eligibility/capacity refusal, distinct from corrupt original
 * Board/receipt failures, which retain their original native exceptions. */
export class CentralAdvisorySourceError extends Error {
  constructor(readonly reason: CentralAdvisorySourceFailureReason) {
    super(reason);
    this.name = "CentralAdvisorySourceError";
  }
}

export function readCentralAdvisorySourceFailure(error: unknown): { readonly reason: CentralAdvisorySourceFailureReason } | undefined {
  return error instanceof CentralAdvisorySourceError ? { reason: error.reason } : undefined;
}

export interface CentralAdvisoryAccessSourceInput {
  readonly intent: CentralLearningIntentDraft;
  readonly knowledge: CentralLearningIntentDraft["knowledge"][number];
  readonly delivery: CentralDeliberationDelivery;
}

export interface CentralAdvisoryAccessSourceInventory {
  readonly sourceRefs: readonly string[];
  /** Exact original bookkeeping/transport identities only. Their business
   * descendants remain in sourceRefs and need the destination's access gate. */
  readonly controlRefs: readonly string[];
}

const verifiedInventories = new WeakMap<BoardState, Map<string, CentralAdvisoryAccessSourceInventory>>();

interface SourceContext {
  readonly deliveryRef: string;
  readonly request: CentralDeliberationRequest;
  readonly materials: ReadonlyMap<string, CentralRuntimeMaterial>;
  readonly intents: ReadonlyMap<string, CentralLearningIntentDraft>;
  readonly completed: ReadonlyMap<string, CentralCompletedOperation>;
  readonly purposeControls: ReadonlySet<string>;
  readonly organizationRequest: CentralDeliberationRequest;
}

const fail = (reason: CentralAdvisorySourceFailureReason): never => { throw new CentralAdvisorySourceError(reason); };
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** Pure provenance closure over the original Board and returned authoring
 * request. This does not select content, authenticate a PA/session, or permit
 * publication. Unknown leaves survive for the original destination gate. */
export function collectCentralAdvisoryAccessSourceRefs(board: BoardState, scope: string,
  input: CentralAdvisoryAccessSourceInput): readonly string[] {
  return collectCentralAdvisoryAccessSourceInventory(board, scope, input).sourceRefs;
}

export function collectCentralAdvisoryAccessSourceInventory(board: BoardState, scope: string,
  input: CentralAdvisoryAccessSourceInput): CentralAdvisoryAccessSourceInventory {
  // The publisher and its access gate inspect the same snapshot synchronously.
  // Reuse that exact proof; hash all original bytes so even an in-place caller
  // mutation cannot turn a prior result into authority for changed input.
  const key = contentHashOf({ board, scope, input });
  const cached = verifiedInventories.get(board)?.get(key);
  if (cached !== undefined) return cached;

  const result = collectSourceClosure(board, scope, input, new Set());
  const frozen = Object.freeze({ sourceRefs: Object.freeze([...result.sourceRefs]), controlRefs: Object.freeze([...result.controlRefs]) });
  const entries = verifiedInventories.get(board) ?? new Map<string, CentralAdvisoryAccessSourceInventory>();

  entries.set(key, frozen);
  verifiedInventories.set(board, entries);
  return frozen;
}

function collectSourceClosure(board: BoardState, scope: string, input: CentralAdvisoryAccessSourceInput,
  visitingPublications: ReadonlySet<string>): CentralAdvisoryAccessSourceInventory {
  const facts = board.rewardV2Facts ?? [];
  const readDeliveries = createCentralDeliberationDeliveryReader(facts, scope, board.sequence);
  // One synchronous closure has one original prefix. Author, organization and
  // control edges can reach the same receipt many times; retain its verified
  // reconstruction here rather than revalidating the lifetime ledger per edge.
  // A later snapshot or an in-place caller mutation starts a new closure.
  const deliveries = new Map<string, CentralDeliberationDelivery | undefined>();

  function deliveryAt(ref: string): CentralDeliberationDelivery | undefined {
    if (!deliveries.has(ref)) {
      deliveries.set(ref, readDeliveries([ref])[0]);
    }
    return deliveries.get(ref);
  }

  const original = deliveryAt(input.delivery.deliveryRef);
  if (original === undefined || !same(original, input.delivery)) return fail("central_advisory_source_delivery_unconfirmed");

  const histories = new Map<number, ReturnType<typeof readCentralRuntimeRecords>["history"]>();

  function historyAt(sequence: number) {
    let history = histories.get(sequence);
    if (history === undefined) {
      history = readCentralRuntimeRecords(facts.filter(fact => fact.sequence <= sequence), scope, sequence).history;
      histories.set(sequence, history);
    }
    return history;
  }

  function archivesAt(request: CentralDeliberationRequest) {
    // A request with no complete archived-body claims needs no historical head
    // lookup. Actual claims still pass the original as-of writer verification.
    if (identifyDeliveredArchivedIntentClaims(request).size === 0) return new Map<string, CentralLearningIntentDraft>();
    return deliveredArchivedIntents(request, historyAt(request.boardSequence));
  }

  const directlySelected = [...original.output.intents, ...original.request.state.intents].some(intent => same(intent, input.intent));
  const archived = directlySelected ? undefined : archivesAt(original.request).get(input.intent.intentId);
  const selected = directlySelected || archived !== undefined && same(archived, input.intent);
  if (!selected || !input.intent.knowledge.some(knowledge => same(knowledge, input.knowledge))) {
    return fail("central_advisory_source_delivery_unconfirmed");
  }

  const prefix = readCentralRuntimePrefix(facts, scope, board.sequence);
  const runtimeControls = createCentralAdvisoryRuntimeControls(board, scope, prefix);
  const runtimeFactRefs = new Set(prefix.map(snapshot => snapshot.factRef));
  const factByRef = new Map(facts.map(fact => [fact.id, fact]));
  const boardPrefixes = new Map<number, BoardState>();

  function boardAt(sequence: number): BoardState {
    let prefix = boardPrefixes.get(sequence);
    if (prefix === undefined) {
      prefix = { ...board, sequence, rewardV2Facts: facts.filter(fact => fact.sequence <= sequence) };
      boardPrefixes.set(sequence, prefix);
    }
    return prefix;
  }

  const judgmentOrigin = createCentralJudgmentProvenanceReader({ facts, scope, boardSequence: board.sequence });
  const organization = createCentralAdvisoryOrganizationAncestry(board, scope);
  const publications = readCentralAdvisoryRecords(facts, scope, board.sequence).filter(row => row.value.kind === "publish");
  const publicationClosures = new Map<string, CentralAdvisoryAccessSourceInventory>();
  const authors = new Map<string, AppliedCentralAdvisoryDecision[]>();
  const knowledgeKey = (intentId: string, knowledge: CentralLearningIntentDraft["knowledge"][number]) =>
    canonicalJson([intentId, centralAdvisoryKnowledgeHash(knowledge)]);

  for (const decision of readAppliedCentralDecisions(facts, scope, board.sequence)) {
    let archives: ReadonlyMap<string, CentralLearningIntentDraft> | undefined;
    for (const intent of decision.output.intents) {
      const previous = decision.request.state.intents.find(row => row.intentId === intent.intentId)
        ?? (archives ??= archivesAt(decision.request)).get(intent.intentId);
      for (const knowledge of intent.knowledge) {
        const key = knowledgeKey(intent.intentId, knowledge);
        if (previous?.knowledge.some(entry => knowledgeKey(intent.intentId, entry) === key)) continue;
        const rows = authors.get(key) ?? [];
        rows.push(decision);
        authors.set(key, rows);
      }
    }
  }

  const sources = new Set<string>(), controls = new Set<string>();
  const contexts = new Map<string, SourceContext>(), seen = new Set<string>();
  const pending: { readonly ref: string; readonly context: SourceContext }[] = [];

  function add(ref: string, context: SourceContext): void {
    if (!sources.has(ref) && sources.size >= CENTRAL_ADVISORY_ACCESS_SOURCE_CAPACITY) {
      fail("central_advisory_source_capacity");
    }

    sources.add(ref);
    const key = canonicalJson([context.request.operation.operationId, context.request.boardSequence, ref]);
    if (seen.has(key)) return;

    if (seen.size >= CENTRAL_ADVISORY_ACCESS_SOURCE_CAPACITY * 4) fail("central_advisory_source_capacity");

    seen.add(key);
    pending.push({ ref, context });
  }

  function control(ref: string, context: SourceContext): void {
    controls.add(ref);
    add(ref, context);
  }

  const checkedAuthors = new Set<string>();

  function requireAuthor(intent: CentralLearningIntentDraft, knowledge: CentralLearningIntentDraft["knowledge"][number], context: SourceContext): void {
    const key = knowledgeKey(intent.intentId, knowledge), check = canonicalJson([key, context.deliveryRef]);
    if (checkedAuthors.has(check)) return;

    const candidates = (authors.get(key) ?? []).filter(row => row.appliedSequence <= context.request.boardSequence || row.deliveryRef === context.deliveryRef);
    if (candidates.length === 0) fail("central_advisory_source_author_unavailable");

    checkedAuthors.add(check);

    for (const author of candidates) {
      const receipt = deliveryAt(author.deliveryRef);
      if (receipt === undefined) return fail("central_advisory_source_author_unavailable");
      contextFor(receipt);
    }
  }

  function intentSources(intent: CentralLearningIntentDraft, context: SourceContext, completeBody = true): void {
    for (const ref of intent.sourceRefs) add(ref, context);

    if (completeBody) for (const knowledge of intent.knowledge) {
      for (const ref of knowledge.sourceRefs) add(ref, context);
      requireAuthor(intent, knowledge, context);
    }

    for (const ref of intent.derivation?.parentRefs ?? []) add(ref, context);

    for (const citation of intent.derivation?.citations ?? []) add(citation.evidenceRef, context);
  }

  function contextFor(delivery: CentralDeliberationDelivery): SourceContext {
    const existing = contexts.get(delivery.deliveryRef);
    if (existing !== undefined) return existing;

    const request = delivery.request, materials = new Map<string, CentralRuntimeMaterial>();
    const intents = new Map<string, CentralLearningIntentDraft>(), completed = new Map<string, CentralCompletedOperation>();

    // A later Board head cannot replace the bytes available to this author.
    for (const snapshot of prefix) {
      if ((factByRef.get(snapshot.factRef)?.sequence ?? Infinity) > request.boardSequence) continue;
      const state = snapshot.state;
      for (const material of state.materials) materials.set(material.ref, material);
      for (const intent of state.intents) intents.set(intent.intentId, intent);
      for (const result of state.completed) completed.set(result.operation.operationId, result);
    }

    for (const material of centralInputMaterials(request)) materials.set(material.ref, material);

    for (const intent of request.state.intents) intents.set(intent.intentId, intent);

    for (const result of request.state.completed) completed.set(result.operation.operationId, result);

    const deliveredArchives = archivesAt(request), purposeControls = new Set<string>();

    for (const [id, claim] of identifyDeliveredArchivedIntentClaims(request)) {
      const verified = deliveredArchives.get(id);
      if (verified !== undefined && same(verified, claim.intent)) purposeControls.add(claim.materialRef);
    }

    for (const intent of request.state.intents) {
      const body = createActivePurposeOriginal(scope, intent);
      const material = materials.get(body.ref);
      if (material !== undefined && same(material, body)) purposeControls.add(material.ref);
    }

    // Native reconstruction may authenticate a historical wrapper which was
    // retained in working memory but omitted from this later wire delivery.
    // This view is not a delivered request and creates no citation authority.
    const organizationRequest = { ...request, materials: [...materials.values()], organization: [],
      state: { ...request.state, materials: [] } };
    const context = { deliveryRef: delivery.deliveryRef, request, materials, intents, completed, purposeControls, organizationRequest };
    contexts.set(delivery.deliveryRef, context);
    control(delivery.deliveryRef, context);
    control(request.stateRef, context);
    control(request.operation.operationId, context);

    for (const ref of request.operation.sourceRefs) add(ref, context);

    for (const ref of delivery.output.sourceRefs) add(ref, context);

    // These are the original returned request's actual material bodies, not
    // merely supports retained by the model in its selected knowledge entry.
    for (const material of centralInputMaterials(request)) add(material.ref, context);

    for (const intent of [...readActivePurposeDelivery(request).visibleIntents, ...deliveredArchives.values()]) intentSources(intent, context);

    return context;
  }

  function navigation(material: CentralRuntimeMaterial, context: SourceContext): boolean {
    if (organization.input(context.organizationRequest).navigationRefs.has(material.ref)) return true;

    // These roles are controls only after exact reconstruction from their
    // original Board prefix. A self-labelled/correctly hashed envelope is not enough.
    if (isOriginalCentralAdvisoryContextMaterial(boardAt(context.request.boardSequence), scope, material)) return true;

    if (isCentralAgentResearchCapabilityMaterial(material) || isUserPeerStatusNavigation(material)
      || isCentralRuntimeEnvironmentCondition(material)
      || centralBusinessSourceDirectory(material) !== undefined) return true;

    const address = parseActivePurposeReadRef(material.ref);

    return address?.kind === "catalog" && same(material,
      createActivePurposeNavigation(scope, context.request.state.intents, address.offset, address.pageSize));
  }

  const initial = contextFor(original);

  for (const ref of input.knowledge.sourceRefs) add(ref, initial);

  intentSources(input.intent, initial, false);
  requireAuthor(input.intent, input.knowledge, initial);

  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]!;
    const material = item.context.materials.get(item.ref);
    const sourceBoard = boardAt(item.context.request.boardSequence);
    let publication = publications.find(row => row.ref === item.ref && row.sequence <= sourceBoard.sequence);
    if (material !== undefined && publication === undefined) for (const candidate of publications) {
      if (candidate.sequence > sourceBoard.sequence || !material.sourceRefs.includes(candidate.ref) || candidate.value.kind !== "publish") continue;
      const view = readCentralAdvisory(sourceBoard, scope, { ref: candidate.value.advisoryId, version: candidate.ref });
      if (view !== undefined && same(material, centralAdvisoryPublicationMaterial(scope, view))) {
        publication = candidate;
        break;
      }
    }

    if (publication !== undefined) {
      if (material !== undefined) {
        if (publication.value.kind !== "publish") return fail("central_advisory_access_source_binding_invalid");
        const view = readCentralAdvisory(sourceBoard, scope, { ref: publication.value.advisoryId, version: publication.ref });
        if (view === undefined || !same(material, centralAdvisoryPublicationMaterial(scope, view))) return fail("central_advisory_access_source_binding_invalid");
      }

      let closure = publicationClosures.get(publication.ref);
      if (closure === undefined) {
        if (visitingPublications.has(publication.ref)) return fail("central_advisory_access_source_binding_invalid");

        if (visitingPublications.size >= 64) return fail("central_advisory_source_capacity");

        const source = readCentralAdvisoryPublicationSource(sourceBoard, scope, publication.ref);
        if (source === undefined) return fail("central_advisory_access_source_binding_invalid");

        closure = collectSourceClosure(sourceBoard, scope, source, new Set([...visitingPublications, publication.ref]));

        if (!same(source.value.accessSourceRefs, closure.sourceRefs)) return fail("central_advisory_access_source_binding_invalid");

        publicationClosures.set(publication.ref, closure);
      }

      control(publication.ref, item.context);
      if (material !== undefined) controls.add(material.ref);

      for (const ref of closure.sourceRefs) {
        if (!sources.has(ref) && sources.size >= CENTRAL_ADVISORY_ACCESS_SOURCE_CAPACITY) return fail("central_advisory_source_capacity");
        sources.add(ref);
      }

      for (const ref of closure.controlRefs) controls.add(ref);
    }

    if (material !== undefined) {
      const transport = readCentralAdvisoryTransportControl(sourceBoard, scope, material, item.context.materials, runtimeControls.originals);
      if (transport !== undefined) {
        for (const ref of transport.controlRefs) controls.add(ref);
        for (const ref of transport.sourceRefs) add(ref, item.context);
        if (transport.unread) continue;
      }

      if (runtimeControls.material(material, item.context.request, item.context.materials)) controls.add(material.ref);

      // A pure directory does not deliver all addresses it advertises. Its
      // own exact identity is retained; unread entries are not body ancestry.
      if (navigation(material, item.context)) {
        controls.add(material.ref);
        continue;
      }

      for (const ref of material.sourceRefs) add(ref, item.context);

      const organizationInput = organization.input(item.context.organizationRequest);
      if (organizationInput.controlRefs.has(material.ref)) controls.add(material.ref);

      for (const ref of organizationInput.materialEdges.get(material.ref) ?? []) add(ref, item.context);

      if (item.context.purposeControls.has(material.ref)) controls.add(material.ref);

      const provenance = judgmentOrigin(material);
      if (provenance !== undefined) {
        control(material.ref, item.context);
        control(provenance.operationId, item.context);
        for (const ref of provenance.aliases) control(ref, item.context);
        for (const ref of provenance.sourceRefs) add(ref, item.context);
      }

      const judgment = readCentralJudgmentMaterial(material);
      if (judgment !== undefined) {
        if (judgment.scopeHash !== contentHashOf(scope)) fail("central_advisory_source_scope");
        controls.add(material.ref);
        // Compact judgments may omit sourceRefs. Follow their full original
        // and result identities; never turn arbitrary aliases into controls.
        add(judgment.originalRef, item.context);
        add(judgment.resultRef, item.context);
        add(judgment.operationId, item.context);
      }

      const page = centralResearchSourcePage(material, scope, { board });
      if (page !== undefined) {
        controls.add(material.ref);
        add(page.ref, item.context);
        add(page.originalRef, item.context);
        if (page.originalSource !== undefined) add(page.originalSource.ref, item.context);
        for (const alias of [page.ref, page.originalRef, ...(page.originalSource === undefined ? [] : [page.originalSource.ref])]) {
          const address = readCentralMaterialPageRef(alias);
          if (address !== undefined) {
            controls.add(alias);
            add(address.ref, item.context);
          }
        }
      }
    }

    const intent = item.context.intents.get(item.ref);
    if (intent !== undefined) {
      controls.add(item.ref);
      intentSources(intent, item.context);
    }

    const completed = item.context.completed.get(item.ref);
    if (completed !== undefined) {
      controls.add(item.ref);
      for (const ref of [...completed.operation.sourceRefs, ...completed.resultRefs]) add(ref, item.context);
    }

    const organizationRecord = organization.record(item.ref, item.context.request.boardSequence);
    if (organizationRecord.status === "found") {
      if (material !== undefined && !organization.input(item.context.organizationRequest).controlRefs.has(material.ref)
        && !organization.isOriginalDecisionMaterial(material, item.context.request.boardSequence)) {
        return fail("central_advisory_source_delivery_unconfirmed");
      }

      for (const ref of organizationRecord.controlRefs) control(ref, item.context);

      for (const ref of organizationRecord.sourceRefs) add(ref, item.context);

      if (organizationRecord.authorUnavailable) return fail("central_advisory_source_author_unavailable");

      for (const ref of organizationRecord.authorDeliveryRefs) {
        const delivery = deliveryAt(ref);
        if (delivery === undefined) return fail("central_advisory_source_author_unavailable");
        contextFor(delivery);
      }
    }

    const fact = factByRef.get(item.ref);

    if (material === undefined && runtimeControls.refs.has(item.ref)) controls.add(item.ref);

    for (const ref of runtimeControls.edges.get(item.ref) ?? []) add(ref, item.context);

    if (fact !== undefined && runtimeFactRefs.has(item.ref)) controls.add(item.ref);

    // The header is a candidate filter only. The original receipt reader owns
    // scope, canonical payload, chunks, operation identity and output proof.
    if (fact?.scope === scope && fact.algorithmVersion === "central-deliberation-delivery-v1") {
      const delivery = deliveryAt(fact.id);
      if (delivery === undefined) return fail("central_advisory_source_delivery_unconfirmed");
      contextFor(delivery);
    }

    const frame = readRuntimePublicSourceFrame(board, { scope, ref: item.ref });
    if (frame !== undefined) {
      controls.add(frame.ref);

      for (const ref of frame.sourceRefs) add(ref, item.context);

      // The original strict frame reader has already authenticated these links.
      const originalSourceRef = frame.origin.originalSourceRef, publicViewRef = frame.origin.publicViewRef;
      if (typeof originalSourceRef !== "string" || typeof publicViewRef !== "string") throw new Error("central_advisory_source_frame_identity");

      for (const alias of [originalSourceRef, publicViewRef]) {
        const pageAlias = readCentralMaterialPageRef(alias);
        if (pageAlias !== undefined) {
          controls.add(alias);
          add(pageAlias.ref, item.context);
        }
      }

      add(originalSourceRef, item.context);
      add(publicViewRef, item.context);
    }
  }

  return { sourceRefs: [...sources].sort(), controlRefs: [...controls].filter(ref => sources.has(ref)).sort() };
}
