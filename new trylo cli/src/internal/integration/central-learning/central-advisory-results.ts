import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isRewardV2Draft, type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, text } from "../../validation/json-shape.js";
import type { AppliedCentralAdvisoryDecision } from "./central-advisory-applied-decisions.js";
import { readCentralAdvisoryRecords } from "./central-advisory-records.js";

const ALGORITHM = "central-advisory-publication-result-v1";
const TYPE = "central_advisory_publication_result";

export interface CentralAdvisoryActionResult {
  readonly index: number;
  readonly kind: "publish" | "withdraw";
  readonly status: "published" | "withdrawn" | "rejected" | "superseded";
  readonly publicationRef: string | null;
  readonly reason: string | null;
}

export interface CentralAdvisoryPublicationResult {
  readonly status: "recorded" | "existing";
  readonly resultRef: string;
  readonly results: readonly CentralAdvisoryActionResult[];
}

interface ResultValue {
  readonly schemaVersion: 1;
  readonly type: typeof TYPE;
  readonly scope: string;
  readonly budgetId: string;
  readonly appliedStateRef: string;
  readonly appliedSequence: number;
  readonly deliveryRef: string;
  readonly decisionRef: string;
  readonly entries: readonly CentralAdvisoryActionResult[];
}

const fail = (): never => { throw new Error("central_advisory_result_corrupt"); };

function identity(decision: AppliedCentralAdvisoryDecision): Omit<ResultValue, "entries"> {
  return { schemaVersion: 1 as const, type: TYPE, scope: decision.request.scope, budgetId: decision.request.budgetId,
    appliedStateRef: decision.appliedStateRef, appliedSequence: decision.appliedSequence,
    deliveryRef: decision.deliveryRef, decisionRef: decision.decisionRef };
}

export function centralAdvisoryResultRef(decision: AppliedCentralAdvisoryDecision): string {
  return `central-advisory-result:${contentHashOf([decision.request.scope, decision.deliveryRef, decision.appliedStateRef])}`;
}

export function isCentralAdvisoryActionResult(value: unknown): value is CentralAdvisoryActionResult {
  if (!fields(value, ["index", "kind", "status", "publicationRef", "reason"]) || Reflect.ownKeys(value).length !== 5
    || !Number.isSafeInteger(value.index) || Number(value.index) < 0 || !["publish", "withdraw"].includes(String(value.kind))) return false;
  if (value.status === "published" || value.status === "withdrawn") return value.reason === null
    && typeof value.publicationRef === "string" && /^central-advisory-publication:[a-f0-9]{64}$/.test(value.publicationRef)
    && value.kind === (value.status === "published" ? "publish" : "withdraw");
  return (value.status === "rejected" || value.status === "superseded") && value.publicationRef === null && text(value.reason, 256);
}

export function buildCentralAdvisoryResult(decision: AppliedCentralAdvisoryDecision,
  entries: readonly CentralAdvisoryActionResult[]): RewardV2Draft {
  const actions = decision.output.knowledgeHandoffs ?? [];
  if (entries.length !== actions.length || !entries.every((entry, index) => isCentralAdvisoryActionResult(entry)
    && entry.index === index && entry.kind === actions[index]?.kind)) return fail();

  const value: ResultValue = { ...identity(decision), entries };
  const draft: RewardV2Draft = { id: centralAdvisoryResultRef(decision), scope: decision.request.scope,
    algorithmVersion: ALGORITHM, kind: "projection", payloadJson: canonicalJson(value) };
  if (!isRewardV2Draft(draft)) return fail();
  return draft;
}

/** The footer is a receipt of exact original facts, never permission to infer a
 * missing publication from an acknowledgement or a model-selected identifier. */
export function readCentralAdvisoryResult(facts: readonly RewardV2Fact[], decision: AppliedCentralAdvisoryDecision,
  boardSequence: number): CentralAdvisoryPublicationResult | undefined {
  const records = readCentralAdvisoryRecords(facts, decision.request.scope, boardSequence);
  const fact = facts.find(row => row.id === centralAdvisoryResultRef(decision));
  if (fact === undefined) return undefined;

  let value: unknown;

  try { value = JSON.parse(fact.payloadJson); } catch { return fail(); }

  if (!fields(value, [...Object.keys(identity(decision)), "entries"])
    || Reflect.ownKeys(value).length !== Object.keys(identity(decision)).length + 1 || !Array.isArray(value.entries)
    || !value.entries.every(isCentralAdvisoryActionResult)) return fail();

  const entries = value.entries;
  const expected = buildCentralAdvisoryResult(decision, entries);
  if (fact.scope !== expected.scope || fact.algorithmVersion !== expected.algorithmVersion || fact.kind !== expected.kind
    || fact.payloadJson !== expected.payloadJson || fact.sequence <= decision.appliedSequence) return fail();

  for (const entry of entries) {
    if (entry.publicationRef === null) continue;

    const record = records.find(row => row.ref === entry.publicationRef);
    const action = decision.output.knowledgeHandoffs?.[entry.index];
    if (record === undefined || record.sequence >= fact.sequence || record.value.appliedStateRef !== decision.appliedStateRef
      || record.value.deliveryRef !== decision.deliveryRef || record.value.decisionRef !== decision.decisionRef
      || record.value.appliedSequence !== decision.appliedSequence || record.value.budgetId !== decision.request.budgetId
      || record.value.kind !== entry.kind || action === undefined || action.kind !== record.value.kind) return fail();

    if (action.kind === "publish" && record.value.kind === "publish"
      && (record.value.intentId !== action.intentId || record.value.knowledgeHash !== action.knowledgeHash
        || record.value.whenRelevant !== action.whenRelevant || record.value.uncertainty !== action.uncertainty)) return fail();

    if (action.kind === "withdraw" && record.value.kind === "withdraw"
      && (record.value.publicationRef !== action.publicationRef || record.value.why !== action.why)) return fail();
  }

  return { status: "existing", resultRef: fact.id, results: entries };
}
