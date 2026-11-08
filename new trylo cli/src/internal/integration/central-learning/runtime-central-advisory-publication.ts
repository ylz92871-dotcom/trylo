import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimePurposeHeads } from "../../learning/central/runtime/records.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { createRewardV2BoardPort, type RewardV2BoardPort } from "../reward/v2-board-port.js";
import { isContentValueCredentialSafe } from "../learning-content/content-confidentiality-leaf.js";
import { readAppliedCentralAdvisoryDecisions, type AppliedCentralAdvisoryDecision } from "./central-advisory-applied-decisions.js";
import { CENTRAL_ADVISORY_TYPE, type CentralAdvisoryPublish, type CentralAdvisoryRecord } from "./central-advisory-contracts.js";
import { buildCentralAdvisoryRecord, centralAdvisoryId, centralAdvisoryKnowledgeHash, readCentralAdvisoryRecords } from "./central-advisory-records.js";
import { buildCentralAdvisoryResult, readCentralAdvisoryResult, type CentralAdvisoryActionResult,
  type CentralAdvisoryPublicationResult } from "./central-advisory-results.js";
import { collectCentralAdvisoryAccessSourceRefs, readCentralAdvisorySourceFailure } from "./central-advisory-source-ancestry.js";
import { buildCentralAdvisoryPreparedPlan, readCentralAdvisoryPreparedPlan } from "./central-advisory-prepared.js";
import { createCentralAdvisoryWriter } from "./central-advisory-write.js";
import { readCentralDeliberationDeliveriesFromFacts } from "./deliberation-receipts.js";

export interface RuntimeCentralAdvisoryOptions {
  readonly boardRoot: string;
  readonly scope: string;
  readonly enabled: () => boolean;
  readonly secrets?: readonly string[];
  readonly board?: RewardV2BoardPort;
  readonly access: (board: BoardState, publicationSnapshot: CentralAdvisoryPublish,
    signal: AbortSignal) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
}

const fail = (reason: string): never => { throw new Error(reason); };
const withdrawn = (intent: CentralLearningIntentDraft): boolean => intent.continuation.kind === "ended"
  && intent.continuation.goalState === "withdrawn";
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

function head(records: readonly CentralAdvisoryRecord[], id: string, before?: number): CentralAdvisoryRecord | undefined {
  return records.filter(row => row.value.advisoryId === id && (before === undefined || row.value.appliedSequence < before))
    .sort((a, b) => a.value.appliedSequence - b.value.appliedSequence || a.sequence - b.sequence).at(-1);
}

function previousPublication(records: readonly CentralAdvisoryRecord[], id: string, before: number): string | null {
  return records.filter(row => row.value.advisoryId === id && row.value.kind === "publish" && row.value.appliedSequence < before)
    .sort((a, b) => a.value.appliedSequence - b.value.appliedSequence || a.sequence - b.sequence).at(-1)?.ref ?? null;
}

/** Applies only explicit choices in an authenticated, actually applied agenda.
 * The request/body/knowledge are recovered by their native owners, not callers. */
export function createRuntimeCentralAdvisoryPublisher(options: RuntimeCentralAdvisoryOptions) {
  const board = options.board ?? createRewardV2BoardPort(options.boardRoot, options.enabled);
  const check = (signal: AbortSignal) => {
    if (signal.aborted) fail("learning_aborted");
    if (!options.enabled()) fail("collect_disabled");
  };
  const writer = createCentralAdvisoryWriter({ boardRoot: options.boardRoot, board, check });
  let queue: Promise<void> = Promise.resolve();

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function checkScope(scope: string, signal: AbortSignal): void {
    check(signal);
    if (scope !== options.scope) fail("central_advisory_scope_mismatch");
  }

  async function plan(state: BoardState, decision: AppliedCentralAdvisoryDecision, signal: AbortSignal) {
    const facts = state.rewardV2Facts ?? [], records = readCentralAdvisoryRecords(facts, options.scope, state.sequence);
    const atDecision = readCentralRuntimePurposeHeads(facts.filter(row => row.sequence <= decision.appliedSequence),
      options.scope, decision.appliedSequence);
    const current = new Map(readCentralRuntimePurposeHeads(facts, options.scope, state.sequence).map(row => [row.intent.intentId, row]));
    const actions = decision.output.knowledgeHandoffs ?? [];
    const delivery = readCentralDeliberationDeliveriesFromFacts(facts, options.scope, state.sequence, [decision.deliveryRef])[0];
    if (delivery === undefined) return fail("central_advisory_source_delivery_unconfirmed");

    const ids = actions.map(action => action.kind === "publish" ? centralAdvisoryId(options.scope, action.intentId, action.knowledgeHash)
      : records.find(row => row.ref === action.publicationRef && row.value.kind === "publish")?.value.advisoryId);
    const counts = new Map<string, number>();
    for (const id of ids) if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);

    const drafts: RewardV2Draft[] = [], results: CentralAdvisoryActionResult[] = [];

    for (const [index, action] of actions.entries()) {
      check(signal);
      const id = ids[index];
      const reject = (reason: string, status: "rejected" | "superseded" = "rejected") => {
        results.push({ index, kind: action.kind, status, publicationRef: null, reason });
      };

      if (id === undefined) {
        reject("central_advisory_publication_not_found");
        continue;
      }

      if (counts.get(id)! > 1) {
        reject("central_advisory_duplicate_action");
        continue;
      }

      const latest = head(records, id);
      if (latest !== undefined && latest.value.appliedSequence > decision.appliedSequence) {
        reject("central_advisory_newer_decision_exists", "superseded");
        continue;
      }

      const common = { schemaVersion: 1 as const, type: CENTRAL_ADVISORY_TYPE as typeof CENTRAL_ADVISORY_TYPE, scope: options.scope,
        budgetId: decision.request.budgetId, advisoryId: id, appliedStateRef: decision.appliedStateRef,
        appliedSequence: decision.appliedSequence, decisionRef: decision.decisionRef, deliveryRef: decision.deliveryRef };

      if (action.kind === "withdraw") {
        const target = records.find(row => row.ref === action.publicationRef && row.value.kind === "publish");
        const original = head(records, id, decision.appliedSequence);

        if (target === undefined || target.sequence > decision.request.boardSequence) {
          reject("central_advisory_publication_not_found");
          continue;
        }

        if (original?.ref !== target.ref || original.value.kind !== "publish") {
          reject("central_advisory_publication_not_latest", "superseded");
          continue;
        }

        const value = { ...common, kind: "withdraw" as const, publicationRef: target.ref,
          previousPublicationRef: target.ref, why: action.why };
        if (!isContentValueCredentialSafe(value, options.secrets ?? [])) {
          reject("central_advisory_credential_unsafe");
          continue;
        }

        const draft = buildCentralAdvisoryRecord(value);

        drafts.push(draft);
        results.push({ index, kind: action.kind, status: "withdrawn", publicationRef: draft.id, reason: null });
        continue;
      }

      const source = atDecision.find(row => row.intent.intentId === action.intentId);
      const intent = source?.intent, live = current.get(action.intentId)?.intent;
      const knowledge = intent?.knowledge.find(entry => centralAdvisoryKnowledgeHash(entry) === action.knowledgeHash);
      if (intent === undefined || source === undefined || knowledge === undefined) {
        reject("central_advisory_selection_not_applied");
        continue;
      }

      if (withdrawn(intent) || live !== undefined && withdrawn(live)) {
        reject("central_advisory_purpose_withdrawn");
        continue;
      }

      if (live === undefined || !same(live.conditions, intent.conditions)
        || !live.knowledge.some(entry => centralAdvisoryKnowledgeHash(entry) === action.knowledgeHash)) {
        reject("central_advisory_source_changed");
        continue;
      }

      try {
        // The ancestry owner authenticates output, current request, or a fully
        // delivered archived body; publishing does not revive its working set.
        const accessSourceRefs = collectCentralAdvisoryAccessSourceRefs(state, options.scope, { intent, knowledge, delivery });
        const publication: CentralAdvisoryPublish = { ...common, kind: "publish", intentId: intent.intentId,
          purposeHeadRef: source.factRef, purposeConditions: intent.conditions, knowledgeHash: action.knowledgeHash,
          statement: knowledge.statement, conditions: knowledge.conditions, sourceRefs: knowledge.sourceRefs,
          whenRelevant: action.whenRelevant, uncertainty: action.uncertainty, accessSourceRefs,
          previousPublicationRef: previousPublication(records, id, decision.appliedSequence) };
        if (!isContentValueCredentialSafe(publication, options.secrets ?? [])) {
          reject("central_advisory_credential_unsafe");
          continue;
        }

        const allowed = await options.access(state, publication, signal);
        check(signal);

        if (!allowed.ok) {
          reject("central_advisory_source_access_denied");
          continue;
        }

        const draft = buildCentralAdvisoryRecord(publication);

        drafts.push(draft);
        results.push({ index, kind: action.kind, status: "published", publicationRef: draft.id, reason: null });
      } catch (error) {
        const failure = readCentralAdvisorySourceFailure(error);
        if (failure === undefined) throw error;
        reject(failure.reason);
      }
    }

    return { drafts, results };
  }

  async function record(appliedStateRef: string, signal: AbortSignal): Promise<CentralAdvisoryPublicationResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let state = await writer.load(signal);
      const facts = state.rewardV2Facts ?? [];
      const decision = readAppliedCentralAdvisoryDecisions(facts, options.scope, state.sequence)
        .find(row => row.appliedStateRef === appliedStateRef);
      if (decision === undefined) return fail("central_advisory_applied_decision_required");

      const existing = readCentralAdvisoryResult(facts, decision, state.sequence);
      if (existing !== undefined) return existing;

      let prepared = readCentralAdvisoryPreparedPlan(facts, decision);
      if (prepared === undefined) {
        if (readCentralAdvisoryRecords(facts, options.scope, state.sequence).some(row => row.value.appliedStateRef === appliedStateRef)) return writer.suspend();

        const selected = await plan(state, decision, signal);
        const preparation = buildCentralAdvisoryPreparedPlan(decision, state.sequence, selected.drafts, selected.results);
        if (await writer.save(state.sequence, preparation, signal) === "stale") continue;

        state = await writer.load(signal);
        prepared = readCentralAdvisoryPreparedPlan(state.rewardV2Facts ?? [], decision);

        if (prepared === undefined) return writer.suspend();
      }

      const preparedPlan = prepared, currentFacts = state.rewardV2Facts ?? [];
      const preparedSequence = currentFacts.find(row => row.id === preparedPlan.ref)?.sequence;
      if (preparedSequence === undefined) return writer.suspend();

      const already = readCentralAdvisoryResult(currentFacts, decision, state.sequence);
      if (already !== undefined) return already;

      const actual = readCentralAdvisoryRecords(currentFacts, options.scope, state.sequence)
        .filter(row => row.value.appliedStateRef === decision.appliedStateRef);
      if (actual.some(row => !preparedPlan.drafts.some(draft => draft.id === row.ref))) return writer.suspend();

      const missing = preparedPlan.drafts.filter(draft => {
        const fact = currentFacts.find(row => row.id === draft.id);
        if (fact === undefined) return true;
        if (fact.scope !== draft.scope || fact.algorithmVersion !== draft.algorithmVersion || fact.kind !== draft.kind
          || fact.payloadJson !== draft.payloadJson || fact.sequence <= preparedSequence) return writer.suspend();
        return false;
      });
      const footer = buildCentralAdvisoryResult(decision, preparedPlan.results);
      if (await writer.save(state.sequence, [...missing, footer], signal) === "stale") continue;

      const committed = await writer.load(signal);
      const confirmed = readCentralAdvisoryResult(committed.rewardV2Facts ?? [], decision, committed.sequence);
      if (confirmed === undefined || confirmed.resultRef !== footer.id) return writer.suspend();

      return { ...confirmed, status: "recorded" };
    }
    return fail("central_advisory_stale");
  }

  return Object.freeze({
    recordDecision(input: { readonly scope: string; readonly appliedStateRef: string }, signal: AbortSignal) {
      checkScope(input.scope, signal);
      return serial(() => record(input.appliedStateRef, signal));
    },

    recoverApplied(input: { readonly scope: string }, signal: AbortSignal): Promise<readonly CentralAdvisoryPublicationResult[]> {
      checkScope(input.scope, signal);
      return serial(async () => {
        const state = await writer.load(signal);
        const facts = state.rewardV2Facts ?? [];
        const decisions = readAppliedCentralAdvisoryDecisions(facts, options.scope, state.sequence);
        const results: CentralAdvisoryPublicationResult[] = [];

        for (const decision of decisions) {
          check(signal);
          // Complete immutable footers were authenticated at this same prefix.
          // Only unfinished publications need another current read and writer CAS.
          const existing = readCentralAdvisoryResult(facts, decision, state.sequence);
          results.push(existing ?? await record(decision.appliedStateRef, signal));
        }

        return results;
      });
    },
  });
}
