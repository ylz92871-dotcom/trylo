import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { isRewardV2Draft, isRewardV2Fact, validRewardV2Prefix, type RewardV2Draft, type RewardV2Fact } from "../../reward/v2-facts.js";
import { fields, identity, sequence, text } from "../../../validation/json-shape.js";
import type { CentralCompletedOperation, CentralLearningIntentDraft, CentralLearningOperation, CentralLearningRuntimeState, CentralRuntimeMaterial, CentralRuntimeWork } from "./contracts.js";
import { isCentralLearningRuntimeState, isCentralRuntimeReferences } from "./validation.js";
import { canonicalReadAddress, readFailureConditionKey, readFailureReceipt, type ReadFailureReceipt } from "./read-failure.js";
import { isProviderRecoveryUpdate, sameProviderPositiveAdmission, type ProviderPositiveAdmission, type ProviderRecoveryUpdate } from "./provider-positive.js";
import { CENTRAL_RUNTIME_MATERIAL_ALGORITHM, readCentralRuntimeMaterialRecord } from "./material-record.js";

export const CENTRAL_RUNTIME_ALGORITHM = "central-learning-runtime-v1";

export interface CentralOpportunityConsideration {
  readonly operationId: string;
  readonly deliveryRef: string;
  readonly resultRef: string;
  /** Addresses in the immutable returned request's actual opportunities only. */
  readonly sourceRefs: readonly string[];
}

export interface CentralRuntimeRecordInput {
  readonly previousRef: string;
  readonly state: CentralLearningRuntimeState;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  /** Host receipt metadata; never part of state, model wire or read progress. */
  readonly opportunityConsideration?: CentralOpportunityConsideration;
  /** Host-only admission/retirement metadata at the original checkpoint writer. */
  readonly providerRecoveryUpdate?: ProviderRecoveryUpdate;
}

export interface CentralRuntimeRead {
  readonly revision: number;
  readonly stateRef: string;
  readonly state: CentralLearningRuntimeState;
  readonly history: CentralRuntimeHistory;
}

export interface CentralRuntimeHistory {
  /** Latest semantic heads from the verified original chain. Hashes bind full
   * purpose bodies without copying them into another ledger or model input. */
  readonly purposeHeads?: readonly { readonly intentId: string; readonly factRef: string; readonly scope: string;
    readonly intentHash: string; readonly kind: CentralLearningIntentDraft["continuation"]["kind"];
    readonly goalState?: "open" | "answered" | "withdrawn" }[];
  readonly operations: readonly { readonly operationId: string; readonly signature: string; readonly factRef: string; readonly intentId: string }[];
  /** Derived from original completed facts, never a second persisted ledger. */
  readonly readFailures?: readonly { readonly factRef: string; readonly receipt: ReadFailureReceipt }[];
  readonly materials: readonly { readonly ref: string; readonly factRef: string; readonly sequence?: number }[];
  readonly endedIntents: readonly { readonly intentId: string; readonly factRef: string; readonly subject: CentralLearningIntentDraft["subject"];
    readonly goalState?: "open" | "answered" | "withdrawn"; readonly goal?: string; readonly sourceRefs?: readonly string[] }[];
  readonly consumedSourceRefs: readonly string[];
  /** Unconfirmed semantic attempts fence source rediscovery, not proof of reading. */
  readonly pendingSemanticSourceRefs?: readonly string[];
  /** Addresses in an actual successful complete-agenda input. They may still be
   * unread and never become delivery acknowledgements through this index. */
  readonly consideredSourceRefs?: readonly string[];
  /** Original receipt locators bound to a newly returned complete agenda.
   * Adapters must still verify the receipt before deriving source versions. */
  readonly consideredDeliveries?: readonly (CentralOpportunityConsideration & { readonly factRef: string; readonly sequence: number })[];
  /** First immutable admission facts survive working-set compaction. */
  readonly providerPositiveAdmissions?: readonly { readonly admission: ProviderPositiveAdmission; readonly factRef: string; readonly sequence: number }[];
  /** Monotone host retirement evidence; never changes an old operation outcome or fee. */
  readonly retiredProviderWaitRefs?: readonly string[];
  readonly choiceFrontiers?: readonly { readonly intentId: string; readonly choiceHash: string;
    readonly operationId: string | null; readonly signature: string | null; readonly sourceRefs: readonly string[] }[];
}

export type CentralRuntimeLookup =
  | { readonly kind: "completed"; readonly operationId: string; readonly factRef?: string }
  | { readonly kind: "material"; readonly ref: string; readonly factRef?: string }
  | { readonly kind: "ended_intent"; readonly intentId: string; readonly factRef?: string };

export type CentralRuntimeLookupResult = { readonly status: "missing" }
  | { readonly status: "found"; readonly factRef: string; readonly value: CentralCompletedOperation | CentralRuntimeMaterial | CentralLearningIntentDraft };

type SnapshotSource = { readonly factRef: string; readonly payloadJson: string };

/** The complete original prefix is verified before these locators are exposed.
 * Keep immutable bytes, not every decoded historical working set, resident. */
function snapshotState(source: SnapshotSource): CentralLearningRuntimeState {
  return (JSON.parse(source.payloadJson) as { state: CentralLearningRuntimeState }).state;
}

type PurposeRecord = { readonly factRef: string; readonly intent: CentralLearningIntentDraft };

type CompletedRecord = { readonly factRef: string; readonly completed: CentralCompletedOperation; readonly work?: CentralRuntimeWork };

/** Exact operation meaning excludes its caller-selected ID; archival and live guards share this definition. */
export function centralOperationSignature(operation: CentralLearningOperation): string {
  const { operationId: _id, ...meaning } = operation;
  return contentHashOf(meaning);
}

/** Compaction may remove ended work, never the only recoverable copy of an unfinished intent/work. */
export function assertCentralRuntimeSnapshotTransition(previous: CentralLearningRuntimeState, next: CentralLearningRuntimeState): void {
  if (previous.intents.some(intent => intent.continuation.kind !== "ended" && !next.intents.some(row => row.intentId === intent.intentId))) {
    throw new Error("central_runtime_unfinished_intent_removed");
  }

  if (previous.running.some(work => !next.running.some(row => row.workRef === work.workRef)
    && !next.completed.some(row => row.operation.operationId === work.operation.operationId))) throw new Error("central_runtime_unresolved_work_removed");

  const pending = previous.agendaRead;
  if (pending !== undefined && canonicalJson(next.agendaRead ?? null) !== canonicalJson(pending)
    && !next.completed.some(row => row.intentId === "central:agenda" && row.outcome !== "unknown"
      && canonicalJson(row.operation) === canonicalJson(pending))) throw new Error("central_runtime_unresolved_agenda_read_removed");
}

export function emptyCentralRuntimeState(scope: string): CentralLearningRuntimeState {
  if (!identity(scope)) throw new Error("central_runtime_scope_invalid");
  return { schemaVersion: 1, scope, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] };
}

export function initialCentralRuntimeRef(scope: string): string {
  return `central-runtime-empty:${contentHashOf(emptyCentralRuntimeState(scope))}`;
}

function isConsideration(value: unknown): value is CentralOpportunityConsideration {
  return fields(value, ["operationId", "deliveryRef", "resultRef", "sourceRefs"]) && identity(value.operationId)
    && identity(value.deliveryRef) && identity(value.resultRef) && isCentralRuntimeReferences(value.sourceRefs);
}

function isInput(value: unknown): value is CentralRuntimeRecordInput {
  const extra = ["opportunityConsideration", "providerRecoveryUpdate"].filter(key => typeof value === "object" && value !== null && Object.hasOwn(value, key));
  return fields(value, ["previousRef", "state", "reason", "sourceRefs", ...extra]) && identity(value.previousRef)
    && isCentralLearningRuntimeState(value.state) && text(value.reason, 32768)
    && isCentralRuntimeReferences(value.sourceRefs)
    && (!Object.hasOwn(value, "opportunityConsideration") || isConsideration(value.opportunityConsideration))
    && (!Object.hasOwn(value, "providerRecoveryUpdate") || isProviderRecoveryUpdate(value.providerRecoveryUpdate));
}

/** A complete immutable snapshot at the original Board. It creates no balance, claim or permission. */
export function buildCentralRuntimeRecord(input: CentralRuntimeRecordInput): RewardV2Draft {
  if (!isInput(input)) throw new Error("central_runtime_record_invalid");
  const payloadJson = canonicalJson({ schemaVersion: 1, type: "central_learning_runtime_state", ...input });
  const fact: RewardV2Draft = { id: `central-runtime-state:${contentHashOf(payloadJson)}`, scope: input.state.scope,
    algorithmVersion: CENTRAL_RUNTIME_ALGORITHM, kind: "projection", payloadJson };
  if (!isRewardV2Draft(fact)) throw new Error("central_runtime_record_capacity");
  return fact;
}

/** A scope has exactly one predecessor chain. Forks, edited old heads and unknown schemas fail closed. */
function replayOriginal(facts: readonly RewardV2Fact[], scope: string, boardSequence: number, includeCompleted = false) {
  let state = emptyCentralRuntimeState(scope), stateRef = initialCentralRuntimeRef(scope);
  const snapshots: SnapshotSource[] = [], operations = new Map<string, CentralRuntimeHistory["operations"][number]>();
  const materials = new Map<string, { readonly factRef: string; readonly sequence: number; readonly material: CentralRuntimeMaterial }>();
  const pendingSemantic = new Map<string, readonly string[]>();
  const consideredSourceRefs = new Set<string>();
  const consideredDeliveries: NonNullable<CentralRuntimeHistory["consideredDeliveries"]>[number][] = [];
  const providerPositiveAdmissions = new Map<string, NonNullable<CentralRuntimeHistory["providerPositiveAdmissions"]>[number]>();
  const admittedProviderWaits = new Map<string, number>(), retiredProviderWaitRefs = new Set<string>();
  const choiceFrontiers = new Map<string, Omit<NonNullable<CentralRuntimeHistory["choiceFrontiers"]>[number], "sourceRefs"> & { sourceRefs: Set<string> }>();
  const semanticOutcomes = new Map<string, { readonly outcome: CentralCompletedOperation["outcome"]; readonly issuedSequence: number }>();
  let lastAgendaSequence = 0;
  const endedIntents = new Map<string, CentralRuntimeHistory["endedIntents"][number]>(), consumedSourceRefs = new Set<string>();
  const purposeHeads = new Map<string, PurposeRecord>();
  const originalWork = new Map<string, CentralRuntimeWork>(), completedHeads = new Map<string, CompletedRecord>();
  const readFailures = new Map<string, NonNullable<CentralRuntimeHistory["readFailures"]>[number]>();

  if (!sequence(boardSequence) || !Array.isArray(facts) || !facts.every(isRewardV2Fact) || !validRewardV2Prefix(facts, boardSequence)) {
    throw new Error("central_runtime_prefix_invalid");
  }

  for (const fact of facts) {
    if (fact.scope !== scope) continue;

    if (fact.algorithmVersion === CENTRAL_RUNTIME_MATERIAL_ALGORITHM) {
      const material = readCentralRuntimeMaterialRecord(fact), prior = materials.get(material.ref);
      if (prior !== undefined && canonicalJson(prior.material) !== canonicalJson(material)) throw new Error("central_runtime_material_identity_conflict");
      if (prior === undefined) materials.set(material.ref, { factRef: fact.id, sequence: fact.sequence, material });
      continue;
    }

    if (fact.algorithmVersion !== CENTRAL_RUNTIME_ALGORITHM) continue;

    if (!fields(fact, ["id", "scope", "algorithmVersion", "kind", "payloadJson", "sequence"])) throw new Error("central_runtime_record_corrupt");

    let raw: unknown;

    try { raw = JSON.parse(fact.payloadJson); }
    catch { throw new Error("central_runtime_record_corrupt"); }

    const extra = ["opportunityConsideration", "providerRecoveryUpdate"].filter(key => typeof raw === "object" && raw !== null && Object.hasOwn(raw, key));
    if (!fields(raw, ["schemaVersion", "type", "previousRef", "state", "reason", "sourceRefs", ...extra])
      || raw.schemaVersion !== 1 || raw.type !== "central_learning_runtime_state") throw new Error("central_runtime_record_corrupt");

    const input = { previousRef: raw.previousRef, state: raw.state, reason: raw.reason, sourceRefs: raw.sourceRefs,
      ...(Object.hasOwn(raw, "opportunityConsideration") ? { opportunityConsideration: raw.opportunityConsideration } : {}),
      ...(Object.hasOwn(raw, "providerRecoveryUpdate") ? { providerRecoveryUpdate: raw.providerRecoveryUpdate } : {}) };
    if (!isInput(input) || input.state.scope !== scope || input.previousRef !== stateRef) throw new Error("central_runtime_chain_corrupt");

    const rebuilt = buildCentralRuntimeRecord(input);
    if (fact.kind !== rebuilt.kind || fact.id !== rebuilt.id || fact.payloadJson !== rebuilt.payloadJson) throw new Error("central_runtime_record_corrupt");

    assertCentralRuntimeSnapshotTransition(state, input.state);
    const agendaThoughts = input.reason === "central_deliberation_returned" ? input.state.completed.filter(row => row.operation.kind === "think"
      && row.outcome === "returned" && semanticOutcomes.get(row.operation.operationId)?.outcome !== "returned") : [];

    if (input.opportunityConsideration !== undefined) {
      const consideration = input.opportunityConsideration;
      if (agendaThoughts.length !== 1 || agendaThoughts[0]!.operation.operationId !== consideration.operationId
        || !agendaThoughts[0]!.resultRefs.includes(consideration.resultRef)) throw new Error("central_runtime_opportunity_consideration_binding");
      for (const ref of consideration.sourceRefs) consideredSourceRefs.add(ref);
      consideredDeliveries.push({ ...consideration, factRef: fact.id, sequence: fact.sequence });
    }

    // A persisted agenda read is an issued operation identity, not a completed
    // receipt. Keep it in the original identity index before its source read.
    const agenda = input.state.agendaRead;

    for (const operation of [...input.state.completed, ...input.state.running,
      ...(agenda === undefined ? [] : [{ intentId: "central:agenda", operation: agenda }])]) {
      const { operationId } = operation.operation, signature = centralOperationSignature(operation.operation), prior = operations.get(operationId);
      if (prior !== undefined && (prior.signature !== signature || prior.intentId !== operation.intentId)) throw new Error("central_runtime_operation_identity_conflict");
      operations.set(operationId, { operationId, signature, factRef: fact.id, intentId: operation.intentId });
    }

    const recoveryUpdate = input.providerRecoveryUpdate;
    if (recoveryUpdate?.admission !== undefined) {
      const admission = recoveryUpdate.admission, prior = providerPositiveAdmissions.get(admission.ref);
      if (prior !== undefined) {
        if (!sameProviderPositiveAdmission(prior.admission, admission)) throw new Error("central_runtime_provider_admission_identity_conflict");
      } else {
        const operation = input.state.completed.find(row => row.operation.operationId === admission.operationId);
        if (admission.scope !== scope || admission.observedBoardSequence >= fact.sequence
          || input.reason !== "central_deliberation_issued" || operation?.operation.kind !== "think" || operation.outcome !== "unknown"
          || centralOperationSignature(operation.operation) !== admission.operationSignature) throw new Error("central_runtime_provider_admission_binding");

        const previousAdmissionSequence = admittedProviderWaits.get(admission.waitRef);
        if (retiredProviderWaitRefs.has(admission.waitRef)
          || previousAdmissionSequence !== undefined && admission.observedBoardSequence <= previousAdmissionSequence) {
          throw new Error("central_runtime_provider_wait_evidence_not_newer");
        }

        providerPositiveAdmissions.set(admission.ref, { admission, factRef: fact.id, sequence: fact.sequence });
        admittedProviderWaits.set(admission.waitRef, fact.sequence);
      }
    }

    for (const ref of recoveryUpdate?.retiredWaitRefs ?? []) retiredProviderWaitRefs.add(ref);

    // The first original running frame precedes its completion. Retaining it in
    // this verified pass prevents later mutable grant plans from erasing lineage.
    if (includeCompleted) {
      for (const work of input.state.running) if (!originalWork.has(work.operation.operationId)) originalWork.set(work.operation.operationId, work);
      for (const completed of input.state.completed) {
        const operationId = completed.operation.operationId, prior = completedHeads.get(operationId);
        if (prior !== undefined && canonicalJson(prior.completed) === canonicalJson(completed)) continue;

        const work = prior?.work ?? originalWork.get(operationId);

        completedHeads.delete(operationId);
        completedHeads.set(operationId, { factRef: fact.id, completed,
          ...(work !== undefined && work.intentId === completed.intentId
            && canonicalJson(work.operation) === canonicalJson(completed.operation) ? { work } : {}) });
      }
    }

    for (const completed of input.state.completed) {
      if (completed.operation.kind === "read" && completed.outcome === "failed" && completed.resultRefs.length === 0) {
        const receipt = readFailureReceipt(completed.publicResult);
        if (receipt?.scope === scope) {
          const targets = new Set(completed.operation.refs.map(canonicalReadAddress));
          if (receipt.targetCount === targets.size && receipt.targets.every(target => targets.has(target.address))) {
            const key = readFailureConditionKey(receipt);
            if (!readFailures.has(key)) readFailures.set(key, { factRef: fact.id, receipt });
          }
        }
      }

      if (completed.operation.kind !== "think") continue;

      const operationId = completed.operation.operationId, prior = semanticOutcomes.get(operationId);
      if (prior?.outcome === completed.outcome) continue;

      const issuedSequence = prior?.issuedSequence ?? fact.sequence;

      semanticOutcomes.set(operationId, { outcome: completed.outcome, issuedSequence });

      if (completed.outcome === "returned" || issuedSequence <= lastAgendaSequence) pendingSemantic.delete(operationId);
      else pendingSemantic.set(operationId, completed.operation.sourceRefs);
    }

    // A newly committed complete agenda supersedes old communication fences.
    // Original outcomes, conservative fees and operation identities stay intact.
    // Recovering an old receipt without applying its agenda only clears that op.
    if (input.reason === "central_deliberation_returned") {
      pendingSemantic.clear();
      lastAgendaSequence = fact.sequence;
    }

    if (agendaThoughts.length === 1) {
      const addressed = agendaThoughts[0]!.operation.sourceRefs;

      for (const ref of addressed) consideredSourceRefs.add(ref);

      for (const intent of input.state.intents) {
        const choice = intent.continuation, prior = choiceFrontiers.get(intent.intentId);
        const sources = prior?.sourceRefs ?? new Set<string>();
        for (const ref of addressed) sources.add(ref);
        choiceFrontiers.set(intent.intentId, { intentId: intent.intentId, choiceHash: contentHashOf(choice),
          operationId: choice.kind === "ready" ? choice.operation.operationId : null,
          signature: choice.kind === "ready" ? centralOperationSignature(choice.operation) : null,
          sourceRefs: sources });
      }
    } else {
      for (const [intentId, frontier] of choiceFrontiers) {
        const intent = input.state.intents.find(row => row.intentId === intentId);
        if (intent === undefined || contentHashOf(intent.continuation) === frontier.choiceHash) continue;

        const completed = input.state.completed.find(row => row.intentId === intentId && row.operation.operationId === frontier.operationId
          && centralOperationSignature(row.operation) === frontier.signature);
        const refs = completed === undefined ? [] : [`central-operation-result:${contentHashOf(completed)}`, ...completed.resultRefs];
        const choice = intent.continuation;
        const interpretation = completed !== undefined && choice.kind === "ready" && choice.operation.kind === "think"
          && choice.operation.operationId === `central-interpret:${contentHashOf([completed.operation.operationId, refs])}`
          && canonicalJson(choice.operation.sourceRefs) === canonicalJson(refs);
        const running = input.state.running.some(work => work.intentId === intentId && work.operation.operationId === frontier.operationId
          && centralOperationSignature(work.operation) === frontier.signature);
        const issued = input.reason === "central_deliberation_issued" && completed?.outcome === "unknown";
        if (interpretation || running || issued) choiceFrontiers.set(intentId, { ...frontier, choiceHash: contentHashOf(choice),
          operationId: interpretation && choice.kind === "ready" ? choice.operation.operationId : frontier.operationId,
          signature: interpretation && choice.kind === "ready" ? centralOperationSignature(choice.operation) : frontier.signature });
        else choiceFrontiers.delete(intentId);
      }
    }

    for (const material of input.state.materials) {
      const prior = materials.get(material.ref);
      if (prior !== undefined && canonicalJson(prior.material) !== canonicalJson(material)) throw new Error("central_runtime_material_identity_conflict");
      if (prior === undefined) materials.set(material.ref, { factRef: fact.id, sequence: fact.sequence, material });
    }

    for (const intent of input.state.intents) {
      const prior = purposeHeads.get(intent.intentId);

      // Carrying the same body through bookkeeping/compaction is not a revision.
      // History guards and navigation must name the same actual source body.
      if (prior !== undefined && canonicalJson(prior.intent) === canonicalJson(intent)) continue;

      purposeHeads.delete(intent.intentId);
      purposeHeads.set(intent.intentId, { factRef: fact.id, intent });

      if (intent.continuation.kind !== "ended") continue;

      endedIntents.set(intent.intentId, { intentId: intent.intentId, factRef: fact.id, subject: intent.subject,
        goalState: intent.continuation.goalState, goal: intent.goal, sourceRefs: intent.sourceRefs });
    }

    for (const ref of input.state.consumedSourceRefs) consumedSourceRefs.add(ref);

    state = input.state;
    stateRef = fact.id;
    snapshots.push({ factRef: fact.id, payloadJson: fact.payloadJson });
  }

  const history: CentralRuntimeHistory = { operations: [...operations.values()], materials: [...materials].map(([ref, row]) => ({ ref, factRef: row.factRef, sequence: row.sequence })),
    purposeHeads: [...purposeHeads.values()].map(row => ({ intentId: row.intent.intentId, factRef: row.factRef, scope,
      intentHash: contentHashOf(row.intent), kind: row.intent.continuation.kind,
      ...(row.intent.continuation.kind === "ended" && row.intent.continuation.goalState !== undefined
        ? { goalState: row.intent.continuation.goalState } : {}) })),
    readFailures: [...readFailures.values()],
    endedIntents: [...endedIntents.values()], consumedSourceRefs: [...consumedSourceRefs],
    consideredSourceRefs: [...consideredSourceRefs], consideredDeliveries,
    providerPositiveAdmissions: [...providerPositiveAdmissions.values()], retiredProviderWaitRefs: [...retiredProviderWaitRefs],
    choiceFrontiers: [...choiceFrontiers.values()].map(row => ({ ...row, sourceRefs: [...row.sourceRefs] })),
    pendingSemanticSourceRefs: [...new Set([...pendingSemantic.values()].flat())] };

  return { snapshot: { revision: boardSequence, stateRef, state, history }, snapshots,
    materialIndex: [...materials.values()],
    allPurposeHeads: [...purposeHeads.values()].reverse(),
    purposeIndex: [...purposeHeads.values()].reverse().filter(row => row.intent.continuation.kind === "ended"),
    completedIndex: [...completedHeads.values()].reverse() };
}

type RuntimeReplay = ReturnType<typeof replayOriginal>;

type RuntimeReplayMemo = { readonly facts: readonly RewardV2Fact[]; readonly value: RuntimeReplay; readonly bytes: number };

const replayMemo = new Map<string, RuntimeReplayMemo>();
const REPLAY_MEMO_BYTES = 256 * 1024 * 1024;
const factFields = ["id", "scope", "algorithmVersion", "kind", "payloadJson", "sequence"] as const;

/** Reuse a verified, byte-identical lifetime prefix, never a revision number or
 * an address alone. The memo owns its scalar fact copies and parsed result;
 * public readers below return independent values. A changed prefix takes the
 * complete original validation/chain path, including prospective CAS writes. */
function replay(facts: readonly RewardV2Fact[], scope: string, boardSequence: number) {
  const prior = replayMemo.get(scope);
  if (prior !== undefined && sequence(boardSequence) && Array.isArray(facts)
    && facts.length === prior.facts.length && facts.every((fact, index) => {
      const original = prior.facts[index]!;
      return fields(fact, factFields) && sequence(fact.sequence) && fact.sequence <= boardSequence
        && factFields.every(key => fact[key] === original[key]);
    })) {
    replayMemo.delete(scope);
    replayMemo.set(scope, prior);
    return { ...prior.value, snapshot: { ...prior.value.snapshot, revision: boardSequence } };
  }

  replayMemo.delete(scope);
  // Build the optional original-completion index once as well, so history and
  // current-state readers share the same verified prefix rather than replaying
  // it separately for each projection.
  const value = replayOriginal(facts, scope, boardSequence, true);
  const bytes = 2 * facts.reduce((total, fact) => total + fact.payloadJson.length
    * (fact.scope === scope && fact.algorithmVersion === CENTRAL_RUNTIME_ALGORITHM ? 2 : 1), 0);
  // Keep the current verified prefix even when it alone exceeds the retention
  // budget. Evict the other entries first; crossing a cache estimate must not
  // disable reuse and replay the whole lifetime for every synchronous reader.
  if (facts.every(fact => fields(fact, factFields))) {
    while (replayMemo.size >= 2 || [...replayMemo.values()].reduce((total, entry) => total + entry.bytes, bytes) > REPLAY_MEMO_BYTES) {
      const oldest = replayMemo.keys().next().value;
      if (oldest === undefined) break;
      replayMemo.delete(oldest);
    }
    replayMemo.set(scope, { facts: facts.map(fact => ({ ...fact })), value, bytes });
  }

  return value;
}

export function readCentralRuntimeRecords(facts: readonly RewardV2Fact[], scope: string, boardSequence: number): CentralRuntimeRead {
  return structuredClone(replay(facts, scope, boardSequence).snapshot);
}

/** Read-only historical versions from one verified same-scope replay. Readers
 * may select original purpose bodies without copying persistence decoding or
 * repeatedly replaying the Board once per candidate. */
export function readCentralRuntimePrefix(facts: readonly RewardV2Fact[], scope: string, boardSequence: number):
  readonly { readonly factRef: string; readonly state: CentralLearningRuntimeState }[] {
  return replay(facts, scope, boardSequence).snapshots.map(source => ({ factRef: source.factRef,
    get state() { return snapshotState(source); } }));
}

/** Every retained original purpose head, including open/ready/waiting bodies.
 * Unlike ended-purpose navigation, this is an exact same-scope ownership read;
 * compaction preserves the original locator and never resumes an investment. */
export function readCentralRuntimePurposeHeads(facts: readonly RewardV2Fact[], scope: string, boardSequence: number):
  readonly { readonly factRef: string; readonly intent: CentralLearningIntentDraft }[] {
  return structuredClone(replay(facts, scope, boardSequence).allPurposeHeads);
}

/** Batch original completed bodies from one verified replay, including work no
 * longer retained in the compact current state. Bookkeeping snapshots do not
 * revise an unchanged completion or its original fact locator. An optional work
 * is its earlier original running frame, not a reconstruction from current jobs. */
export function readCentralRuntimeCompletedIndex(facts: readonly RewardV2Fact[], scope: string, boardSequence: number):
  readonly CompletedRecord[] {
  return structuredClone(replay(facts, scope, boardSequence).completedIndex);
}

/** Navigation over the original verified runtime chain, not a second memory.
 * A later resumed intent replaces its old ended entry. Compaction leaves the
 * latest original body addressable without putting every body in model context. */
export function readCentralRuntimePurposeIndex(facts: readonly RewardV2Fact[], scope: string, boardSequence: number):
  readonly { readonly factRef: string; readonly intent: CentralLearningIntentDraft }[] {
  return structuredClone(replay(facts, scope, boardSequence).purposeIndex);
}

/** Resolve an immutable advertised body in the verified original chain, including
 * historical snapshot locators issued before unchanged bodies kept stable heads.
 * This source read confers no right to resume; current ended/withdrawn guards do. */
export function lookupCentralRuntimePurposeRecord(facts: readonly RewardV2Fact[], scope: string, boardSequence: number,
  recordKey: string): PurposeRecord | undefined {
  if (!/^[a-f0-9]{64}$/.test(recordKey)) return undefined;

  for (const row of replay(facts, scope, boardSequence).snapshots) {
    const intent = snapshotState(row).intents.find(item => item.continuation.kind === "ended"
      && contentHashOf([item.intentId, row.factRef]) === recordKey);
    if (intent !== undefined) return structuredClone({ factRef: row.factRef, intent });
  }

  return undefined;
}

/** Exact locators return original public content. No similarity fallback or alternate state writer. */
export function lookupCentralRuntimeRecord(facts: readonly RewardV2Fact[], scope: string, boardSequence: number,
  query: CentralRuntimeLookup): CentralRuntimeLookupResult {
  const result = lookupCentralRuntimeRecords(facts, scope, boardSequence, [query])[0];
  if (result === undefined) throw new Error("central_runtime_lookup_invalid");
  return result;
}

/** Resolve an ordered batch from one verified original chain, without a persistent index. */
export function lookupCentralRuntimeRecords(facts: readonly RewardV2Fact[], scope: string, boardSequence: number,
  queries: readonly CentralRuntimeLookup[]): readonly CentralRuntimeLookupResult[] {
  for (const query of queries) {
    const key = query.kind === "completed" ? "operationId" : query.kind === "material" ? "ref" : query.kind === "ended_intent" ? "intentId" : null;
    const target = query.kind === "completed" ? query.operationId : query.kind === "material" ? query.ref : query.intentId;
    if (key === null || !fields(query, ["kind", key, ...(Object.hasOwn(query, "factRef") ? ["factRef"] : [])])
      || !isCentralRuntimeReferences([target]) || Object.hasOwn(query, "factRef") && !identity(query.factRef)) throw new Error("central_runtime_lookup_invalid");
  }

  const original = replay(facts, scope, boardSequence), snapshots = [...original.snapshots].reverse();

  return queries.map((query): CentralRuntimeLookupResult => {
    if (query.kind === "material") {
      const row = original.materialIndex.find(row => row.factRef.startsWith("central-runtime-material:") && row.material.ref === query.ref
        && (query.factRef === undefined || query.factRef === row.factRef));
      if (row !== undefined) return structuredClone({ status: "found", factRef: row.factRef, value: row.material });
    }

    for (const row of snapshots) {
      if (query.factRef !== undefined && row.factRef !== query.factRef) continue;
      const state = snapshotState(row);
      const value = query.kind === "completed" ? state.completed.find(item => item.operation.operationId === query.operationId)
        : query.kind === "material" ? state.materials.find(item => item.ref === query.ref)
          : state.intents.find(item => item.intentId === query.intentId && item.continuation.kind === "ended");
      if (value !== undefined) return structuredClone({ status: "found", factRef: row.factRef, value });
    }

    return { status: "missing" };
  });
}
