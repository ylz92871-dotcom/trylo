import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { OrganizationDecision } from "../../learning/central/organization/contracts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { isContentDataSafe, isContentValueCredentialSafe } from "../learning-content/content-confidentiality.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { isOrganizationRecordContentSafe, type CentralOrganizationOptions } from "./organization-service.js";
import { originalScopeQueryPrivacyView } from "./organization-query-source.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { lookupCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";

/** A legacy use candidate may contain the host's canonical scope copied into
 * ordinary retrieval prose. Reject that export, retaining the actual safe
 * decision and the strictly verified original delivery as its source. */
export async function rejectedOriginalScopeUseNote(decision: OrganizationDecision,
  input: { readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput; readonly deliveryRef?: string },
  options: CentralOrganizationOptions, signal: AbortSignal): Promise<string | undefined> {
  const use = decision.experienceUse, secrets = options.secrets ?? [];
  if (use === null || isOrganizationRecordContentSafe(decision, options, secrets)) return undefined;

  if (!isContentValueCredentialSafe(use.packet.query.purpose, secrets) || isContentDataSafe(use.packet.query.purpose, options, secrets)
    || !isContentDataSafe(input.output, options, secrets)) return undefined;

  const query = use.packet.query;

  // Isolate the only blocked leaf without altering the draft or its identity.
  if (!isOrganizationRecordContentSafe({ ...decision, experienceUse: { ...use,
    packet: { ...use.packet, query: { ...query, purpose: "[checked_original_scope_query]" } } } }, options, secrets)) return undefined;

  const original = await createCentralDeliberationReceiptsAtRoot({ ...options, budgetId: input.request.budgetId })
    .read(input.request.operation.operationId, signal);
  if (original === undefined || original.deliveryRef !== input.deliveryRef || original.deliveryRef !== use.deliveryRef
    || canonicalJson(original.request) !== canonicalJson(input.request) || canonicalJson(original.output) !== canonicalJson(input.output)
    || original.output.organizationUse?.recallRef !== use.packet.recallRef
    || canonicalJson(original.output.organizationUse.changes) !== canonicalJson(use.changes)) {
    throw new Error("organization_experience_delivery_unverified");
  }

  const materials = [...original.request.materials, ...original.request.organization, ...original.request.state.materials];
  let view = originalScopeQueryPrivacyView(query.purpose, materials, options.scope);
  if (view === undefined || !isContentDataSafe(view, options, secrets)) {
    const targets = [...new Set(query.sourceRefs.filter(ref => ref.startsWith("central-source-page:")))];
    if (targets.length === 0) return undefined;

    if (signal.aborted) throw new Error("organization_cancelled");

    if (!options.enabled()) throw new Error("collect_disabled");

    const snapshot = await (options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled)).read();

    if (signal.aborted) throw new Error("organization_cancelled");

    if (!options.enabled()) throw new Error("collect_disabled");

    const archived = lookupCentralRuntimeRecords(snapshot.facts.filter(fact => fact.sequence <= original.request.boardSequence),
      options.scope, original.request.boardSequence, targets.map(ref => ({ kind: "material", ref })));

    for (const [index, found] of archived.entries()) {
      if (found.status === "found" && isCentralRuntimeMaterial(found.value) && found.value.ref === targets[index]) materials.push(found.value);
    }

    view = originalScopeQueryPrivacyView(query.purpose, materials, options.scope);

    if (view === undefined || !isContentDataSafe(view, options, secrets)) return undefined;
  }

  // Recheck actual source/head bindings before retaining any original choices or
  // publishing knowledge. A metadata defect grants no support or revision right.
  decodeCentralDeliberation(original.output, original.request, secrets, original.wireEvidence?.inputVersion);

  return `Experience-use export rejected because host scope metadata was copied into retrieval prose. The original read/use claim remains in immutable delivery ${original.deliveryRef}; recall ${use.packet.recallRef}. experienceUse:null records no revalidated packet claim and does not assert that experience was unread or unused.`;
}
