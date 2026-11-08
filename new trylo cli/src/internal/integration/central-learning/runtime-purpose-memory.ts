import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { CentralLearningSubject, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { lookupCentralRuntimePurposeRecord, readCentralRuntimePurposeIndex } from "../../learning/central/runtime/records.js";
import { centralTextRelevance } from "../../learning/central/text-relevance.js";
import { isCentralOriginalContextMaterial } from "./runtime-context-materials.js";
import { centralJudgmentControlRefs } from "../../learning/central/runtime/judgment.js";
import { createCentralJudgmentProjection } from "./runtime-judgment.js";

interface PurposeArchive {
  readonly facts: readonly RewardV2Fact[];
  readonly scope: string;
  readonly boardSequence: number;
}

export interface CentralPurposeMemoryQuery extends PurposeArchive {
  readonly subjects?: readonly CentralLearningSubject[];
  readonly purposes?: readonly { readonly subject: CentralLearningSubject; readonly sourceRefs: readonly string[]; readonly purpose?: string }[];
  readonly materials: readonly CentralRuntimeMaterial[];
}

export interface CentralOpenPurposeBinding {
  readonly intentId: string;
  readonly subject: CentralLearningSubject;
  readonly purpose: string;
  readonly sourceRefs: readonly string[];
  readonly omittedSourceRefs: number;
  readonly factRef: string;
  readonly readRef: string;
}

type Purpose = ReturnType<typeof readCentralRuntimePurposeIndex>[number];

const BROWSE = "central-runtime-purpose-catalog:";
const RECORD = "central-runtime-purpose-record:";
const LEGACY_CATALOG_POLICY = "Preserve the original intent identity and ended state. Read its original record before revising it. Open goals may be reconsidered against relevant new original facts. A withdrawn purpose is not renewed authorization; late results and this catalog cannot revive it.";
const readRef = (row: Purpose) => `${RECORD}${contentHashOf([row.intent.intentId, row.factRef])}`;
const excerpt = (text: string, maximum: number) => text.length <= maximum ? text
  : `${text.slice(0, maximum)} [navigation excerpt; read original for complete text]`;
const statements = (values: readonly string[]) => values.slice(0, 2).map(value => excerpt(value, 256));

/** Lightweight original relations for late owner feedback. Pagination is explicit
 * so a source owner never silently treats the first fixed slice as all open goals.
 * These locators are not fresh observations and cannot revive withdrawn goals. */
export function readCentralOpenPurposeBindings(input: PurposeArchive,
  offset = 0, maximumEntries = 16): { readonly entries: readonly CentralOpenPurposeBinding[]; readonly nextOffset: number | null } {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 32) {
    throw new Error("central_open_purpose_capacity");
  }

  const open = readCentralRuntimePurposeIndex(input.facts, input.scope, input.boardSequence)
    .filter(row => row.intent.continuation.kind === "ended" && row.intent.continuation.goalState === "open");
  const entries = open.slice(offset, offset + maximumEntries).map(row => {
    const refs = [...new Set([row.intent.intentId, ...row.intent.sourceRefs, ...(row.intent.derivation?.parentRefs ?? []),
      ...row.intent.knowledge.flatMap(item => item.sourceRefs)])];
    return { intentId: row.intent.intentId, subject: row.intent.subject, purpose: excerpt(row.intent.goal, 512),
      sourceRefs: refs.slice(0, 64), omittedSourceRefs: Math.max(0, refs.length - 64), factRef: row.factRef, readRef: readRef(row) };
  });

  return { entries, nextOffset: offset + entries.length < open.length ? offset + entries.length : null };
}

/** Bound each comparison with the shared tokenizer's 8192-character window.
 * Separate fields/chunks prevent unrelated notices or a long goal from hiding
 * the actual task or a later residual/condition field. */
function textFields(values: readonly string[]): readonly string[] {
  return values.flatMap(value => {
    const chunks: string[] = [];
    for (let start = 0; start < value.length; start += 8191) chunks.push(value.slice(start, start + 8192));
    return chunks;
  });
}

function purposeRelevance(queries: readonly string[], intent: Purpose["intent"]): number {
  const fields = textFields([intent.goal, intent.rationale, ...intent.conditions, ...intent.residual,
    ...intent.commitment.reconsiderWhen, ...intent.knowledge.flatMap(row => [row.statement, row.conditions]),
    intent.derivation?.whenRelevant ?? ""]);
  let maximum = 0;
  for (const query of queries) for (const field of fields) maximum = Math.max(maximum, centralTextRelevance(query, field));
  return maximum;
}

function knowledgePreview(knowledge: Purpose["intent"]["knowledge"]) {
  const preview = (value: string) => ({ text: value.slice(0, 128), omittedChars: Math.max(0, value.length - 128) });
  const entries = knowledge.slice(0, 2).map(row => ({ statement: preview(row.statement), conditions: preview(row.conditions) }));
  return { role: "navigation_preview_not_original_body", available: knowledge.length, shown: entries.length,
    omitted: knowledge.length - entries.length, entries };
}

function entry(row: Purpose) {
  const intent = row.intent, ended = intent.continuation;
  if (ended.kind !== "ended") throw new Error("central_purpose_archive_not_ended");

  return { intentId: intent.intentId, subject: intent.subject, goalState: ended.goalState,
    goal: excerpt(intent.goal, 512), conditions: statements(intent.conditions), residual: statements(intent.residual),
    stoppedReason: excerpt(ended.reason, 256), reconsiderWhen: statements(intent.commitment.reconsiderWhen),
    ...(intent.knowledge.length === 0 ? {} : { knowledgePreview: knowledgePreview(intent.knowledge) }),
    resumableFromNewFacts: ended.goalState === "open", factRef: row.factRef, readRef: readRef(row) };
}

function catalog(rows: readonly Purpose[], available: number, start?: number): CentralRuntimeMaterial {
  const entries: ReturnType<typeof entry>[] = [];
  const body = () => ({ role: "original_ended_purpose_navigation_not_new_evidence",
    policy: "Preserve the original intent identity and ended state. Knowledge previews only navigate; read the original record for complete statements, conditions and sources before use or revision. Open goals may be reconsidered against relevant new original facts. A withdrawn purpose is not renewed authorization; late results and this catalog cannot revive it.",
    entries, omittedEntries: Math.max(0, available - entries.length), browseReadRef: `${BROWSE}0`,
    nextReadRef: start === undefined || entries.length >= available ? null : `${BROWSE}${start + entries.length}` });

  for (const row of rows.slice(0, 8)) {
    entries.push(entry(row));
    if (canonicalJson(body()).length > 12000) {
      entries.pop();
      break;
    }
  }

  const text = canonicalJson(body());

  return { ref: `central-runtime-purpose-navigation:${contentHashOf(text)}`, kind: "knowledge", text,
    sourceRefs: entries.flatMap(item => [item.intentId, item.factRef, item.readRef]) };
}

/** Relevance finds original questions to reconsider; it is not an answer,
 * investment instruction, fresh source notice or automatic intent resurrection. */
function relatedPurposes(input: CentralPurposeMemoryQuery): readonly Purpose[] {
  const index = readCentralRuntimePurposeIndex(input.facts, input.scope, input.boardSequence);
  if (index.length === 0) return [];

  const projected = createCentralJudgmentProjection(input).materials(input.materials);
  const judgmentRefs = centralJudgmentControlRefs(projected);
  const materials = projected.filter(material => isCentralOriginalContextMaterial(material, judgmentRefs));
  const queries = textFields([...(input.purposes ?? []).flatMap(row => row.purpose === undefined ? [] : [row.purpose]),
    ...materials.map(row => row.text)]);
  const sources = new Set([...(input.purposes ?? []).flatMap(row => row.sourceRefs),
    ...materials.flatMap(row => [row.ref, ...row.sourceRefs])].filter(ref => !judgmentRefs.has(ref)));
  const subjects = [...(input.subjects ?? []), ...(input.purposes ?? []).map(row => row.subject)].map(canonicalJson);
  const related = index.flatMap(row => {
    const intent = row.intent;
    const exact = Number(subjects.includes(canonicalJson(intent.subject)))
      + Number(intent.sourceRefs.some(ref => sources.has(ref)));
    const relevance = purposeRelevance(queries, intent);
    return exact === 0 && relevance === 0 ? [] : [{ row, exact, relevance }];
  }).sort((a, b) => b.exact - a.exact || b.relevance - a.relevance);

  return related.map(item => item.row);
}

export function recallCentralPurposeMemory(input: CentralPurposeMemoryQuery): CentralRuntimeMaterial | undefined {
  const related = relatedPurposes(input);
  return related.length === 0 ? undefined : catalog(related, related.length);
}

function originalBody(row: Purpose): CentralRuntimeMaterial {
  return { ref: readRef(row), kind: "work_result", text: canonicalJson({ role: "exact_original_ended_learning_purpose_not_new_evidence",
    factRef: row.factRef, value: row.intent }), sourceRefs: [row.intent.intentId, row.factRef] };
}

/** An original open goal can be reconsidered in the same delivered agenda,
 * without inventing an inspection intent merely to read its prior identity.
 * One complete bounded original body is context only, never a fresh wake source. */
export function recallCentralPurposeMaterials(input: CentralPurposeMemoryQuery): readonly CentralRuntimeMaterial[] {
  const related = relatedPurposes(input);
  if (related.length === 0) return [];

  const navigation = catalog(related, related.length);
  const open = related.find(row => row.intent.continuation.kind === "ended" && row.intent.continuation.goalState === "open");
  if (open === undefined) return [navigation];

  const body = originalBody(open);

  return body.text.length <= 8192 && navigation.text.length + body.text.length <= 24000 ? [navigation, body] : [navigation];
}

/** Exact original-body reads and bounded browsing use the same validated chain.
 * Browsing remains available when a different purpose wording has no lexical hit. */
export function readCentralPurposeMemory(input: PurposeArchive, ref: string): CentralRuntimeMaterial | undefined {
  if (!ref.startsWith(BROWSE) && !ref.startsWith(RECORD)) return undefined;

  if (ref.startsWith(RECORD)) {
    const row = lookupCentralRuntimePurposeRecord(input.facts, input.scope, input.boardSequence, ref.slice(RECORD.length));
    if (row === undefined) return undefined;
    return { ...originalBody(row), ref };
  }

  const index = readCentralRuntimePurposeIndex(input.facts, input.scope, input.boardSequence);
  const value = ref.slice(BROWSE.length);
  if (!/^\d+$/.test(value)) throw new Error("central_purpose_catalog_reference_invalid");

  const start = Number(value);
  if (!Number.isSafeInteger(start) || start < 0 || start > index.length) throw new Error("central_purpose_catalog_reference_invalid");

  const rows = index.slice(start, start + 8);

  return catalog(rows, Math.max(0, index.length - start), start);
}

/** Authenticate an old rendered directory against its exact original records,
 * including a later revision/compaction of the same purpose. */
export function isOriginalCentralPurposeNavigation(input: PurposeArchive, material: CentralRuntimeMaterial): boolean {
  if (!material.ref.startsWith("central-runtime-purpose-navigation:")) return false;

  let body: unknown;
  try { body = JSON.parse(material.text); } catch { return false; }

  if (typeof body !== "object" || body === null || !("entries" in body) || !Array.isArray(body.entries)
    || !("omittedEntries" in body) || !Number.isSafeInteger(body.omittedEntries) || Number(body.omittedEntries) < 0
    || !("nextReadRef" in body) || !(body.nextReadRef === null || typeof body.nextReadRef === "string")) return false;

  const rows: Purpose[] = [];

  for (const value of body.entries) {
    if (typeof value !== "object" || value === null || !("intentId" in value) || typeof value.intentId !== "string"
      || !("factRef" in value) || typeof value.factRef !== "string") return false;

    const row = lookupCentralRuntimePurposeRecord(input.facts, input.scope, input.boardSequence, contentHashOf([value.intentId, value.factRef]));
    if (row === undefined) return false;

    const current = entry(row);

    // Original directories predating knowledge previews remain metadata only.
    // Omitting a preview cannot introduce text absent from the original purpose.
    if (!Object.hasOwn(value, "knowledgePreview")) delete current.knowledgePreview;

    if (canonicalJson(current) !== canonicalJson(value)) return false;

    rows.push(row);
  }

  const start = body.nextReadRef === null ? undefined : Number(body.nextReadRef.slice(BROWSE.length)) - rows.length;
  if (start !== undefined && (!body.nextReadRef?.startsWith(BROWSE) || !Number.isSafeInteger(start) || start < 0)) return false;

  const expected = catalog(rows, rows.length + Number(body.omittedEntries), start);
  const expectedBody = JSON.parse(expected.text);

  if ("policy" in body && body.policy === LEGACY_CATALOG_POLICY) expectedBody.policy = LEGACY_CATALOG_POLICY;

  for (let index = 0; index < body.entries.length; index++) {
    if (!Object.hasOwn(body.entries[index], "knowledgePreview")) delete expectedBody.entries[index].knowledgePreview;
  }

  const text = canonicalJson(expectedBody);

  return canonicalJson({ ...expected, text, ref: `central-runtime-purpose-navigation:${contentHashOf(text)}` }) === canonicalJson(material);
}
