import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { readCentralRuntimePurposeHeads } from "../../learning/central/runtime/records.js";
import type { CentralAdvisoryPublish } from "../../integration/central-learning/central-advisory-contracts.js";
import { buildCentralAdvisoryRecord, centralAdvisoryKnowledgeHash } from "../../integration/central-learning/central-advisory-records.js";
import { collectCentralAdvisoryAccessSourceInventory } from "../../integration/central-learning/central-advisory-source-ancestry.js";
import { readCentralDeliberationDeliveriesFromFacts } from "../../integration/central-learning/deliberation-receipts.js";
import { readAppliedCentralAdvisoryDecisions } from "../../integration/central-learning/central-advisory-applied-decisions.js";
import { createCentralAdvisorySourceAccess } from "../../integration/learning-content/sources/advisory-access.js";
import { readContentRecords } from "../../integration/learning-content/records.js";
import { createRuntimeSessionMaterials, type RuntimeSessionMaterialsOptions } from "./central-runtime-materials-session.js";

/** Publication uses the same native source owners as the PA reader. An
 * inspection allowance cannot broadcast private/member-scoped source bodies. */
export function createCentralRuntimeAdvisoryAccess(options: RuntimeSessionMaterialsOptions) {
  return async (board: BoardState, publication: CentralAdvisoryPublish, signal: AbortSignal) => {
    if (!options.enabled() || signal.aborted) throw new Error("central_advisory_access_cancelled");

    const scope = options.ctx.cwd, facts = board.rewardV2Facts ?? [];
    if (publication.scope !== scope) return { ok: false, reason: "central_advisory_source_scope" };

    const applied = readAppliedCentralAdvisoryDecisions(facts, scope, board.sequence).find(row => row.appliedStateRef === publication.appliedStateRef
      && row.appliedSequence === publication.appliedSequence && row.deliveryRef === publication.deliveryRef
      && row.decisionRef === publication.decisionRef && row.request.budgetId === publication.budgetId);
    if (applied === undefined || !applied.output.knowledgeHandoffs?.some(action => action.kind === "publish"
      && action.intentId === publication.intentId && action.knowledgeHash === publication.knowledgeHash
      && action.whenRelevant === publication.whenRelevant && action.uncertainty === publication.uncertainty)) {
      return { ok: false, reason: "central_advisory_access_source_binding_invalid" };
    }

    const source = readCentralRuntimePurposeHeads(facts.filter(fact => fact.sequence <= publication.appliedSequence),
      scope, publication.appliedSequence).find(row => row.factRef === publication.purposeHeadRef
        && row.intent.intentId === publication.intentId);
    const knowledge = source?.intent.knowledge.find(entry => centralAdvisoryKnowledgeHash(entry) === publication.knowledgeHash);
    const delivery = readCentralDeliberationDeliveriesFromFacts(facts, scope, board.sequence, [publication.deliveryRef])[0];
    if (source === undefined || knowledge === undefined || delivery === undefined) {
      return { ok: false, reason: "central_advisory_access_source_binding_invalid" };
    }

    const inventory = collectCentralAdvisoryAccessSourceInventory(board, scope, { intent: source.intent, knowledge, delivery });
    if (canonicalJson(inventory.sourceRefs) !== canonicalJson(publication.accessSourceRefs)) {
      return { ok: false, reason: "central_advisory_access_source_binding_invalid" };
    }

    const controls = new Set(inventory.controlRefs);
    const refs = [...new Set([...publication.sourceRefs, ...inventory.sourceRefs])].filter(ref => !controls.has(ref));

    // The complete original closure has already been authenticated above. A
    // public inference need not acquire an external business sample to share.
    if (refs.length === 0) return { ok: true };

    // Preserve the publication writer's real failure boundary across the PA
    // consumer's conservative unknown result. Only missing/scope/ambiguity are
    // determinate source refusals; unavailable owner reads remain retryable I/O.
    readContentRecords(facts, scope, board.sequence);
    const native = createRuntimeSessionMaterials(options).reader;
    const definite = new Set(["content_material_missing", "content_material_scope", "content_material_ambiguous"]);
    let unavailable: { readonly error: unknown } | undefined;
    const access = createCentralAdvisorySourceAccess({ board, scope, enabled: options.enabled,
      sessionSource: { async readMaterial(...args) {
        try {
          const result = await native.readMaterial(...args);
          if (!result.ok && !definite.has(result.reason)) unavailable = { error: new Error(result.reason) };
          return result;
        } catch (error) {
          unavailable = { error };
          throw error;
        }
      } } });
    const checked = await access({ ref: publication.advisoryId, version: buildCentralAdvisoryRecord(publication).id,
      sourceRefs: refs }, signal);

    if (!options.enabled() || signal.aborted) throw new Error("central_advisory_access_cancelled");

    if (unavailable !== undefined) throw unavailable.error;

    return { ok: checked.status === "allowed", reason: `central_advisory_source_access_${checked.status}` };
  };
}
