import type { CentralCompletedOperation, CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimePrefix } from "../../learning/central/runtime/records.js";
import { CENTRAL_JUDGMENT_VIEW_PREFIX, readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { isCentralCompletedOperation, isCentralLearningIntent, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { readCentralDeliberationDeliveriesFromFacts, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { centralResearchSourcePage } from "./research-intake-episode-sources.js";

const DELIBERATION = "central-deliberation-result:", OPERATION = "central-operation-result:";
const FRAGMENT = "central-runtime-fragment:", PAGE = "central-source-page:", ARCHIVE = "central-runtime-archived:";
const reserved = [DELIBERATION, OPERATION, FRAGMENT, PAGE, ARCHIVE, CENTRAL_JUDGMENT_VIEW_PREFIX];
const REASON = "central_judgment_provenance_unconfirmed";

export class CentralJudgmentProvenanceError extends Error {
  readonly reason = REASON;

  constructor() {
    super(REASON);
    this.name = "CentralJudgmentProvenanceError";
  }
}

const fail = (): never => { throw new CentralJudgmentProvenanceError(); };
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const owns = (ref: string, prefix: string): boolean => ref.startsWith(prefix);
const hashAddress = (ref: string, prefix: string): boolean => owns(ref, prefix) && /^[a-f0-9]{64}$/.test(ref.slice(prefix.length));
const parse = (text: string): unknown => {
  try { return JSON.parse(text); }
  catch { return fail(); }
};

export interface CentralJudgmentProvenance {
  readonly operationId: string;
  readonly resultRef: string;
  /** The actual delivered view, including its original partial wrapper. */
  readonly originalRef: string;
  readonly originalHash: string;
  readonly text: string;
  readonly sourceRefs: readonly string[];
  readonly aliases: readonly string[];
  readonly materialFactRef: string;
  readonly completedFactRef: string;
}

interface OriginalMaterial { readonly material: CentralRuntimeMaterial; readonly factRef: string }

interface OriginalCompletion { readonly completed: CentralCompletedOperation; readonly factRef: string }

interface JudgmentOrigin {
  readonly operationId: string; readonly resultRef: string;
  readonly materialFactRef: string; readonly completedFactRef: string; readonly aliases: readonly string[];
}

function archiveRequestMatches(ref: string, factRef: string, value: unknown): boolean {
  if (isCentralCompletedOperation(value) && ref === value.operation.operationId) return true;

  if (isCentralLearningIntent(value) && ref === value.intentId) return true;

  if (!ref.startsWith("central-runtime-archive:")) return false;

  let query: unknown;

  try { query = JSON.parse(decodeURIComponent(ref.slice("central-runtime-archive:".length))); }
  catch { return false; } // A malformed address cannot authenticate an archive view.

  const optional = typeof query === "object" && query !== null && Object.hasOwn(query, "factRef") ? ["factRef"] : [];

  if (isCentralCompletedOperation(value)) return fields(query, ["kind", "operationId", ...optional])
    && query.kind === "completed" && query.operationId === value.operation.operationId
    && (optional.length === 0 || query.factRef === factRef);

  return isCentralLearningIntent(value) && fields(query, ["kind", "intentId", ...optional])
    && query.kind === "ended_intent" && query.intentId === value.intentId && value.continuation.kind === "ended"
    && (optional.length === 0 || query.factRef === factRef);
}

/** One verified, same-scope prefix supplies all original bodies. This reader has
 * no IO and never grants a source, funding, publication or dispatch capability. */
export function createCentralJudgmentProvenanceReader(input: {
  readonly facts: readonly RewardV2Fact[]; readonly scope: string; readonly boardSequence: number;
}): (material: CentralRuntimeMaterial) => CentralJudgmentProvenance | undefined {
  const prefix = readCentralRuntimePrefix(input.facts, input.scope, input.boardSequence);
  const snapshots = new Map<string, CentralLearningRuntimeState>();
  const materials = new Map<string, OriginalMaterial>();
  const completions = new Map<string, OriginalCompletion>();
  const semanticResults = new Map<string, OriginalCompletion[]>();
  const virtualArchives = new Map<string, { readonly factRef: string; readonly value: unknown }>();

  for (const snapshot of prefix) {
    snapshots.set(snapshot.factRef, snapshot.state);

    for (const value of [...snapshot.state.completed, ...snapshot.state.intents.filter(row => row.continuation.kind === "ended")]) {
      virtualArchives.set(`${ARCHIVE}${contentHashOf([snapshot.factRef, value])}`, { factRef: snapshot.factRef, value });
    }

    for (const material of snapshot.state.materials) if (!materials.has(material.ref)) {
      materials.set(material.ref, { material, factRef: snapshot.factRef });
    }

    for (const completed of snapshot.state.completed) {
      const resultRef = `${OPERATION}${contentHashOf(completed)}`;
      if (completions.has(resultRef)) continue;

      const original = { completed, factRef: snapshot.factRef };
      completions.set(resultRef, original);

      if (completed.operation.kind !== "think" || completed.outcome !== "returned") continue;

      for (const ref of completed.resultRefs.filter(value => owns(value, DELIBERATION))) {
        const candidates = semanticResults.get(ref) ?? [];
        candidates.push(original);
        semanticResults.set(ref, candidates);
      }
    }
  }

  let deliveries: ReadonlyMap<string, readonly CentralDeliberationDelivery[]> | undefined;
  const originalDeliveries = () => {
    if (deliveries !== undefined) return deliveries;

    const operations = new Set([...semanticResults.values()].flatMap(rows => rows.map(row => row.completed.operation.operationId)));
    const refs: string[] = [];

    // This header lookup selects candidates only. The original receipt decoder
    // below owns manifest, chunk, output, scope and wire authentication.
    for (const fact of input.facts) {
      if (fact.scope !== input.scope || fact.algorithmVersion !== "central-deliberation-delivery-v1") continue;
      const header = parse(fact.payloadJson);
      if (typeof header === "object" && header !== null && "operationId" in header
        && typeof header.operationId === "string" && operations.has(header.operationId)) refs.push(fact.id);
    }

    let found: readonly (CentralDeliberationDelivery | undefined)[];

    try { found = readCentralDeliberationDeliveriesFromFacts(input.facts, input.scope, input.boardSequence, refs); }
    catch { return fail(); } // An unconfirmed original receipt is never ordinary evidence.

    const byOperation = new Map<string, CentralDeliberationDelivery[]>();

    for (const delivery of found) {
      if (delivery === undefined) return fail();
      const operationId = delivery.request.operation.operationId, rows = byOperation.get(operationId) ?? [];
      rows.push(delivery);
      byOperation.set(operationId, rows);
    }

    deliveries = byOperation;
    return deliveries;
  };

  const exactMaterial = (ref: string): OriginalMaterial => materials.get(ref) ?? fail();
  const parentMaterial = (ref: string, childRefs: readonly string[]): OriginalMaterial | undefined => {
    const original = materials.get(ref);
    if (original !== undefined) return original;

    const archived = virtualArchives.get(ref);
    if (archived === undefined) return undefined;

    const requested = [...new Set(childRefs.filter(value => archiveRequestMatches(value, archived.factRef, archived.value)))];
    if (requested.length !== 1) return fail();

    return { factRef: archived.factRef, material: { ref, kind: "work_result",
      text: canonicalJson({ role: "exact_original_runtime_archive_not_new_evidence", factRef: archived.factRef, value: archived.value }),
      sourceRefs: [archived.factRef, requested[0]!] } };
  };
  const archived = (material: CentralRuntimeMaterial, visiting: ReadonlySet<string>): JudgmentOrigin | undefined => {
    const body = parse(material.text);
    if (!fields(body, ["role", "factRef", "value"]) || body.role !== "exact_original_runtime_archive_not_new_evidence"
      || !identity(body.factRef) || material.kind !== "work_result"
      || material.text !== canonicalJson(body) || material.ref !== `${ARCHIVE}${contentHashOf([body.factRef, body.value])}`
      || material.sourceRefs.length !== 2 || material.sourceRefs[0] !== body.factRef
      || !archiveRequestMatches(material.sourceRefs[1]!, body.factRef, body.value)) return fail();

    const snapshot = snapshots.get(body.factRef);
    if (snapshot === undefined) return fail();

    if (isCentralLearningIntent(body.value)) {
      if (!snapshot.intents.some(intent => intent.continuation.kind === "ended" && same(intent, body.value))) return fail();
      return undefined;
    }

    if (!isCentralCompletedOperation(body.value) || !snapshot.completed.some(row => same(row, body.value))) return fail();

    const completed = body.value;
    if (completed.operation.kind !== "think") return undefined;

    if (completed.outcome !== "returned") {
      // Issuance and definite failure are original progress facts. Neither
      // promises that a semantic result material or returned output exists.
      const resultRef = `${OPERATION}${contentHashOf(completed)}`;
      return { operationId: completed.operation.operationId, resultRef, materialFactRef: body.factRef,
        completedFactRef: body.factRef, aliases: [material.ref, resultRef] };
    }

    const semantic = completed.resultRefs.filter(ref => owns(ref, DELIBERATION));
    if (semantic.length > 1) return fail();

    const resultRef = semantic[0] ?? `${OPERATION}${contentHashOf(completed)}`;
    const original = origin(exactMaterial(resultRef).material, visiting);
    if (original === undefined || original.operationId !== completed.operation.operationId) return fail();

    return { ...original, aliases: [...original.aliases, material.ref] };
  };

  const origin = (material: CentralRuntimeMaterial, visiting: ReadonlySet<string>): JudgmentOrigin | undefined => {
    if (!isCentralRuntimeMaterial(material)) return fail();

    if (visiting.has(material.ref)) return fail();

    const next = new Set(visiting);
    next.add(material.ref);

    if (owns(material.ref, DELIBERATION)) {
      if (!hashAddress(material.ref, DELIBERATION)) return fail();

      const original = exactMaterial(material.ref);
      if (!same(original.material, material) || material.kind !== "knowledge") return fail();

      for (const candidate of semanticResults.get(material.ref) ?? []) {
        const completed = candidate.completed;
        if (completed.publicResult !== material.text) continue;

        const archivedView = [...materials.values()].some(row => {
          const body = readCentralJudgmentMaterial(row.material);
          return body !== undefined && body.scopeHash === contentHashOf(input.scope)
            && body.operationId === completed.operation.operationId && body.resultRef === material.ref
            && body.originalRef === material.ref && body.originalHash === contentHashOf(material)
            && body.originalChars === material.text.length && body.text === material.text.slice(0, body.text.length);
        });
        if (archivedView) return { operationId: completed.operation.operationId, resultRef: material.ref,
          materialFactRef: original.factRef, completedFactRef: candidate.factRef, aliases: [material.ref] };

        for (const delivery of originalDeliveries().get(completed.operation.operationId) ?? []) {
          if (!same(delivery.request.operation, completed.operation)
            || material.ref !== `${DELIBERATION}${contentHashOf(delivery.output)}`
            || material.text !== delivery.output.publicExplanation || completed.publicResult !== material.text
            || !same(material.sourceRefs, delivery.output.sourceRefs)) continue;
          return { operationId: completed.operation.operationId, resultRef: material.ref,
            materialFactRef: original.factRef, completedFactRef: candidate.factRef, aliases: [material.ref] };
        }
      }

      return fail();
    }

    if (owns(material.ref, OPERATION)) {
      if (!hashAddress(material.ref, OPERATION)) return fail();

      const original = exactMaterial(material.ref), completion = completions.get(material.ref);
      if (completion === undefined || !same(original.material, material) || material.kind !== "work_result"
        || material.text !== completion.completed.publicResult || !same(material.sourceRefs, completion.completed.resultRefs)) return fail();

      if (completion.completed.operation.kind !== "think") return undefined;

      return { operationId: completion.completed.operation.operationId, resultRef: material.ref,
        materialFactRef: original.factRef, completedFactRef: completion.factRef, aliases: [material.ref] };
    }

    if (owns(material.ref, CENTRAL_JUDGMENT_VIEW_PREFIX)) {
      const body = readCentralJudgmentMaterial(material), original = exactMaterial(material.ref);
      if (body === undefined || body.scopeHash !== contentHashOf(input.scope) || !same(original.material, material)) return fail();

      const recorded = completions.get(body.resultRef);
      const candidates = [...semanticResults.get(body.resultRef) ?? [], ...(recorded === undefined ? [] : [recorded])];
      const completion = candidates.find(row => row.completed.operation.kind === "think"
        && row.completed.operation.operationId === body.operationId);
      if (completion === undefined) return fail();

      return { operationId: body.operationId, resultRef: body.resultRef, materialFactRef: original.factRef,
        completedFactRef: completion.factRef, aliases: [...new Set([body.resultRef, ...body.aliases, body.originalRef, material.ref])] };
    }

    if (owns(material.ref, ARCHIVE)) return archived(material, next);

    if (owns(material.ref, FRAGMENT)) {
      const body = parse(material.text);
      if (!fields(body, ["originalRef", "start", "end", "totalChars", "text", "nextRef"])
        || !identity(body.originalRef) || !sequence(body.start) || !sequence(body.end) || !sequence(body.totalChars)
        || typeof body.text !== "string" || body.end <= body.start || body.end > body.totalChars
        || body.end - body.start !== body.text.length || material.text !== canonicalJson(body)
        || material.ref !== `${FRAGMENT}${contentHashOf([body.originalRef, body.start, body.text])}`
        || body.nextRef !== (body.end < body.totalChars ? `central-runtime-page:${body.end}:${encodeURIComponent(body.originalRef)}` : null)) return fail();

      const originalRef = body.originalRef, parent = parentMaterial(originalRef, material.sourceRefs);
      if (parent === undefined) {
        if (reserved.some(value => owns(originalRef, value))) return fail();
        return undefined;
      }

      if (material.kind !== parent.material.kind || body.totalChars !== parent.material.text.length
        || body.text !== parent.material.text.slice(body.start, body.end)
        || !same(material.sourceRefs, [...new Set([parent.material.ref, ...parent.material.sourceRefs])])) return fail();

      const result = origin(parent.material, next);

      return result === undefined ? undefined : { ...result, aliases: [...result.aliases, material.ref] };
    }

    if (owns(material.ref, PAGE)) {
      const header = parse(material.text);
      if (typeof header !== "object" || header === null || !("originalScope" in header) || typeof header.originalScope !== "string") return fail();

      // This authenticates the outer format only, not access to its claimed
      // scope. Judgment authority still requires the same-scope original below.
      let page: ReturnType<typeof centralResearchSourcePage>;

      try { page = centralResearchSourcePage(material, header.originalScope); }
      catch { return fail(); }

      if (page === undefined) return fail();

      const refs = [...new Set([page.ref, page.originalRef, ...(page.originalSource === undefined ? [] : [page.originalSource.ref])])];
      const addressed = new Map(refs.map(ref => [ref, parentMaterial(ref, [...material.sourceRefs, ...refs])]));
      if (refs.some(ref => reserved.some(value => owns(ref, value))
        && addressed.get(ref) === undefined)) return fail();

      const parents = [...addressed.values()].filter((row): row is OriginalMaterial => row !== undefined);
      if (parents.length === 0) {
        if (refs.some(ref => reserved.some(value => owns(ref, value)))) return fail();
        return undefined;
      }

      let result: JudgmentOrigin | undefined;

      for (const parent of parents) {
        const candidate = origin(parent.material, next);
        if (candidate === undefined) continue;
        if (page.originalScope !== input.scope || page.totalChars !== parent.material.text.length
          || page.sourceHash !== contentHashOf(parent.material.text) || page.text !== parent.material.text.slice(page.start, page.end)
          || result !== undefined && (result.operationId !== candidate.operationId || result.resultRef !== candidate.resultRef)) return fail();
        result = candidate;
      }

      return result === undefined ? undefined : { ...result, aliases: [...result.aliases, material.ref] };
    }

    // Ordinary business text is data, even if its JSON mentions host roles.
    return undefined;
  };

  return material => {
    if (!isCentralRuntimeMaterial(material)) return fail();

    // The current projector already owns direct strict views. Only archived
    // views reached through an authenticated outer wrapper need conversion.
    if (owns(material.ref, CENTRAL_JUDGMENT_VIEW_PREFIX)) {
      const body = readCentralJudgmentMaterial(material);
      if (body === undefined || body.scopeHash !== contentHashOf(input.scope)) return fail();
      return undefined;
    }

    const result = origin(material, new Set());
    if (result === undefined) return undefined;

    return { operationId: result.operationId, resultRef: result.resultRef, originalRef: material.ref,
      originalHash: contentHashOf(material), text: material.text,
      sourceRefs: material.sourceRefs,
      aliases: [...new Set(result.aliases)], materialFactRef: result.materialFactRef, completedFactRef: result.completedFactRef };
  };
}
