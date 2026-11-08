import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralRuntimeHistory } from "../../learning/central/runtime/records.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { readSessionPublicTurnAddress } from "../learning-content/sources/session-public-turn.js";
import { centralResearchSourcePage } from "./research-intake-episode-sources.js";
import { readCentralDeliberationDeliveriesFromFacts, type CentralDeliberationDelivery } from "./deliberation-receipts.js";

type Consideration = NonNullable<CentralRuntimeHistory["consideredDeliveries"]>[number];

type DeliveryBinding = Pick<Consideration, "operationId" | "deliveryRef" | "resultRef">;

const bindingFailure = (): never => { throw new Error("central_runtime_business_source_consideration_binding"); };
const versionFailure = (): never => { throw new Error("central_runtime_business_source_version_invalid"); };

function deliveredBusinessVersion(material: CentralRuntimeMaterial, scope: string): string | undefined {
  if (material.kind !== "source" || !material.ref.startsWith("central-source-page:")) return undefined;

  let header: unknown;

  try { header = JSON.parse(material.text); }
  catch { return versionFailure(); }

  if (typeof header !== "object" || header === null || !("role" in header)
    || header.role !== "actual_source_fragment_not_full_source" || !("owner" in header) || header.owner !== "session") return undefined;

  const page = centralResearchSourcePage(material, scope);
  if (page === undefined) return undefined;

  const original = readSessionPublicTurnAddress(page.originalRef), direct = readSessionPublicTurnAddress(page.ref);
  if (page.originalRef.startsWith("session-public-turn:") && original === undefined
    || page.ref.startsWith("session-public-turn:") && direct === undefined) return versionFailure();

  const frozen = original ?? direct;
  if (frozen === undefined) return undefined;

  const frozenRef = original === undefined ? page.ref : page.originalRef;
  if (page.origin !== "execution_result" || page.sourceHash !== frozen.sourceHash
    || page.coordinate.runId !== frozenRef || page.coordinate.sequence !== 0
    || original !== undefined && direct !== undefined && page.originalRef !== page.ref) return versionFailure();

  // Even a closing fragment exposes the exact frozen address. That establishes
  // version consideration without claiming that the rest of its bytes were read.
  return frozenRef;
}

/** A returned agenda considered this navigable source version. It does not
 * acknowledge any unread bytes, business outcome or independent verification. */
export function consideredCentralBusinessSourceRefs(delivery: CentralDeliberationDelivery,
  proof: DeliveryBinding, scope: string): readonly string[] {
  const { request, output } = delivery;

  if (delivery.deliveryRef !== proof.deliveryRef || request.scope !== scope || request.state.scope !== scope
    || request.operation.kind !== "think" || request.operation.operationId !== proof.operationId
    || proof.resultRef !== `central-deliberation-result:${contentHashOf(output)}`) return bindingFailure();

  // Checkpoint material is not an actual-delivery proof. Only the original
  // receipt's visible material collections can establish a source frontier.
  return [...new Set([...request.materials, ...request.organization].flatMap(material => {
    const ref = deliveredBusinessVersion(material, scope);
    return ref === undefined ? [] : [ref];
  }))];
}

/** Reuse the original receipt decoder once for this verified runtime history;
 * missing, late or mismatched receipts cannot quietly authorize another call. */
export function readConsideredCentralBusinessSourceRefs(input: {
  readonly facts: readonly RewardV2Fact[]; readonly boardSequence: number; readonly scope: string;
  readonly considerations: NonNullable<CentralRuntimeHistory["consideredDeliveries"]>; readonly secrets?: readonly string[];
}): readonly string[] {
  if (input.considerations.length === 0) return [];

  const deliveries = readCentralDeliberationDeliveriesFromFacts(input.facts, input.scope, input.boardSequence,
    input.considerations.map(proof => proof.deliveryRef), input.secrets ?? []);
  const facts = new Map(input.facts.map(fact => [fact.id, fact])), refs = new Set<string>();

  for (const [index, proof] of input.considerations.entries()) {
    const delivery = deliveries[index], manifest = facts.get(proof.deliveryRef), agenda = facts.get(proof.factRef);
    if (delivery === undefined || manifest === undefined || manifest.sequence >= proof.sequence
      || agenda?.scope !== input.scope || agenda.sequence !== proof.sequence) return bindingFailure();
    for (const ref of consideredCentralBusinessSourceRefs(delivery, proof, input.scope)) refs.add(ref);
  }

  return [...refs];
}
