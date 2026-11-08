import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { coordinationScopeValid } from "../../learning/control/coordination-scope.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimePrefix } from "../../learning/central/runtime/records.js";
import { COORDINATION_DECISION_LIMITS } from "../../learning/control/coordination-parse.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix,
  type RewardV2Draft, type RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { fields, identity, sequence, text } from "../../validation/json-shape.js";
import { CENTRAL_ADVISORY_ALGORITHM, CENTRAL_ADVISORY_TYPE, CENTRAL_ADVISORY_ID_PREFIX,
  CENTRAL_ADVISORY_PUBLICATION_PREFIX, type CentralAdvisoryKnowledge, type CentralAdvisoryValue,
  type CentralAdvisoryPublish, type CentralAdvisoryRecord, type CentralAdvisoryPublicationView,
  type CentralAdvisoryStatus } from "./central-advisory-contracts.js";

const fail = (reason: string): never => { throw new Error(reason); };
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const advisoryRef = (value: unknown): value is string => typeof value === "string"
  && value.startsWith(CENTRAL_ADVISORY_ID_PREFIX) && hash(value.slice(CENTRAL_ADVISORY_ID_PREFIX.length));
const publicationRef = (value: unknown): value is string => typeof value === "string"
  && value.startsWith(CENTRAL_ADVISORY_PUBLICATION_PREFIX) && hash(value.slice(CENTRAL_ADVISORY_PUBLICATION_PREFIX.length));
const stateRef = (value: unknown): value is string => typeof value === "string" && /^central-runtime-state:[a-f0-9]{64}$/.test(value);
const deliveryRef = (value: unknown): value is string => typeof value === "string" && /^central-deliberation-delivery:[a-f0-9]{64}$/.test(value);
// Original purpose text may be empty/unspecified; preserve it without inventing conditions.
const prose = (value: unknown): value is string => typeof value === "string" && value.length <= 32768
  && [...value].every(character => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
const refs = (value: unknown, maximum: number = 256): value is readonly string[] => Array.isArray(value) && value.length <= maximum
  && Reflect.ownKeys(value).length === value.length + 1 && new Set(value).size === value.length
  && value.every(ref => text(ref, COORDINATION_DECISION_LIMITS.sourceRefMaxChars) && !/[\u0000-\u001f]/.test(ref));
const statements = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 64
  && Reflect.ownKeys(value).length === value.length + 1 && value.every(prose);
const knowledge = (value: unknown): value is CentralAdvisoryKnowledge => fields(value, ["statement", "conditions", "sourceRefs"])
  && Reflect.ownKeys(value).length === 3 && prose(value.statement) && prose(value.conditions) && refs(value.sourceRefs);

/** Exact tuple order is retained; this does not merge sources or assess truth. */
export function centralAdvisoryKnowledgeHash(entry: CentralAdvisoryKnowledge): string {
  if (!knowledge(entry)) return fail("central_advisory_knowledge_invalid");
  return contentHashOf({ statement: entry.statement, conditions: entry.conditions, sourceRefs: entry.sourceRefs });
}

export function centralAdvisoryId(scope: string, intentId: string, knowledgeHash: string): string {
  if (!coordinationScopeValid(scope) || !identity(intentId) || !hash(knowledgeHash)) return fail("central_advisory_identity_invalid");
  return `${CENTRAL_ADVISORY_ID_PREFIX}${contentHashOf([scope, intentId, knowledgeHash])}`;
}

const COMMON = ["schemaVersion", "type", "kind", "scope", "budgetId", "advisoryId", "decisionRef", "deliveryRef",
  "appliedStateRef", "appliedSequence", "previousPublicationRef"] as const;

function valueIsValid(value: unknown): value is CentralAdvisoryValue {
  const object = (input: unknown): input is Record<string, unknown> => typeof input === "object" && input !== null && !Array.isArray(input);
  if (!object(value)) return false;

  const keys = value.kind === "publish" ? [...COMMON, "intentId", "purposeHeadRef", "purposeConditions", "knowledgeHash",
    "statement", "conditions", "sourceRefs", "whenRelevant", "uncertainty", "accessSourceRefs"]
    : value.kind === "withdraw" ? [...COMMON, "publicationRef", "why"] : [];
  if (!fields(value, keys) || Reflect.ownKeys(value).length !== keys.length || value.schemaVersion !== 1
    || value.type !== CENTRAL_ADVISORY_TYPE || !coordinationScopeValid(value.scope) || !identity(value.budgetId)
    || !advisoryRef(value.advisoryId) || !identity(value.decisionRef)
    || !deliveryRef(value.deliveryRef) || !stateRef(value.appliedStateRef) || !sequence(value.appliedSequence) || value.appliedSequence < 1
    || value.previousPublicationRef !== null && !publicationRef(value.previousPublicationRef)) return false;

  if (value.kind === "withdraw") return publicationRef(value.publicationRef) && text(value.why, 32768);

  const entry = { statement: value.statement, conditions: value.conditions, sourceRefs: value.sourceRefs };
  if (!knowledge(entry)) return false;

  return identity(value.intentId) && stateRef(value.purposeHeadRef) && hash(value.knowledgeHash)
    && statements(value.purposeConditions) && refs(value.accessSourceRefs, 4096)
    && text(value.whenRelevant, 32768) && text(value.uncertainty, 32768)
    && value.knowledgeHash === centralAdvisoryKnowledgeHash(entry)
    && value.advisoryId === centralAdvisoryId(value.scope, value.intentId, value.knowledgeHash);
}

/** Pure construction only. The original writer must prove the decision/source authority. */
export function buildCentralAdvisoryRecord(value: CentralAdvisoryValue): RewardV2Draft {
  if (!valueIsValid(value)) return fail("central_advisory_record_invalid");

  const payloadJson = canonicalJson(value), draft: RewardV2Draft = {
    id: `${CENTRAL_ADVISORY_PUBLICATION_PREFIX}${contentHashOf(value)}`, scope: value.scope,
    algorithmVersion: CENTRAL_ADVISORY_ALGORITHM, kind: "projection", payloadJson,
  };
  if (!isRewardV2Draft(draft)) return fail("central_advisory_record_capacity");

  return draft;
}

/** Format validation only; this does not authenticate an applied decision. */
export function readCentralAdvisoryDraft(draft: RewardV2Draft): CentralAdvisoryValue {
  let value: unknown;
  try { value = JSON.parse(draft.payloadJson); } catch { return fail("central_advisory_record_corrupt"); }
  if (!valueIsValid(value)) return fail("central_advisory_record_corrupt");
  const expected = buildCentralAdvisoryRecord(value);
  if (canonicalJson(draft) !== canonicalJson(expected)) return fail("central_advisory_record_corrupt");
  return value;
}

export function readCentralAdvisoryRecords(facts: readonly RewardV2Fact[], scope: string, boardSequence: number): readonly CentralAdvisoryRecord[] {
  if (!coordinationScopeValid(scope)) return fail("central_advisory_scope_invalid");

  if (!sequence(boardSequence) || !Array.isArray(facts) || !facts.every(isRewardV2Fact) || !validRewardV2Prefix(facts, boardSequence)) {
    return fail("central_advisory_prefix_invalid");
  }

  const records = facts.filter(fact => fact.scope === scope && fact.algorithmVersion === CENTRAL_ADVISORY_ALGORITHM).map(fact => {
    let value: unknown;

    try { value = JSON.parse(fact.payloadJson); }
    catch { return fail("central_advisory_record_corrupt"); }

    if (!fields(fact, ["id", "scope", "algorithmVersion", "kind", "payloadJson", "sequence"]) || !valueIsValid(value)
      || value.scope !== scope || value.appliedSequence >= fact.sequence) return fail("central_advisory_record_corrupt");

    const rebuilt = buildCentralAdvisoryRecord(value);
    if (fact.id !== rebuilt.id || fact.kind !== rebuilt.kind || fact.payloadJson !== rebuilt.payloadJson) return fail("central_advisory_record_corrupt");

    return { ref: fact.id, version: fact.id, sequence: fact.sequence, value };
  });
  const decisions = new Map<string, string>();

  for (const record of records) {
    const key = canonicalJson([record.value.advisoryId, record.value.appliedSequence]), prior = decisions.get(key);
    if (prior !== undefined && prior !== record.ref) return fail("central_advisory_decision_conflict");
    decisions.set(key, record.ref);
  }

  return records;
}

type Published = CentralAdvisoryRecord & { readonly value: CentralAdvisoryPublish };

function publicationLinks(records: readonly CentralAdvisoryRecord[], publications: ReadonlyMap<string, Published>): void {
  for (const record of records) {
    const value = record.value, prior = value.previousPublicationRef === null ? undefined : publications.get(value.previousPublicationRef);
    if (value.previousPublicationRef !== null && (prior === undefined || prior.value.advisoryId !== value.advisoryId
      || prior.value.appliedSequence > value.appliedSequence)) return fail("central_advisory_chain_invalid");

    if (value.kind !== "withdraw") continue;

    const target = publications.get(value.publicationRef);
    if (target === undefined || target.value.advisoryId !== value.advisoryId
      || target.value.appliedSequence > value.appliedSequence || value.previousPublicationRef !== value.publicationRef) return fail("central_advisory_chain_invalid");
  }
}

/** Source status only; accessSourceRefs still require the original source-owner gate. */
export function resolveCentralAdvisoryPublications(input: {
  readonly facts: readonly RewardV2Fact[]; readonly scope: string; readonly boardSequence: number;
}): readonly CentralAdvisoryPublicationView[] {
  const records = readCentralAdvisoryRecords(input.facts, input.scope, input.boardSequence);
  const publications = new Map<string, Published>();

  for (const record of records) if (record.value.kind === "publish") publications.set(record.ref, { ...record, value: record.value });

  publicationLinks(records, publications);
  const snapshots = readCentralRuntimePrefix(input.facts, input.scope, input.boardSequence);
  const byStateRef = new Map(snapshots.map(row => [row.factRef, row]));
  const sequences = new Map(input.facts.map(fact => [fact.id, fact.sequence]));
  const purposes = new Map<string, CentralLearningIntentDraft>();
  const versions = new Map<string, { readonly sequence: number; readonly intent: CentralLearningIntentDraft }[]>();

  for (const snapshot of snapshots) for (const intent of snapshot.state.intents) {
    purposes.set(intent.intentId, intent);
    const rows = versions.get(intent.intentId) ?? [];
    const previous = rows.at(-1);
    if (previous !== undefined && canonicalJson(previous.intent) === canonicalJson(intent)) continue;
    rows.push({ sequence: sequences.get(snapshot.factRef)!, intent });
    versions.set(intent.intentId, rows);
  }

  const latest = new Map<string, CentralAdvisoryRecord>(), withdrawn = new Set<string>();

  for (const record of [...records].sort((a, b) => a.value.appliedSequence - b.value.appliedSequence || a.sequence - b.sequence)) {
    latest.set(record.value.advisoryId, record);
    if (record.value.kind === "withdraw") withdrawn.add(record.value.publicationRef);
  }

  return [...publications.values()].map(record => {
    const value = record.value, head = latest.get(value.advisoryId), purpose = purposes.get(value.intentId);
    let status: CentralAdvisoryStatus;

    if (withdrawn.has(record.ref)) status = "publication_withdrawn";
    else if (head?.ref !== record.ref) status = "superseded";
    else if (purpose?.continuation.kind === "ended" && purpose.continuation.goalState === "withdrawn") status = "purpose_withdrawn";
    else {
      const original = byStateRef.get(value.purposeHeadRef)?.state.intents.find(row => row.intentId === value.intentId);
      // Compaction does not withdraw an original purpose. Its latest native
      // body at the applied checkpoint need not reenter the bounded working set.
      const applied = versions.get(value.intentId)?.filter(row => row.sequence <= value.appliedSequence).at(-1)?.intent;
      const contains = (intent: CentralLearningIntentDraft | undefined) => intent !== undefined
        && canonicalJson(intent.conditions) === canonicalJson(value.purposeConditions)
        && intent.knowledge.some(entry => centralAdvisoryKnowledgeHash(entry) === value.knowledgeHash);

      status = contains(original) && contains(applied) && contains(purpose)
        && sequences.get(value.appliedStateRef) === value.appliedSequence
        && byStateRef.has(value.appliedStateRef)
        && (sequences.get(value.purposeHeadRef) ?? Infinity) <= value.appliedSequence ? "current" : "source_changed";
    }

    return { id: value.advisoryId, version: record.ref, purposeHeadRef: value.purposeHeadRef, purposeConditions: value.purposeConditions, intentId: value.intentId,
      knowledgeHash: value.knowledgeHash, statement: value.statement, conditions: value.conditions, whenRelevant: value.whenRelevant,
      uncertainty: value.uncertainty, sourceRefs: value.sourceRefs, accessSourceRefs: value.accessSourceRefs, status,
      sequence: record.sequence, decisionRef: value.decisionRef, deliveryRef: value.deliveryRef };
  });
}

export function lookupCentralAdvisories(board: BoardState, scope: string): readonly CentralAdvisoryPublicationView[] {
  return resolveCentralAdvisoryPublications({ facts: board.rewardV2Facts ?? [], scope, boardSequence: board.sequence })
    .filter(view => view.status === "current");
}

export function readCentralAdvisory(board: BoardState, scope: string, address: {
  readonly ref: string; readonly version: string;
}): CentralAdvisoryPublicationView | undefined {
  if (!advisoryRef(address.ref) || !publicationRef(address.version)) return fail("central_advisory_address_invalid");
  return resolveCentralAdvisoryPublications({ facts: board.rewardV2Facts ?? [], scope, boardSequence: board.sequence })
    .find(view => view.id === address.ref && view.version === address.version);
}
