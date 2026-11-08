import type { OrganizationDecision, OrganizationProjection } from "../../learning/central/organization/contracts.js";
import { buildOrganizationRecord, readOrganizationRecords } from "../../learning/central/organization/records.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { sequence } from "../../validation/json-shape.js";
import { isContentDataSafe } from "../learning-content/content-confidentiality.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralDeliberationReceiptsAtRoot, readCentralDeliberationDeliveriesFromFacts, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { centralOrganizationDeliberationRef, organizationDecisionForOperation } from "./organization-feedback-runtime.js";
import { isOrganizationRecordContentSafe, organizationKnowledgeEvidenceRevisions, organizationPublicationPurposeEvidence,
  type CentralOrganizationOptions } from "./organization-service.js";
import { resolveOrganizationPublicationBindings } from "./organization-publication-bindings.js";
import { createOrganizationPublicationEvidence, createOrganizationPublicationRejection } from "./organization-publication-detail.js";
import { createOrganizationPublicationCondition } from "./organization-publication-material.js";
import { readOrganizationPublicationResults, type OrganizationPublicationResultEntry,
  type OrganizationPublicationResultStored } from "./organization-publication-results.js";
import { organizationPublicationCandidateReadRef, organizationPublicationHeadReadRef } from "./organization-publication-view.js";

export interface OrganizationPublicationProjectedResult {
  readonly stored: OrganizationPublicationResultStored;
  readonly entry: OrganizationPublicationResultEntry;
  readonly condition: CentralRuntimeMaterial;
  readonly detail: CentralRuntimeMaterial;
  readonly evidence: readonly CentralRuntimeMaterial[];
  readonly currentHeadUnchanged: boolean;
}

export interface OrganizationPublicationProjectionQuery {
  readonly consumedSourceRefs: readonly string[];
}

const RESULT = /^organization-publication-result:([a-f0-9]{64})$/;
const fail = (reason: string): never => { throw new Error(reason); };
const corrupt = (): never => fail("organization_publication_result_corrupt");

export function organizationPublicationEvidenceReadRef(resultFactId: string, candidateIndex: number, offset: number): string {
  const result = RESULT.exec(resultFactId);
  if (result === null || !sequence(candidateIndex) || candidateIndex >= 64 || !sequence(offset)
    || offset < 16 || offset > 112 || offset % 16 !== 0) return fail("organization_publication_result_address_invalid");
  return `organization-publication-evidence:${result[1]}:${candidateIndex}:${offset}`;
}

function originalComputation(scope: string, view: OrganizationProjection, delivery: CentralDeliberationDelivery): OrganizationDecision {
  const operationId = delivery.request.operation.operationId;
  const canonical = view.decisions.find(row => row.value.decisionRef === centralOrganizationDeliberationRef(scope, operationId));
  const legacy = canonical === undefined ? view.decisions.find(row => row.value.decisionRef === operationId) : undefined;
  const decision = (canonical ?? legacy)?.value;
  if (decision === undefined || decision.purposeRef !== operationId || !decision.sourceRefs.includes(operationId)
    || !organizationDecisionForOperation(scope, decision, operationId)) return corrupt();

  if (canonical === undefined) {
    // A raw operation expectation is not a legacy agenda merely because its
    // names happen to coincide. Verify the original agenda's existing program.
    const program = canonicalJson({ kind: "agenda", operation: delivery.request.operation,
      publicExplanation: delivery.output.publicExplanation, alternatives: delivery.output.alternatives ?? [],
      choices: delivery.output.intents.map(intent => ({ intentId: intent.intentId, goal: intent.goal, continuation: intent.continuation })) });
    if (decision.program.programRef !== `central-organization-program:${contentHashOf(program)}`) return corrupt();
  }

  return decision;
}

/** The original result calculation, shared by synchronous provenance joins and
 * the live read adapter below. It interprets only one verified Board prefix;
 * caller-facing collection, cancellation and confidentiality stay in the adapter. */
export function createOrganizationPublicationFactsProjection(input: {
  readonly facts: readonly RewardV2Fact[]; readonly scope: string; readonly boardSequence: number;
}) {
  const { facts, scope, boardSequence } = input;
  const stored = readOrganizationPublicationResults(facts, scope, boardSequence);
  let current: OrganizationProjection | undefined;
  const currentProjection = () => current ??= readOrganizationRecords(facts, scope, boardSequence);
  const history = new Map<number, { readonly facts: readonly RewardV2Fact[]; readonly view: OrganizationProjection }>();
  const deliveries = new Map<string, CentralDeliberationDelivery>();
  const original = (row: OrganizationPublicationResultStored) => {
    const { operationId, budgetId, deliveryRef } = row.value, key = canonicalJson([operationId, budgetId, deliveryRef]);
    let delivery = deliveries.get(key);
    if (delivery === undefined) {
      delivery = readCentralDeliberationDeliveriesFromFacts(facts, scope, boardSequence, [deliveryRef])[0];
      if (delivery === undefined || delivery.request.scope !== scope || delivery.request.budgetId !== budgetId
        || delivery.request.operation.operationId !== operationId) return corrupt();
      deliveries.set(key, delivery);
    }

    return delivery;
  };

  return {
    stored, currentProjection,

    read(resultFactId: string, candidateIndex: number): OrganizationPublicationProjectedResult | undefined {
      if (!RESULT.test(resultFactId) || !sequence(candidateIndex) || candidateIndex >= 64) return fail("organization_publication_result_address_invalid");

      const row = stored.find(item => item.factId === resultFactId), entry = row?.value.entries.find(item => item.candidateIndex === candidateIndex);
      if (row === undefined || entry === undefined) return undefined;

      const latest = currentProjection(), delivery = original(row), { operationId, budgetId, deliveryRef } = row.value;
      const manifest = facts.find(fact => fact.id === deliveryRef && fact.scope === scope
        && fact.algorithmVersion === "central-deliberation-delivery-v1" && fact.kind === "projection");
      if (manifest === undefined || manifest.sequence > entry.verifiedRevision) return corrupt();

      const candidate = delivery.output.organizationKnowledge?.[entry.candidateIndex];
      if (candidate === undefined || candidate.knowledgeId !== entry.knowledgeId) return corrupt();

      let prefix = history.get(entry.verifiedRevision);
      if (prefix === undefined) {
        const prefixFacts = facts.filter(fact => fact.sequence <= entry.verifiedRevision);
        prefix = { facts: prefixFacts, view: readOrganizationRecords(prefixFacts, scope, entry.verifiedRevision) };
        history.set(entry.verifiedRevision, prefix);
      }

      const head = prefix.view.knowledge.find(item => item.value.knowledgeId === candidate.knowledgeId);
      if ((head?.factId ?? null) !== entry.currentHeadFactId) return corrupt();

      const computation = originalComputation(scope, prefix.view, delivery);
      let draft: ReturnType<typeof buildOrganizationRecord>;

      try { draft = buildOrganizationRecord(scope, candidate); } catch { return corrupt(); }

      let rejected: string | undefined;

      try { readOrganizationRecords([...prefix.facts, { ...draft, sequence: entry.verifiedRevision + 1 }], scope, entry.verifiedRevision + 1); }
      catch (error) { rejected = error instanceof Error ? error.message : undefined; }

      if (rejected !== entry.reason) return corrupt();

      const conditionValue = { knowledgeId: candidate.knowledgeId, currentHeadFactId: entry.currentHeadFactId, reason: entry.reason };
      const condition = createOrganizationPublicationCondition(scope, conditionValue);
      const revisions = organizationKnowledgeEvidenceRevisions(prefix.view, candidate), evidence: CentralRuntimeMaterial[] = [], evidenceReadRefs: string[] = [];

      for (let offset = 16; offset < revisions.length; offset += 16) {
        evidenceReadRefs.push(organizationPublicationEvidenceReadRef(row.factId, entry.candidateIndex, offset));
        evidence.push(createOrganizationPublicationEvidence(scope, { conditionRef: condition.ref, deliveryRef,
          candidateIndex: entry.candidateIndex, offset, total: revisions.length, evidenceRevisions: revisions.slice(offset, offset + 16) }));
      }

      const detail = createOrganizationPublicationRejection(scope, { ...conditionValue, conditionRef: condition.ref,
        operationId, budgetId, decisionRef: computation.decisionRef, deliveryRef, candidateIndex: entry.candidateIndex,
        candidateHash: contentHashOf(candidate), candidateFactId: draft.id,
        candidateReadRef: organizationPublicationCandidateReadRef(deliveryRef, entry.candidateIndex), verifiedRevision: entry.verifiedRevision,
        currentHead: head === undefined ? null : { factId: head.factId, knowledgeId: head.value.knowledgeId,
          readRef: organizationPublicationHeadReadRef(head.factId) }, evidenceRevisions: revisions.slice(0, 16),
        evidenceCount: revisions.length, evidenceReadRefs,
        bindings: resolveOrganizationPublicationBindings(delivery.request, organizationPublicationPurposeEvidence(prefix.view, candidate)) });

      return { stored: row, entry, condition, detail, evidence,
        currentHeadUnchanged: (latest.knowledge.find(item => item.value.knowledgeId === candidate.knowledgeId)?.factId ?? null) === entry.currentHeadFactId };
    },
  };
}

/** Interpret only original result receipts against their original checked
 * prefixes. No new publication, model call, global cache or feedback is created. */
export function createOrganizationPublicationProjection(options: CentralOrganizationOptions) {
  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled), secrets = [...(options.secrets ?? [])];
  const check = (signal: AbortSignal) => {
    if (!options.enabled()) fail("collect_disabled");
    if (signal.aborted) fail("organization_cancelled");
  };
  const safeProjection = (view: OrganizationProjection) => {
    if (![...view.decisions, ...view.feedbackHistory, ...view.knowledge]
      .every(row => isOrganizationRecordContentSafe(row.value, options, secrets))) fail("organization_sensitive_content");
  };
  const load = async (signal: AbortSignal) => {
    check(signal);
    const read = await board.read();
    check(signal);
    const snapshot = { revision: read.revision, facts: read.facts.map(row => ({ ...row })) };
    const native = createOrganizationPublicationFactsProjection({ facts: snapshot.facts, scope: options.scope, boardSequence: snapshot.revision });
    const stored = native.stored;
    if (!stored.every(row => isContentDataSafe(row.value, options, secrets))) fail("organization_sensitive_content");

    let current: OrganizationProjection | undefined;
    const currentProjection = () => {
      if (current === undefined) {
        current = native.currentProjection();
        safeProjection(current);
      }
      return current;
    };
    const history = new Map<number, { readonly facts: readonly RewardV2Fact[]; readonly view: OrganizationProjection }>();
    const deliveries = new Map<string, Promise<CentralDeliberationDelivery>>();
    // This read-only adapter exposes the one snapshot already read from the
    // original Board. The original receipt owner still verifies all its bytes.
    const snapshotPort: ReturnType<typeof createRewardV2BoardPort> = {
      async read() {
        check(signal);
        return snapshot;
      }, async append() { return fail("organization_publication_read_only"); },
    };
    const original = (row: OrganizationPublicationResultStored) => {
      const { operationId, budgetId, deliveryRef } = row.value, key = canonicalJson([operationId, budgetId, deliveryRef]);
      let pending = deliveries.get(key);
      if (pending === undefined) {
        pending = (async () => {
          const delivery = await createCentralDeliberationReceiptsAtRoot({ ...options, budgetId, board: snapshotPort }).read(operationId, signal);
          check(signal);
          if (delivery === undefined || delivery.deliveryRef !== deliveryRef || delivery.request.scope !== options.scope
            || delivery.request.budgetId !== budgetId || delivery.request.operation.operationId !== operationId) return corrupt();
          return delivery;
        })();
        deliveries.set(key, pending);
      }

      return pending;
    };
    const project = async (row: OrganizationPublicationResultStored, entry: OrganizationPublicationResultEntry): Promise<OrganizationPublicationProjectedResult> => {
      check(signal);
      currentProjection();
      const delivery = await original(row), { deliveryRef } = row.value;
      const manifest = snapshot.facts.find(fact => fact.id === deliveryRef && fact.scope === options.scope
        && fact.algorithmVersion === "central-deliberation-delivery-v1" && fact.kind === "projection");
      if (manifest === undefined || manifest.sequence > entry.verifiedRevision) return corrupt();

      const candidate = delivery.output.organizationKnowledge?.[entry.candidateIndex];
      if (candidate === undefined || candidate.knowledgeId !== entry.knowledgeId) return corrupt();

      if (!isContentDataSafe(candidate, options, secrets)) return fail("organization_sensitive_content");

      let prefix = history.get(entry.verifiedRevision);
      if (prefix === undefined) {
        const facts = snapshot.facts.filter(fact => fact.sequence <= entry.verifiedRevision);
        const view = readOrganizationRecords(facts, options.scope, entry.verifiedRevision);
        safeProjection(view);
        prefix = { facts, view };
        history.set(entry.verifiedRevision, prefix);
      }

      const projected = native.read(row.factId, entry.candidateIndex);
      if (projected === undefined) return corrupt();

      if (!isContentDataSafe([projected.condition, projected.detail, ...projected.evidence], options, secrets)) return fail("organization_sensitive_content");

      check(signal);

      return projected;
    };

    return { stored, project, currentProjection };
  };

  return Object.freeze({
    async list(signal: AbortSignal, query?: OrganizationPublicationProjectionQuery): Promise<readonly OrganizationPublicationProjectedResult[]> {
      const loaded = await load(signal), projected: OrganizationPublicationProjectedResult[] = [];
      const consumed = new Set(query?.consumedSourceRefs ?? []);
      const pending = loaded.stored.flatMap(stored => stored.value.entries.flatMap(entry => {
        const condition = createOrganizationPublicationCondition(options.scope, { knowledgeId: entry.knowledgeId,
          currentHeadFactId: entry.currentHeadFactId, reason: entry.reason });
        return consumed.has(condition.ref) ? [] : [{ stored, entry }];
      }));
      if (pending.length === 0) return [];

      const heads = new Map(loaded.currentProjection().knowledge.map(row => [row.value.knowledgeId, row.factId]));

      for (const { stored, entry } of pending) if ((heads.get(entry.knowledgeId) ?? null) === entry.currentHeadFactId) {
        projected.push(await loaded.project(stored, entry));
      }

      return projected.sort((a, b) => a.stored.sequence - b.stored.sequence || a.entry.candidateIndex - b.entry.candidateIndex);
    },

    async readResult(resultFactId: string, signal: AbortSignal): Promise<readonly OrganizationPublicationProjectedResult[]> {
      check(signal);

      if (!RESULT.test(resultFactId)) return fail("organization_publication_result_address_invalid");

      const loaded = await load(signal), stored = loaded.stored.find(row => row.factId === resultFactId);

      loaded.currentProjection();
      const projected: OrganizationPublicationProjectedResult[] = [];

      if (stored !== undefined) for (const entry of stored.value.entries) projected.push(await loaded.project(stored, entry));

      return projected;
    },

    async read(resultFactId: string, candidateIndex: number, signal: AbortSignal): Promise<OrganizationPublicationProjectedResult | undefined> {
      check(signal);
      if (!RESULT.test(resultFactId) || !sequence(candidateIndex) || candidateIndex >= 64) return fail("organization_publication_result_address_invalid");
      const loaded = await load(signal), stored = loaded.stored.find(row => row.factId === resultFactId);
      loaded.currentProjection();
      const entry = stored?.value.entries.find(row => row.candidateIndex === candidateIndex);
      return stored === undefined || entry === undefined ? undefined : loaded.project(stored, entry);
    },
  });
}
