import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix } from "../../learning/reward/v2-facts.js";
import { readOrganizationRecords } from "../../learning/central/organization/records.js";
import { centralBudgetReference } from "../../learning/control/central-budget-parse.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, list, sequence } from "../../validation/json-shape.js";
import { isContentDataSafe } from "../learning-content/content-confidentiality.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { isOrganizationRecordContentSafe, type CentralOrganizationOptions } from "./organization-service.js";
import { ORGANIZATION_CAS_ATTEMPTS, OrganizationCasBusyError } from "./organization-cas.js";

export interface OrganizationPublicationResultEntry {
  readonly candidateIndex: number;
  readonly knowledgeId: string;
  readonly reason: "organization_knowledge_revision_conflict" | "organization_knowledge_source_not_current";
  readonly verifiedRevision: number;
  readonly currentHeadFactId: string | null;
}

export interface OrganizationPublicationResultValue {
  readonly deliveryRef: string;
  readonly operationId: string;
  readonly budgetId: string;
  readonly entries: readonly OrganizationPublicationResultEntry[];
}

export interface OrganizationPublicationResultStored {
  readonly factId: string;
  readonly sequence: number;
  readonly value: OrganizationPublicationResultValue;
}

export const ORGANIZATION_PUBLICATION_RESULT_ALGORITHM = "central-organization-publication-result-v1";
const TYPE = "central_organization_publication_result";
const delivery = (value: unknown): value is string => typeof value === "string" && /^central-deliberation-delivery:[a-f0-9]{64}$/.test(value);
const fact = (value: unknown): value is string => typeof value === "string" && /^organization-record:[a-f0-9]{64}$/.test(value);
const fail = (reason: string): never => { throw new Error(reason); };

export function isOrganizationPublicationResultValue(value: unknown): value is OrganizationPublicationResultValue {
  if (!fields(value, ["deliveryRef", "operationId", "budgetId", "entries"])
    || !delivery(value.deliveryRef) || !identity(value.operationId) || !centralBudgetReference(value.budgetId)
    || !list(value.entries, 1, 64)) return false;

  let previous = -1;

  for (const entry of value.entries) {
    if (!fields(entry, ["candidateIndex", "knowledgeId", "reason", "verifiedRevision", "currentHeadFactId"])
      || !sequence(entry.candidateIndex) || entry.candidateIndex >= 64 || entry.candidateIndex <= previous
      || !identity(entry.knowledgeId)
      || entry.reason !== "organization_knowledge_revision_conflict" && entry.reason !== "organization_knowledge_source_not_current"
      || !sequence(entry.verifiedRevision) || entry.currentHeadFactId !== null && !fact(entry.currentHeadFactId)) return false;
    previous = entry.candidateIndex;
  }

  return true;
}

export function organizationPublicationResultFactId(scope: string, deliveryRef: string, operationId: string): string {
  if (!coordinationScopeValid(scope) || !delivery(deliveryRef) || !identity(operationId)) return fail("organization_publication_result_identity_invalid");
  return `organization-publication-result:${contentHashOf([scope, deliveryRef, operationId])}`;
}

/** A small original outcome receipt, not a copied proposal or new business sample. */
export function buildOrganizationPublicationResult(scope: string, value: OrganizationPublicationResultValue): RewardV2Draft {
  if (!isOrganizationPublicationResultValue(value)) return fail("organization_publication_result_invalid");
  const payloadJson = canonicalJson({ schemaVersion: 1, type: TYPE, value });
  const draft: RewardV2Draft = { id: organizationPublicationResultFactId(scope, value.deliveryRef, value.operationId), scope,
    algorithmVersion: ORGANIZATION_PUBLICATION_RESULT_ALGORITHM, kind: "projection", payloadJson };
  if (!isRewardV2Draft(draft)) return fail("organization_publication_result_capacity");
  return draft;
}

/** Strict original-prefix decoding. Delivery/index ownership is separately
 * resolved by the original receipt owner; these coordinates do not assert it. */
export function readOrganizationPublicationResults(facts: readonly RewardV2Fact[], scope: string,
  boardSequence: number): readonly OrganizationPublicationResultStored[] {
  if (!coordinationScopeValid(scope) || !sequence(boardSequence) || !facts.every(isRewardV2Fact)
    || !validRewardV2Prefix(facts, boardSequence)) return fail("organization_publication_result_prefix_invalid");

  const stored: OrganizationPublicationResultStored[] = [];

  for (const row of facts) {
    if (row.scope !== scope || row.algorithmVersion !== ORGANIZATION_PUBLICATION_RESULT_ALGORITHM) continue;

    let raw: unknown;

    try { raw = JSON.parse(row.payloadJson); } catch { return fail("organization_publication_result_corrupt"); }

    if (!fields(raw, ["schemaVersion", "type", "value"]) || raw.schemaVersion !== 1 || raw.type !== TYPE
      || !isOrganizationPublicationResultValue(raw.value)) return fail("organization_publication_result_corrupt");

    const rebuilt = buildOrganizationPublicationResult(scope, raw.value);
    if (rebuilt.id !== row.id || rebuilt.kind !== row.kind || rebuilt.payloadJson !== row.payloadJson) return fail("organization_publication_result_identity_invalid");

    if (raw.value.entries.some(entry => entry.verifiedRevision >= row.sequence)) return fail("organization_publication_result_revision_invalid");

    stored.push({ factId: row.id, sequence: row.sequence, value: raw.value });
  }

  return stored;
}

/** The same RewardV2 Board reader, writer lock and CAS. The first receipt for
 * one delivery/operation wins; it is never rewritten to a later semantic head. */
export function createOrganizationPublicationResults(options: CentralOrganizationOptions) {
  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled), secrets = [...(options.secrets ?? [])];
  let suspended = false;
  const check = (signal: AbortSignal) => {
    if (!options.enabled()) fail("collect_disabled");
    if (signal.aborted) fail("organization_cancelled");
  };
  const load = async (signal: AbortSignal, organization: "present" | "always" = "present", targetFactId?: string) => {
    check(signal);
    const snapshot = await board.read();
    check(signal);
    const rows = readOrganizationPublicationResults(snapshot.facts, options.scope, snapshot.revision);
    if (!rows.every(row => isContentDataSafe(row.value, options, secrets))) return fail("organization_sensitive_content");

    // Generic prefix/result metadata is always strict. An ordinary no-result
    // lookup need not replay all organization knowledge or its historical use.
    if (organization === "always" || (targetFactId === undefined ? rows.length > 0 : rows.some(row => row.factId === targetFactId))) {
      const projection = readOrganizationRecords(snapshot.facts, options.scope, snapshot.revision);
      if (![...projection.decisions, ...projection.feedbackHistory, ...projection.knowledge]
        .every(row => isOrganizationRecordContentSafe(row.value, options, secrets))) return fail("organization_sensitive_content");
    }

    return { snapshot, rows };
  };
  const existing = (rows: readonly OrganizationPublicationResultStored[], value: Pick<OrganizationPublicationResultValue,
    "operationId" | "budgetId" | "deliveryRef">) => {
    const factId = organizationPublicationResultFactId(options.scope, value.deliveryRef, value.operationId);
    const found = rows.find(row => row.factId === factId);
    if (found !== undefined && (found.value.deliveryRef !== value.deliveryRef || found.value.operationId !== value.operationId
      || found.value.budgetId !== value.budgetId)) return fail("organization_publication_result_conflict");
    return found;
  };

  return Object.freeze({
    async read(operationId: string, budgetId: string, deliveryRef: string, signal: AbortSignal): Promise<OrganizationPublicationResultStored | undefined> {
      check(signal);
      if (!centralBudgetReference(budgetId)) return fail("organization_publication_result_identity_invalid");
      const factId = organizationPublicationResultFactId(options.scope, deliveryRef, operationId);
      if (!isContentDataSafe({ operationId, budgetId, deliveryRef }, options, secrets)) return fail("organization_sensitive_content");
      return existing((await load(signal, "present", factId)).rows, { operationId, budgetId, deliveryRef });
    },

    async list(signal: AbortSignal): Promise<readonly OrganizationPublicationResultStored[]> {
      return (await load(signal)).rows;
    },

    async save(value: OrganizationPublicationResultValue, signal: AbortSignal): Promise<OrganizationPublicationResultStored> {
      check(signal);

      if (suspended) return fail("organization_publication_result_writer_suspended");

      const draft = buildOrganizationPublicationResult(options.scope, value);
      const payload: unknown = JSON.parse(draft.payloadJson);
      if (!fields(payload, ["schemaVersion", "type", "value"]) || !isOrganizationPublicationResultValue(payload.value)) {
        return fail("organization_publication_result_invalid");
      }

      const fixed = payload.value;
      if (!isContentDataSafe(fixed, options, secrets)) return fail("organization_sensitive_content");

      let observedRevision: number | undefined;

      for (let attempt = 0; attempt < ORGANIZATION_CAS_ATTEMPTS; attempt++) {
        const current = await load(signal, "always"), found = existing(current.rows, fixed);

        observedRevision = Math.max(observedRevision ?? 0, current.snapshot.revision);

        if (found !== undefined) return found;

        if (current.snapshot.facts.some(row => row.id === draft.id)) return fail("organization_publication_result_conflict");

        if (fixed.entries.some(entry => entry.verifiedRevision > current.snapshot.revision)) return fail("organization_publication_result_revision_invalid");

        check(signal);
        let written: Awaited<ReturnType<typeof board.append>>;

        try { written = await board.append(current.snapshot.revision, draft); }
        catch {
          suspended = true;
          return fail("organization_publication_result_write_unconfirmed");
        }

        check(signal);

        if (written.status === "stale") continue;

        const saved = existing((await load(signal, "always")).rows, fixed);
        if (saved !== undefined) return saved;

        suspended = true;
        return fail("organization_publication_result_write_unconfirmed");
      }

      throw new OrganizationCasBusyError("publication", observedRevision);
    },
  });
}
