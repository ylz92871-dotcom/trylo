import type { CentralLearningAgentDomain } from "../../learning/control/coordination-contract.js";
import type { CentralLearningIntentDraft, CentralLearningOperation, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { isCentralLearningIntent, isCentralLearningOperation, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import type { CentralResearchSignal } from "./contracts.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { centralJudgmentControlRefs, isCentralJudgmentContextMaterial, readCentralJudgmentMaterial } from "../../learning/central/runtime/judgment.js";
import { createCentralJudgmentProjection } from "./runtime-judgment.js";

export interface GroundedCentralResearch {
  readonly requestRef: string;
  readonly domain: CentralLearningAgentDomain;
  readonly intent: CentralLearningIntentDraft;
  readonly operation: Extract<CentralLearningOperation, { readonly kind: "dispatch" }>;
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly sourceRefs: readonly string[];
}

export interface CentralResearchGroundingOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly enabled: () => boolean;
  /** The normal source owner performs current privacy/visibility checks. */
  readonly readMaterials?: (refs: readonly string[], maximumChars: number, signal: AbortSignal) => Promise<readonly CentralRuntimeMaterial[]>;
}

export class CentralResearchIntakeError extends Error {
  constructor(readonly reason: string, readonly sourceRefs: readonly string[]) {
    super(reason);
    this.name = "CentralResearchIntakeError";
  }
}

function fail(reason: string, refs: readonly string[]): never { throw new CentralResearchIntakeError(reason, refs); }

/** Stable purpose identity shared with exact original-source origin readers. */
export function centralResearchRequestRef(scope: string, intentRef: string, domain: CentralLearningAgentDomain): string {
  return `central-research-request:${contentHashOf([scope, intentRef, domain])}`;
}

/** Exact public material is re-read from the original runtime history. Neither a
 * model-supplied quote nor a source ID alone creates a new external observation. */
export async function groundCentralResearch(options: CentralResearchGroundingOptions, domain: CentralLearningAgentDomain,
  signal: CentralResearchSignal, cancellation: AbortSignal): Promise<GroundedCentralResearch> {
  const active = () => {
    if (!options.enabled() || cancellation.aborted) fail("central_research_intake_cancelled", [signal.intentRef]);
  };

  active();

  if (!isCentralLearningIntent(signal.intent) || !isCentralLearningOperation(signal.operation)
    || signal.operation.kind !== "dispatch" || signal.intentRef !== signal.intent.intentId
    || signal.intent.subject.plane !== "central" || signal.intent.subject.questionRef !== signal.intentRef
    || signal.operation.destination?.plane !== "agent" || signal.operation.destination.domain !== domain) {
    fail("central_research_signal_invalid", [signal.intentRef]);
  }

  const store = createCentralRuntimeStore(options), board = await createBoardReader(options.boardRoot).load();
  active();

  if (!board.ok) throw new Error(board.reason);

  const facts = board.state.rewardV2Facts ?? [];
  const snapshot = readCentralRuntimeRecords(facts, options.scope, board.state.sequence);
  const intent = snapshot.state.intents.find(row => row.intentId === signal.intentRef);
  if (intent === undefined || canonicalJson(intent) !== canonicalJson(signal.intent)
    || intent.continuation.kind !== "ready" || canonicalJson(intent.continuation.operation) !== canonicalJson(signal.operation)) {
    fail("central_research_original_intent_changed", [signal.intentRef, snapshot.stateRef]);
  }

  const derivation = signal.intent.derivation;
  if (derivation === undefined || derivation.citations.length === 0 || derivation.parentRefs.length === 0) {
    fail("central_research_derivation_required", [signal.intentRef]);
  }

  const wanted = [...new Set([...signal.intent.sourceRefs, ...derivation.parentRefs,
    ...derivation.citations.map(row => row.evidenceRef), ...signal.intent.knowledge.flatMap(row => row.sourceRefs),
    ...signal.operation.sourceRefs])];
  const materials = new Map<string, CentralRuntimeMaterial>();
  const add = (material: CentralRuntimeMaterial) => {
    const prior = materials.get(material.ref);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(material)) fail("central_research_material_conflict", [material.ref]);
    materials.set(material.ref, material);
  };

  for (const material of snapshot.state.materials) {
    if (wanted.includes(material.ref) || material.sourceRefs.some(ref => wanted.includes(ref))) add(material);
  }

  for (const ref of wanted) {
    active();
    if (materials.has(ref)) continue;
    const archived = await store.lookup(options.scope, { kind: "material", ref });
    if (archived.status === "found" && isCentralRuntimeMaterial(archived.value)) add(archived.value);
  }

  for (const citation of derivation.citations) {
    const original = materials.get(citation.evidenceRef);
    if (original === undefined || isCentralUnreadNavigationMaterial(original) || !citation.quote.trim() || original.text.indexOf(citation.quote) < 0
      || original.text.indexOf(citation.quote) !== original.text.lastIndexOf(citation.quote)
      || !derivation.parentRefs.includes(citation.evidenceRef)) {
      fail("central_research_citation_not_original_read_material", [citation.evidenceRef]);
    }

    if (options.readMaterials !== undefined) {
      // Reading one exact ref avoids a large unrelated source displacing the
      // quoted material. A fragment may have a new ID, so compare source body.
      let reread: readonly CentralRuntimeMaterial[];

      try { reread = await options.readMaterials([citation.evidenceRef], 32768, cancellation); }
      catch { return fail("central_research_original_material_read_failed", [citation.evidenceRef]); }

      active();

      if (!reread.some(row => canonicalJson(row) === canonicalJson(original))) {
        fail("central_research_original_material_unavailable_or_changed", [citation.evidenceRef]);
      }
    }
  }

  const visible = new Set([snapshot.stateRef, signal.intentRef, ...snapshot.state.intents.flatMap(row => [row.intentId, ...row.sourceRefs]),
    ...snapshot.history.consumedSourceRefs, ...snapshot.state.completed.flatMap(row => [row.operation.operationId, ...row.resultRefs])]);

  for (const material of materials.values()) for (const ref of [material.ref, ...material.sourceRefs]) visible.add(ref);

  if (wanted.some(ref => !visible.has(ref))) fail("central_research_source_not_read", wanted.filter(ref => !visible.has(ref)));

  const projected = createCentralJudgmentProjection({ facts, scope: options.scope,
    boardSequence: board.state.sequence }).materials([...materials.values()]);
  const judgmentRefs = centralJudgmentControlRefs(projected);
  // Preserve the already validated original derivation and references. Its
  // public judgments travel as strict, readable context rather than raw task
  // results; their namespace is not a read-source unit in native episodes.
  const nativeMaterials = projected.filter(material => !isCentralJudgmentContextMaterial(material, judgmentRefs)
    || readCentralJudgmentMaterial(material) !== undefined);

  active();

  return { requestRef: centralResearchRequestRef(options.scope, signal.intentRef, domain), domain,
    intent: signal.intent, operation: signal.operation, materials: nativeMaterials,
    sourceRefs: [...new Set([signal.intentRef, ...wanted, ...nativeMaterials.map(material => material.ref)])] };
}
