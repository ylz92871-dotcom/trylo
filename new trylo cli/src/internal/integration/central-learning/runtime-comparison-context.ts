import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { CentralRuntimeRead } from "../../learning/central/runtime/records.js";
import { CENTRAL_RUNTIME_LIMITS, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { centralTextRelevance, centralTextTerms } from "../../learning/central/text-relevance.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { TaskSourcePage } from "../learning-content/task-source-pages.js";
import { readSessionPublicTurnAddress } from "../learning-content/sources/session-public-turn.js";
import { centralResearchSourcePage } from "./research-intake-episode-sources.js";
import { centralBusinessSourceDirectory } from "./deliberation-business-sources.js";
import type { createCentralRuntimeStore } from "./runtime-store.js";
import { centralJudgmentControlRefs, isCentralJudgmentContextMaterial } from "../../learning/central/runtime/judgment.js";

/** Extra old context is bounded independently of the current source preview.
 * The existing final quote/packing still decides whether either body fits. */
const OLD_CONTEXT_CHARS = 2048;
const genericTerms = new Set("the and or for from with this that these those into only please task request requested input output file files json read write your you are was were have has been not do does its then than can could should would original source session workspace turn".split(" "));
const meaning = (text: string) => [...centralTextTerms(text)].filter(term => !genericTerms.has(term)).join(" ");
const pageRef = (ref: string) => /^central-source-page:[a-f0-9]{64}$/.test(ref);

function businessPage(material: CentralRuntimeMaterial, scope: string): TaskSourcePage | undefined {
  if (material.kind !== "source" || !pageRef(material.ref)) return undefined;

  // This optional recall must not revalidate unrelated board/domain pages.
  // Their normal readers may add provenance or use a compatible source scope.
  // Only an outer session-page claim enters the strict original-page validator.
  let header: unknown;

  try { header = JSON.parse(material.text); } catch { return undefined; } // Unknown objects confer no business eligibility.

  if (typeof header !== "object" || header === null || !("role" in header)
    || header.role !== "actual_source_fragment_not_full_source" || !("owner" in header) || header.owner !== "session") return undefined;

  const page = centralResearchSourcePage(material, scope);

  return page?.owner === "session" ? page : undefined;
}

function sessionOf(page: TaskSourcePage): string {
  return (readSessionPublicTurnAddress(page.ref) ?? readSessionPublicTurnAddress(page.originalRef))?.sessionId ?? page.coordinate.runId;
}

function bodyTexts(page: TaskSourcePage): readonly string[] {
  const collection = readSessionPublicTurnAddress(page.ref) ?? readSessionPublicTurnAddress(page.originalRef);
  if (collection === undefined) return [page.text];

  // A partial collection may end inside a row. Its JSON envelope is never a
  // semantic query; only a complete authored collection exposes row texts.
  if (page.start !== 0 || page.end !== page.totalChars || contentHashOf(page.text) !== collection.sourceHash) return [];

  let value: unknown;

  try { value = JSON.parse(page.text); } catch { throw new Error("central_runtime_comparison_source_invalid"); }

  if (typeof value !== "object" || value === null || !("header" in value) || !("records" in value)
    || typeof value.header !== "object" || value.header === null || !("role" in value.header)
    || value.header.role !== "source_owned_public_turn_collection_not_independent_evidence" || !Array.isArray(value.records)) {
    throw new Error("central_runtime_comparison_source_invalid");
  }

  return value.records.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("text" in row) || typeof row.text !== "string") {
      throw new Error("central_runtime_comparison_source_invalid");
    }
    return row.text;
  });
}

/** Only called inside an already selected thought. Archive membership proves
 * known bytes, not past model delivery or reading. These original candidates
 * neither create source positions nor wake the owner or authorize a paid call. */
export async function recallCentralComparisonContext(input: {
  readonly cursor: CentralRuntimeRead;
  readonly materials: readonly CentralRuntimeMaterial[];
  readonly intent: CentralLearningIntentDraft | null;
  readonly store: Pick<ReturnType<typeof createCentralRuntimeStore>, "lookupMany">;
  /** Reuse the driver's already verified Board prefix; archive lookup adds no new owner. */
  readonly projectMaterials?: (materials: readonly CentralRuntimeMaterial[]) => readonly CentralRuntimeMaterial[];
}): Promise<readonly CentralRuntimeMaterial[]> {
  const { cursor } = input, scope = cursor.state.scope;
  const currentJudgments = centralJudgmentControlRefs([...input.materials, ...cursor.state.materials]);
  const current = input.materials.flatMap(material => {
    if (isCentralJudgmentContextMaterial(material, currentJudgments)) return [];
    const page = businessPage(material, scope);
    return page === undefined ? [] : [{ material, page }];
  });
  const intent = input.intent?.continuation.kind === "ended" ? null : input.intent;
  if (current.length === 0 && intent === null) return [];

  const recent = [...cursor.state.completed].reverse().filter(row => row.operation.kind === "think" && row.outcome === "returned");
  const anchored = new Set([...(intent === null ? [] : [...intent.sourceRefs, ...(intent.derivation?.parentRefs ?? []),
    ...intent.knowledge.flatMap(row => row.sourceRefs)]), ...recent.flatMap(row => row.operation.sourceRefs)]);
  const existing = new Set([...input.materials, ...cursor.state.materials].map(row => row.ref));
  const archived = new Map(cursor.history.materials.map(row => [row.ref, row]));
  // A failed or interrupted thought does not make known original bytes
  // ineligible for comparison. Recall still requires current semantic relevance.
  const candidateRefs = new Set([...anchored, ...[...archived.keys()].reverse()]);
  const refs = [...candidateRefs].filter(ref => pageRef(ref) && !existing.has(ref) && archived.has(ref))
    .slice(0, CENTRAL_RUNTIME_LIMITS.materials);
  if (refs.length === 0) return [];

  // Directory previews can guide recall of a partial turn collection, but are
  // never substituted for its unread rows or used as source-body evidence.
  const catalogRefs = [...cursor.history.materials].reverse().filter(row => row.ref.startsWith("central-business-catalog:")
    && !existing.has(row.ref)).slice(0, Math.max(0, CENTRAL_RUNTIME_LIMITS.materials - refs.length));
  const queries = [...refs.map(ref => ({ kind: "material" as const, ref, factRef: archived.get(ref)!.factRef })),
    ...catalogRefs.map(row => ({ kind: "material" as const, ref: row.ref, factRef: row.factRef }))];
  const found = await input.store.lookupMany(scope, queries);
  if (found.length !== queries.length) throw new Error("central_runtime_source_missing");

  const originals = found.map((row, index) => {
    const query = queries[index]!;
    if (row.status !== "found" || row.factRef !== query.factRef || !isCentralRuntimeMaterial(row.value)
      || row.value.ref !== query.ref) throw new Error("central_runtime_source_missing");
    return row.value;
  });
  const projected = input.projectMaterials?.(originals) ?? originals;
  const judgmentRefs = centralJudgmentControlRefs([...input.materials, ...cursor.state.materials, ...projected]);
  const directories = [...input.materials, ...cursor.state.materials, ...projected].flatMap(material => {
    const directory = centralBusinessSourceDirectory(material);
    return directory === undefined ? [] : [directory];
  });
  const textsFor = (page: TaskSourcePage) => {
    const frozen = readSessionPublicTurnAddress(page.ref) ?? readSessionPublicTurnAddress(page.originalRef);
    return [...bodyTexts(page), ...directories.filter(row => row.sessionId === sessionOf(page)
      && (frozen === undefined ? anchored.has(row.noticeRef) || current.some(row => sessionOf(row.page) === sessionOf(page))
        : row.turnId === frozen.turnId && row.through === frozen.through))
      .flatMap(row => row.taskPreview === undefined ? [] : [row.taskPreview.text])];
  };
  const queriesText = [...current.flatMap(row => textsFor(row.page)), ...(intent === null ? [] : [intent.goal,
    ...intent.conditions, ...intent.residual, intent.commitment.purpose])].map(meaning).filter(Boolean);
  if (queriesText.length === 0) return [];

  const candidates = originals.slice(0, refs.length).flatMap((material, order) => {
    if (isCentralJudgmentContextMaterial(material, judgmentRefs)) return [];
    const page = businessPage(material, scope);
    if (page === undefined) return [];
    const fields = textsFor(page).map(meaning).filter(Boolean);
    const sameSession = current.some(row => sessionOf(row.page) === sessionOf(page));
    const score = sameSession ? 1 : Math.max(0, ...queriesText.flatMap(query => fields.map(field => centralTextRelevance(query, field))));
    return score > 0 ? [{ material, score, order }] : [];
  }).sort((a, b) => b.score - a.score || a.order - b.order);
  const selected: CentralRuntimeMaterial[] = [];
  let remaining = OLD_CONTEXT_CHARS;

  for (const candidate of candidates) {
    if (candidate.material.text.length > remaining) continue;
    selected.push(candidate.material);
    remaining -= candidate.material.text.length;
  }

  return selected;
}
