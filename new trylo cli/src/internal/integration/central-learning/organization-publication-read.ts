import { ORGANIZATION_ALGORITHM, readOrganizationRecords } from "../../learning/central/organization/records.js";
import { isOrganizationKnowledge } from "../../learning/central/organization/validation.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { isContentDataSafe } from "../learning-content/content-confidentiality.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { isOrganizationRecordContentSafe, type CentralOrganizationOptions } from "./organization-service.js";
import { createOrganizationCandidateView, createOrganizationKnowledgeView, createOrganizationKnowledgeRevisionLocator,
  createOrganizationPublicationFragment,
  organizationPublicationCandidateReadRef, organizationPublicationHeadReadRef } from "./organization-publication-view.js";

type Address = { readonly kind: "head"; readonly factId: string; readonly start: number }
  | { readonly kind: "proposal"; readonly deliveryRef: string; readonly index: number; readonly start: number };

const fail = (reason: string): never => { throw new Error(reason); };

function address(ref: string): Address | undefined {
  if (ref.startsWith("organization-publication-head:")) {
    const matched = /^organization-publication-head:([a-f0-9]{64}):(\d+)$/.exec(ref);
    if (matched === null) return fail("organization_publication_address_invalid");
    const factId = `organization-record:${matched[1]}`, start = Number(matched[2]);
    if (organizationPublicationHeadReadRef(factId, start) !== ref) return fail("organization_publication_address_invalid");
    return { kind: "head", factId, start };
  }

  if (!ref.startsWith("organization-publication-proposal:")) return undefined;

  const matched = /^organization-publication-proposal:([a-f0-9]{64}):(\d+):(\d+)$/.exec(ref);
  if (matched === null) return fail("organization_publication_address_invalid");

  const deliveryRef = `central-deliberation-delivery:${matched[1]}`, index = Number(matched[2]), start = Number(matched[3]);
  if (organizationPublicationCandidateReadRef(deliveryRef, index, start) !== ref) return fail("organization_publication_address_invalid");

  return { kind: "proposal", deliveryRef, index, start };
}

function bounded(material: CentralRuntimeMaterial, scope: string, target: Address, maximumChars: number): CentralRuntimeMaterial {
  const limit = Math.min(maximumChars, 32768), totalChars = material.text.length, start = target.start;
  if (!sequence(start) || start >= totalChars) return fail("organization_publication_address_invalid");

  if (start > 0 && /[\uDC00-\uDFFF]/.test(material.text[start]!) && /[\uD800-\uDBFF]/.test(material.text[start - 1]!)) {
    return fail("organization_publication_address_invalid");
  }

  if (start === 0 && totalChars <= limit) return material;

  const readRef = (offset: number) => target.kind === "head"
    ? organizationPublicationHeadReadRef(target.factId, offset)
    : organizationPublicationCandidateReadRef(target.deliveryRef, target.index, offset);
  const render = (length: number): CentralRuntimeMaterial => {
    const end = start + length;
    return createOrganizationPublicationFragment(scope, { originalRef: material.ref,
      originalReadRef: readRef(0), sourceHash: contentHashOf(material.text), start, end, totalChars,
      text: material.text.slice(start, end), nextRef: end < totalChars ? readRef(end) : null }, material.sourceRefs);
  };
  const remaining = totalChars - start, remainder = render(remaining);
  if (remainder.text.length <= limit) return remainder;

  let lower = 1, upper = remaining - 1, selected: CentralRuntimeMaterial | undefined;

  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    let length = middle;
    const last = material.text.charCodeAt(start + length - 1);
    if (last >= 0xd800 && last <= 0xdbff) length -= 1;

    const page = render(length);
    if (page.text.length <= limit) {
      if (length > 0) selected = page;
      lower = middle + 1;
    } else upper = middle - 1;
  }

  return selected ?? fail("organization_publication_capacity");
}

function headPageWithLocator(material: CentralRuntimeMaterial, scope: string, target: Address,
  maximumChars: number): readonly CentralRuntimeMaterial[] {
  const page = bounded(material, scope, target, maximumChars);

  if (target.kind !== "head" || material.text.length <= 32768) return [page];

  const locator = createOrganizationKnowledgeRevisionLocator(scope, material, page);
  if (page.text.length + locator.text.length <= maximumChars) return [page, locator];

  // Both full metadata envelopes consume the caller's budget. If the minimal
  // pair cannot fit, return the real page alone and grant no revision locator.
  const pageBudget = Math.min(32768, maximumChars - locator.text.length);
  if (pageBudget > 0) {
    try {
      const smaller = bounded(material, scope, target, pageBudget);
      const smallerLocator = createOrganizationKnowledgeRevisionLocator(scope, material, smaller);
      if (smaller.text.length + smallerLocator.text.length <= maximumChars) return [smaller, smallerLocator];
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "organization_publication_capacity") throw error;
    }
  }

  return [page];
}

/** Original Board and receipt readers only. No publication, provider call, wake,
 * additional store or inference that the addressed historical head is current. */
export async function readOrganizationPublicationMemory(options: CentralOrganizationOptions, ref: string,
  signal: AbortSignal, maximumChars = 100000): Promise<readonly CentralRuntimeMaterial[] | undefined> {
  const target = address(ref);
  if (target === undefined) return undefined;

  if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || maximumChars > 100000) return fail("organization_publication_capacity");

  const check = () => {
    if (!options.enabled()) fail("organization_disabled");
    if (signal.aborted) fail("organization_publication_cancelled");
  };

  check();
  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled);
  const snapshot = await board.read();
  check();
  const projection = readOrganizationRecords(snapshot.facts, options.scope, snapshot.revision), secrets = options.secrets ?? [];
  if (![...projection.decisions, ...projection.feedbackHistory, ...projection.knowledge]
    .every(row => isOrganizationRecordContentSafe(row.value, options, secrets))) {
    return fail("organization_sensitive_content");
  }

  let material: CentralRuntimeMaterial;

  if (target.kind === "head") {
    const fact = snapshot.facts.find(row => row.id === target.factId && row.scope === options.scope
      && row.algorithmVersion === ORGANIZATION_ALGORITHM);
    if (fact === undefined) return fail("organization_publication_missing");

    const body: unknown = JSON.parse(fact.payloadJson);
    if (!fields(body, ["schemaVersion", "type", "value"]) || body.schemaVersion !== 1
      || body.type !== "central_learning_organization" || !isOrganizationKnowledge(body.value)) return fail("organization_publication_missing");

    if (!isOrganizationRecordContentSafe(body.value, options, secrets)) return fail("organization_sensitive_content");

    material = createOrganizationKnowledgeView(options.scope, { factId: fact.id, sequence: fact.sequence, value: body.value });
  } else {
    const fact = snapshot.facts.find(row => row.id === target.deliveryRef && row.scope === options.scope
      && row.algorithmVersion === "central-deliberation-delivery-v1" && row.kind === "projection");
    if (fact === undefined) return fail("organization_publication_missing");

    const manifest: unknown = JSON.parse(fact.payloadJson);

    // These coordinates only locate the original owner reader. Its strict
    // manifest/chunk/request/response validation remains the source of authority.
    if (!fields(manifest, ["schemaVersion", "type", "budgetId", "operationId", "payloadHash", "chunks"])
      || manifest.schemaVersion !== 1 || manifest.type !== "central_deliberation_public_delivery"
      || typeof manifest.budgetId !== "string" || !identity(manifest.operationId)) return fail("organization_publication_missing");

    const delivery = await createCentralDeliberationReceiptsAtRoot({ ...options, budgetId: manifest.budgetId, board })
      .read(manifest.operationId, signal);

    check();

    if (delivery === undefined || delivery.deliveryRef !== target.deliveryRef) return fail("organization_publication_missing");

    const candidate = delivery.output.organizationKnowledge?.[target.index];
    if (candidate === undefined) return fail("organization_publication_missing");

    material = createOrganizationCandidateView(options.scope, target.deliveryRef, target.index, candidate);
  }

  if (!isContentDataSafe(material, options, secrets)) return fail("organization_sensitive_content");

  const pages = headPageWithLocator(material, options.scope, target, maximumChars);
  if (!pages.every(page => isContentDataSafe(page, options, secrets))) return fail("organization_sensitive_content");

  check();
  return pages;
}
