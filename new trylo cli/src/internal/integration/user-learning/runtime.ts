import { extractEvidence } from "../../learning/domains/user/evidence.js";
import { classifyUserSignal } from "../../learning/domains/user/evidence-grounding.js";
import { strongSignalOf, type JournalEvent, type StrongSignal } from "../../learning/domains/user/evidence-signal.js";
import { evaluateOutcome } from "../../learning/domains/user/outcome-evaluator.js";
import { prepareUserPolicy, type UserPolicySelection } from "../../learning/domains/user/prepare.js";
import type { StrongSignalKind, UserLearningPorts, UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";
import type { UserLearningVersion, UserPolicyFielding } from "../../learning/domains/user/learning-cycle-contract.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";
import { sha256Hex } from "../../learning/domains/shared/hash.js";
import { deriveUserPolicy, type DerivedUserPolicy } from "./chain.js";
import { createUserFeedbackRecords, createUserFieldingRecords, readLatestScopeFielding,
  readLearnedUserPolicy, selectLearnedUserPolicy } from "./learned-policy.js";

export const USER_POLICY_RECEIPT_PREFIX = "user-policy:";

export type UserLearningRuntimeDeps = {
  readonly ports: UserLearningPorts;
  readonly userId: string;
  readonly workspaceId: string;
  readonly now: () => number;
  readonly warn: (message: string) => void;
  /** Explicit compatibility only. Production consumes completed peer-learning versions. */
  readonly policyMode?: "learned" | "legacy";
};

export type UserPolicySlotReceipt = {
  readonly ref: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly nicheId: string;
};

export type UserPolicyFieldingNotice = {
  readonly turnId: string;
  readonly attemptId: string;
  readonly beat: number;
  readonly receipts: readonly UserPolicySlotReceipt[];
};

export type UserPolicyInjection = {
  readonly text: string;
  readonly chars: number;
  readonly receipt?: UserPolicySlotReceipt;
};

export type UserLearningRuntime = {
  readonly capture: (event: JournalEvent) => void;
  readonly policyFor: (spentChars: number, request?: { readonly turnId: string; readonly beat: number }) => UserPolicyInjection | undefined;
  /** Only the execution owner's confirmed send callback creates an exposure. */
  readonly recordFielding?: (notice: UserPolicyFieldingNotice) => void;
  readonly finishTurn: () => void;
};

type FrozenPolicy = { readonly policy: UserLearningVersion; readonly legacy?: DerivedUserPolicy };

type PreparedPolicy = { readonly selection: UserPolicySelection; readonly receipt: UserPolicySlotReceipt; readonly beat?: number };

type PolicyAllowance = { readonly state: "unasked" | "denied" }
  | { readonly state: "granted"; readonly totalChars: number; readonly chars: number };

type PendingFeedback = {
  readonly fielding: UserPolicyFielding;
  readonly eventId: string;
  readonly text: string;
  readonly signal: "steer" | "correction";
  readonly at: number;
  readonly sourceEvidenceId?: string;
};

type ActiveTurn = {
  readonly turnId: string | undefined;
  readonly taskText: string;
  readonly collection: "enabled" | "disabled";
  sourceState: "available" | "unavailable";
  records: readonly UserLearningRecord[];
  frozen: FrozenPolicy | undefined;
  allowance: PolicyAllowance;
  readonly prepared: Map<string, PreparedPolicy>;
  readonly feedback: PendingFeedback[];
  latestFielding: UserPolicyFielding | undefined;
};

/** Human evidence is collection-controlled; policy preparation and actual delivery
 * have separate boundaries. A learned version is frozen before this turn's input
 * is collected, so background learning cannot rewrite an in-flight request. */
export function createUserLearningRuntime(deps: UserLearningRuntimeDeps): UserLearningRuntime {
  let active: ActiveTurn | undefined;
  let warned = false;
  const scopeFingerprint = fingerprintScopeV2({ userId: deps.userId, workspaceId: deps.workspaceId });

  function report(reason: string): void {
    if (warned) return;
    warned = true;
    deps.warn(`user_learning_degraded:${reason}`);
  }

  function append(turn: ActiveTurn, records: readonly UserLearningRecord[]): boolean {
    if (records.length === 0) return true;
    const written = deps.ports.ledger.append(records);
    if (!written.ok) {
      report(written.reason);
      return false;
    }
    turn.records = [...turn.records, ...records];
    return true;
  }

  function begin(event: JournalEvent): ActiveTurn {
    const collection = deps.ports.collection.capture({ turnId: event.turnId ?? "" }) ? "enabled" : "disabled";
    const turn: ActiveTurn = { turnId: event.turnId, taskText: strongSignalOf(event)?.text ?? "", collection,
      sourceState: "unavailable", records: [], frozen: undefined, allowance: { state: "unasked" }, prepared: new Map(), feedback: [], latestFielding: undefined };

    if (collection === "disabled") return turn;

    const read = deps.ports.ledger.read();
    if (!read.ok) {
      report(read.reason);
      return turn;
    }

    turn.records = read.records;

    // An unreadable row may be the policy's withdrawal. Keep collecting human
    // evidence, but do not interpret a partial prefix as a usable policy head.
    if (read.unreadable > 0) {
      report(`ledger_unreadable:${read.unreadable}`);
      return turn;
    }

    turn.sourceState = "available";
    turn.latestFielding = readLatestScopeFielding(read.records, scopeFingerprint, event.turnId);

    if (deps.policyMode !== "legacy") {
      const learned = readLearnedUserPolicy({ records: read.records, userId: deps.userId, workspaceId: deps.workspaceId, now: deps.now() });
      if (learned.status === "ready") turn.frozen = { policy: learned.policy };
    }

    return turn;
  }

  function capture(event: JournalEvent): void {
    if (event.kind === "turn_start") active = begin(event);

    const turn = active;
    if (turn === undefined || turn.collection === "disabled") return;

    const signal = strongSignalOf(event);
    if (signal === undefined) return;

    const at = deps.now();
    const evidence = evidenceRecord(event, signal, at, deps.workspaceId);

    append(turn, [...evidence, signalRecord(event, signal.signal, at)]);

    if (turn.latestFielding !== undefined && signal.text !== undefined && (signal.signal === "steer" || signal.signal === "correction")) {
      const source = evidence.find(record => record.record === "evidence");
      turn.feedback.push({ fielding: turn.latestFielding, eventId: event.eventId, text: signal.text, signal: signal.signal,
        at, ...(source?.record === "evidence" ? { sourceEvidenceId: source.evidence.id } : {}) });
    }
  }

  function policyAllowance(turn: ActiveTurn): PolicyAllowance {
    if (turn.allowance.state !== "unasked") return turn.allowance;
    const budget = deps.ports.budget.allowance();
    const order = budget.available ? deps.ports.workOrder.grant({ turnId: turn.turnId ?? "", taskText: turn.taskText, scopeFingerprint }) : undefined;
    turn.allowance = order === undefined || budget.totalChars <= 0 || order.chars <= 0 ? { state: "denied" }
      : { state: "granted", totalChars: budget.totalChars, chars: order.chars };
    return turn.allowance;
  }

  function frozenFor(turn: ActiveTurn): FrozenPolicy | undefined {
    if (turn.sourceState === "unavailable") return undefined;

    if (turn.frozen !== undefined || deps.policyMode !== "legacy") return turn.frozen;

    const legacy = deriveUserPolicy({ records: turn.records, userId: deps.userId, workspaceId: deps.workspaceId, now: deps.now() });
    const policy: UserLearningVersion = { schemaVersion: 1, versionId: `legacy-user-policy:${legacy.bundleChecksum}`,
      questionRef: "legacy-user-policy", sourcePrefixRef: `legacy-user-policy:${legacy.bundleChecksum}`, scopeFingerprint,
      evidenceIds: legacy.evidence.map(item => item.id), eligibility: [], conclusions: [], models: legacy.models,
      policies: legacy.rules.map(rule => ({ rule, includeTerms: [], excludeTerms: [], applicability: "legacy dimension match" })),
      bundleChecksum: legacy.bundleChecksum, at: deps.now() };

    turn.frozen = { policy, legacy };

    return turn.frozen;
  }

  function policyFor(spentChars: number, request?: { readonly turnId: string; readonly beat: number }): UserPolicyInjection | undefined {
    const turn = active;
    if (turn === undefined || turn.collection === "disabled" || request !== undefined && request.turnId !== turn.turnId) return undefined;

    const allowance = policyAllowance(turn);
    if (allowance.state !== "granted") return undefined;

    const budgetChars = Math.min(allowance.totalChars - Math.max(0, spentChars), allowance.chars);
    if (budgetChars <= 0) return undefined;

    const frozen = frozenFor(turn);
    if (frozen === undefined) return undefined;

    const selection = frozen.legacy === undefined ? selectLearnedUserPolicy(frozen.policy, turn.taskText, budgetChars)
      : prepareUserPolicy({ rules: frozen.legacy.rules, models: frozen.legacy.models, scopeFingerprint, taskText: turn.taskText, budgetChars });
    if (selection.segment === undefined) return undefined;

    const ref = `${USER_POLICY_RECEIPT_PREFIX}${sha256Hex(JSON.stringify([turn.turnId, request?.beat, frozen.policy.versionId, selection.adoptedRuleIds])).slice(0, 24)}`;
    const receipt: UserPolicySlotReceipt = { ref, versionId: frozen.policy.versionId, proposalId: frozen.policy.questionRef, nicheId: scopeFingerprint };

    turn.prepared.set(ref, { selection, receipt, ...(request === undefined ? {} : { beat: request.beat }) });

    return { text: selection.segment, chars: selection.chars, receipt };
  }

  function recordFielding(notice: UserPolicyFieldingNotice): void {
    const turn = active;
    if (turn === undefined || turn.collection === "disabled" || turn.turnId !== notice.turnId || turn.frozen === undefined) return;

    for (const receipt of notice.receipts) {
      const prepared = turn.prepared.get(receipt.ref);
      if (prepared === undefined || prepared.receipt.versionId !== receipt.versionId || prepared.beat !== undefined && prepared.beat !== notice.beat) continue;

      const records = createUserFieldingRecords({ policy: turn.frozen.policy, selectedRuleIds: prepared.selection.adoptedRuleIds,
        turnId: notice.turnId, attemptId: notice.attemptId, beat: notice.beat, at: deps.now() });
      const fielding = records.find(record => record.record === "policy_fielding");
      if (fielding?.record !== "policy_fielding" || turn.records.some(record => record.record === "policy_fielding" && record.fielding.receiptId === fielding.fielding.receiptId)) continue;

      const legacyReceipts = legacyReceiptsFor(turn.frozen, fielding.fielding.ruleIds, turn.records);
      if (!append(turn, [...records, ...legacyReceipts, { record: "policy", adopted: true, ruleIds: fielding.fielding.ruleIds,
        matched: prepared.selection.adoptedRuleIds.length + prepared.selection.droppedRuleIds.length, chars: prepared.selection.chars,
        scopeFingerprint, bundleChecksum: turn.frozen.policy.bundleChecksum, turnId: notice.turnId, at: deps.now() }])) continue;

      turn.latestFielding = fielding.fielding;
    }
  }

  function finishTurn(): void {
    const turn = active;
    if (turn !== undefined && turn.collection === "enabled") {
      for (const feedback of turn.feedback) {
        append(turn, createUserFeedbackRecords({ records: turn.records, ...feedback }));
        const legacy = turn.frozen?.legacy;
        if (legacy === undefined || turn.frozen?.policy.versionId !== feedback.fielding.versionId) continue;

        const commitmentIds = [...new Set(legacy.rules.filter(rule => feedback.fielding.ruleIds.includes(rule.id)).flatMap(rule => rule.sourceCommitmentIds))];
        const outcome = evaluateOutcome({ commitmentIds, events: [{ kind: feedback.signal === "correction" ? "correction" : "feedback_text", text: feedback.text }],
          traceId: feedback.fielding.receiptId, now: feedback.at });

        append(turn, outcome.observations.map(observation => ({ record: "observation" as const, observation })));
      }
    }

    active = undefined;
  }

  return { capture, policyFor, recordFielding, finishTurn };
}

function legacyReceiptsFor(frozen: FrozenPolicy, ruleIds: readonly string[], records: readonly UserLearningRecord[]): UserLearningRecord[] {
  if (frozen.legacy === undefined) return [];
  const commitments = new Set(frozen.legacy.rules.filter(rule => ruleIds.includes(rule.id)).flatMap(rule => rule.sourceCommitmentIds));
  return frozen.legacy.newReceipts.filter(receipt => commitments.has(receipt.commitmentId)
    && !records.some(record => record.record === "receipt" && record.receipt.id === receipt.id))
    .map(receipt => ({ record: "receipt", receipt }));
}

function evidenceRecord(event: JournalEvent, signal: StrongSignal, at: number, workspaceId: string): readonly UserLearningRecord[] {
  if (signal.text === undefined || event.sessionId === undefined) return [];

  const eventKind = signal.signal === "correction" ? "correction" : "explicit_statement";
  const grounding = classifyUserSignal(signal.text, eventKind);
  const evidence = extractEvidence({ text: signal.text, eventKind, source: { sessionId: event.sessionId,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }), workspaceId },
    informedness: event.kind === "turn_start" ? "pre_task" : "in_task", durability: grounding.durability,
    signalKind: grounding.signalKind, now: at });

  return evidence === null ? [] : [{ record: "evidence", evidence }];
}

function signalRecord(event: JournalEvent, signal: StrongSignalKind, at: number): UserLearningRecord {
  return { record: "signal", signal, eventId: event.eventId, ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }), at };
}
