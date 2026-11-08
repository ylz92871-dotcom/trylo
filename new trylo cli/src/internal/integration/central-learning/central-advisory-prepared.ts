import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isRewardV2Draft, type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { AppliedCentralAdvisoryDecision } from "./central-advisory-applied-decisions.js";
import { readCentralAdvisoryDraft } from "./central-advisory-records.js";
import { buildCentralAdvisoryResult, isCentralAdvisoryActionResult, type CentralAdvisoryActionResult } from "./central-advisory-results.js";

const PLAN = "central-advisory-prepared-plan-v1", CHUNK = "central-advisory-prepared-chunk-v1";
const CHARS = 32768, MAX_CHUNKS = 256;
const fail = (): never => { throw new Error("central_advisory_prepared_plan_corrupt"); };

export interface CentralAdvisoryPreparedPlan {
  readonly ref: string;
  readonly preparedSequence: number;
  readonly drafts: readonly RewardV2Draft[];
  readonly results: readonly CentralAdvisoryActionResult[];
}

function binding(decision: AppliedCentralAdvisoryDecision) {
  return { scope: decision.request.scope, budgetId: decision.request.budgetId, decisionRef: decision.decisionRef,
    deliveryRef: decision.deliveryRef, appliedStateRef: decision.appliedStateRef, appliedSequence: decision.appliedSequence };
}

export function centralAdvisoryPreparedRef(decision: AppliedCentralAdvisoryDecision): string {
  return `central-advisory-plan:${contentHashOf([decision.request.scope, decision.deliveryRef, decision.appliedStateRef])}`;
}

function validateDrafts(decision: AppliedCentralAdvisoryDecision, drafts: readonly RewardV2Draft[],
  results: readonly CentralAdvisoryActionResult[]): void {
  buildCentralAdvisoryResult(decision, results);

  if (new Set(drafts.map(draft => draft.id)).size !== drafts.length
    || drafts.length !== results.filter(row => row.publicationRef !== null).length) return fail();

  for (const draft of drafts) {
    const value = readCentralAdvisoryDraft(draft), entry = results.find(row => row.publicationRef === draft.id);
    const action = entry === undefined ? undefined : decision.output.knowledgeHandoffs?.[entry.index];
    if (entry === undefined || action === undefined || action.kind !== value.kind || value.scope !== decision.request.scope
      || value.budgetId !== decision.request.budgetId || value.appliedStateRef !== decision.appliedStateRef
      || value.appliedSequence !== decision.appliedSequence || value.deliveryRef !== decision.deliveryRef
      || value.decisionRef !== decision.decisionRef) return fail();

    if (value.kind === "publish" && action.kind === "publish" && (value.intentId !== action.intentId
      || value.knowledgeHash !== action.knowledgeHash || value.whenRelevant !== action.whenRelevant || value.uncertainty !== action.uncertainty)) return fail();

    if (value.kind === "withdraw" && action.kind === "withdraw"
      && (value.publicationRef !== action.publicationRef || value.why !== action.why)) return fail();
  }
}

function draft(scope: string, algorithmVersion: string, id: string, value: unknown): RewardV2Draft {
  const result: RewardV2Draft = { scope, algorithmVersion, id, kind: "projection", payloadJson: canonicalJson(value) };
  if (!isRewardV2Draft(result)) return fail();
  return result;
}

/** The manifest is written only after all chunks. An incomplete preparation
 * authorizes no publication; its exact chunks can be reused as immutable data. */
export function buildCentralAdvisoryPreparedPlan(decision: AppliedCentralAdvisoryDecision, preparedSequence: number,
  drafts: readonly RewardV2Draft[], results: readonly CentralAdvisoryActionResult[]): readonly RewardV2Draft[] {
  validateDrafts(decision, drafts, results);

  if (!sequence(preparedSequence) || preparedSequence < decision.appliedSequence) return fail();

  const payload = { schemaVersion: 1, type: "central_advisory_prepared_payload", ...binding(decision), preparedSequence, drafts, entries: results };
  const json = canonicalJson(payload), chunks: RewardV2Draft[] = [];

  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + CHARS, json.length);
    if (end < json.length && /[\ud800-\udbff]/.test(json[end - 1]!)) end -= 1;
    const value = { schemaVersion: 1, type: "central_advisory_prepared_chunk", scope: decision.request.scope,
      deliveryRef: decision.deliveryRef, appliedStateRef: decision.appliedStateRef, index: chunks.length, text: json.slice(offset, end) };
    chunks.push(draft(decision.request.scope, CHUNK, `central-advisory-plan-chunk:${contentHashOf(value)}`, value));
    offset = end;
    if (chunks.length > MAX_CHUNKS) return fail();
  }

  const manifest = { schemaVersion: 1, type: "central_advisory_prepared_plan", ...binding(decision), preparedSequence,
    payloadHash: contentHashOf(payload), chunks: chunks.map(row => row.id) };

  return [...chunks, draft(decision.request.scope, PLAN, centralAdvisoryPreparedRef(decision), manifest)];
}

/** A complete native preparation fixes both successful selections and definite
 * refusals. Recovery never reruns today's access gate to change that decision. */
export function readCentralAdvisoryPreparedPlan(facts: readonly RewardV2Fact[], decision: AppliedCentralAdvisoryDecision): CentralAdvisoryPreparedPlan | undefined {
  const fact = facts.find(row => row.id === centralAdvisoryPreparedRef(decision));
  if (fact === undefined) return undefined;

  let manifest: unknown;

  try { manifest = JSON.parse(fact.payloadJson); } catch { return fail(); }

  if (!fields(manifest, ["schemaVersion", "type", ...Object.keys(binding(decision)), "preparedSequence", "payloadHash", "chunks"])
    || manifest.schemaVersion !== 1 || manifest.type !== "central_advisory_prepared_plan" || !sequence(manifest.preparedSequence)
    || manifest.preparedSequence < decision.appliedSequence || manifest.preparedSequence >= fact.sequence
    || typeof manifest.payloadHash !== "string" || !Array.isArray(manifest.chunks) || manifest.chunks.length < 1
    || manifest.chunks.length > MAX_CHUNKS || !manifest.chunks.every(identity) || new Set(manifest.chunks).size !== manifest.chunks.length
    || fact.scope !== decision.request.scope || fact.algorithmVersion !== PLAN || fact.kind !== "projection") return fail();

  const expectedHeader = { schemaVersion: 1, type: "central_advisory_prepared_plan", ...binding(decision),
    preparedSequence: manifest.preparedSequence, payloadHash: manifest.payloadHash, chunks: manifest.chunks };
  if (fact.payloadJson !== canonicalJson(expectedHeader)) return fail();

  let json = "";

  for (const [index, ref] of manifest.chunks.entries()) {
    const chunk = facts.find(row => row.id === ref);
    if (chunk === undefined || chunk.sequence >= fact.sequence
      || chunk.sequence <= decision.appliedSequence || chunk.scope !== decision.request.scope || chunk.algorithmVersion !== CHUNK || chunk.kind !== "projection") return fail();

    let value: unknown;

    try { value = JSON.parse(chunk.payloadJson); } catch { return fail(); }

    if (!fields(value, ["schemaVersion", "type", "scope", "deliveryRef", "appliedStateRef", "index", "text"])
      || typeof value.text !== "string" || value.text.length < 1 || value.text.length > CHARS) return fail();

    const expected = { schemaVersion: 1, type: "central_advisory_prepared_chunk", scope: decision.request.scope,
      deliveryRef: decision.deliveryRef, appliedStateRef: decision.appliedStateRef, index, text: value.text };
    if (chunk.payloadJson !== canonicalJson(expected) || chunk.id !== `central-advisory-plan-chunk:${contentHashOf(expected)}`) return fail();

    json += value.text;
  }

  let value: unknown;

  try { value = JSON.parse(json); } catch { return fail(); }

  if (!fields(value, ["schemaVersion", "type", ...Object.keys(binding(decision)), "preparedSequence", "drafts", "entries"])
    || !Array.isArray(value.drafts) || !value.drafts.every(isRewardV2Draft)
    || !Array.isArray(value.entries) || !value.entries.every(isCentralAdvisoryActionResult)) return fail();

  const expected = { schemaVersion: 1, type: "central_advisory_prepared_payload", ...binding(decision),
    preparedSequence: manifest.preparedSequence, drafts: value.drafts, entries: value.entries };
  if (json !== canonicalJson(expected) || contentHashOf(expected) !== manifest.payloadHash) return fail();

  validateDrafts(decision, value.drafts, value.entries);

  return { ref: fact.id, preparedSequence: manifest.preparedSequence, drafts: value.drafts, results: value.entries };
}
