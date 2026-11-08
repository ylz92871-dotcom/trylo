import type { CentralLearningWait, CentralRuntimeExecutionPort, CentralRuntimeMaterial, CentralRuntimeSourcePort, CentralRuntimeWork, CentralRuntimeWorkResult } from "../../learning/central/runtime/contracts.js";
import { shortId } from "../../learning/domains/shared/hash.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { UserLearningSignal, UserPeerProgress } from "../../learning/domains/user/learning-cycle-contract.js";
import { objectValue } from "../../learning/domains/user/semantic-draft.js";
import type { UserLearningPeer } from "./peer.js";
import { CentralRuntimeBlocked } from "../../learning/central/runtime/errors.js";
import { createUserPeerStatusMaterial, USER_PEER_STATUS_READ_CONTRACT } from "./central-status-navigation.js";

/** Central sees availability and immutable references. User evidence/model bodies stay behind the peer. */
export function createUserPeerRuntimeAdapter(peer: UserLearningPeer) {
  const source: CentralRuntimeSourcePort = {
    async snapshot(_scope, signal, query) {
      if (signal.aborted) throw new Error("user_learning_cancelled");

      const state = peer.inspect();
      if (!state.ok) return { boardSequence: 0, opportunities: [], materials: [], sourceRefs: [] };

      const purposes = relatedUserPurposes(state, query);

      // A scope identity and the hash of [] are not a new learning fact. Existing
      // private history or an explicitly related open purpose still needs absence.
      if (!state.hasEvidence && !state.hasScopeHistory && state.policyRefs.length === 0 && state.progress === undefined && purposes.length === 0)
        return { boardSequence: 0, opportunities: [], materials: [], sourceRefs: [] };

      const subject = { plane: "user" as const, ledgerRef: state.ledgerRef, questionRef: state.questionRef };
      // Hash only original User heads under a proved identity binding. Including
      // this condition or a derived central result would make notices self-grow.
      const absent = state.hasEvidence || purposes.length === 0 ? undefined : shortId("user-availability", [state.ledgerRef,
        state.questionRef, state.sourcePrefixRef, ...[...new Set([...(query?.sourceRefs ?? []), ...purposes.flatMap(purpose => purpose.sourceRefs)]
          .filter(ref => ref !== state.sourcePrefixRef && /^user-source:[0-9a-f]{64}$/.test(ref)))].sort()]);
      const material = userSourceMaterial(state);

      return { boardSequence: 0, opportunities: !state.needsLearning ? [] : [{ subject, sourceRef: state.sourcePrefixRef,
        description: "User peer has authentic user evidence or unfinished semantic work to understand individual collaboration conditions and preferences among valid alternatives. Authentic user origin identifies material, not an established preference.",
        constraints: ["User remains a peer; private evidence stays inside User", "No permission or quality-defect personalization", "Current user instruction wins",
          "General technical quality questions may support grounded central research; the central agent chooses its receiver rather than inferring ownership from who supplied the evidence.",
          "Intent knowledge remains central research memory. It does not automatically enter business prompts; business adoption follows the native owner's production, publication and adoption path."] }],
      materials: [material, ...(absent === undefined ? [] : [{ ref: absent, kind: "source" as const,
        text: JSON.stringify({ owner: "user_learning", ledgerRef: state.ledgerRef, questionRef: state.questionRef,
          sourcePrefixRef: state.sourcePrefixRef, availability: "no_current_evidence",
          qualification: "Reconsider related purposes against unavailable private evidence; this does not end the purpose, withdraw user intent, or erase retained public knowledge." }),
        sourceRefs: [state.sourcePrefixRef] }])],
      // Reports may change within one semantic operation. Its original work
      // receipt carries that progress; a new report address is not a new notice.
      sourceRefs: [state.sourcePrefixRef, ...(absent === undefined ? [] : [absent])],
      ...(absent === undefined ? {} : { reconsider: purposes.map(purpose => ({ subject: purpose.subject, sourceRefs: [absent],
        reason: "user_current_evidence_missing_for_related_open_purpose" })) }) };
    },

    async read(_scope, refs, maximumChars, signal) {
      if (signal.aborted) throw new Error("user_learning_cancelled");

      const state = peer.inspect();
      if (!state.ok) return [];

      const material = userSourceMaterial(state);
      if (!refs.includes(material.ref) && !refs.includes(state.sourcePrefixRef)) return [];

      if (!Number.isSafeInteger(maximumChars) || maximumChars < 1 || material.text.length > maximumChars)
        throw new Error("user_learning_source_capacity");

      // The prefix is an observation alias. Never label this changing report as
      // that legacy material; the original central archive owns historic bytes.
      return [material];
    },
  };
  const execution: CentralRuntimeExecutionPort = {
    async consult(input) {
      if (input.subject.plane !== "user") throw new Error("user_learning_subject_required");
      const state = peer.inspect();
      if (!state.ok) throw new Error(state.reason);
      return userReportMaterial(state, "numerical_advice", { owner: "user_learning",
        needsLearning: state.needsLearning, progress: state.progress, knownPolicyRefs: state.policyRefs,
        qualification: "Policy delivery and real-use effectiveness are separate; effectiveness remains unknown without human feedback." });
    },

    async prepare(input) {
      const state = peer.inspect(), subject = input.intent.subject;
      if (!state.ok) throw new CentralRuntimeBlocked(state.reason, input.intent.sourceRefs, "preparation");

      const nativeUser = subject.plane === "user" && subject.questionRef === state.questionRef && subject.ledgerRef === state.ledgerRef;
      const centralUser = subject.plane === "central" && input.operation.destination?.plane === "user";
      if (!nativeUser && !centralUser) throw new Error("user_learning_subject_mismatch");

      if (subject.plane === "user" && input.operation.destination !== undefined && input.operation.destination.plane !== "user") {
        throw new CentralRuntimeBlocked("central_runtime_user_destination_mismatch", [subject.ledgerRef, subject.questionRef], "preparation");
      }

      if (nativeUser && !input.operation.sourceRefs.includes(state.sourcePrefixRef)) throw new Error("user_learning_source_prefix_stale");

      const research = centralUser ? peer.acceptResearch({ intentRef: input.intent.intentId, goal: input.intent.goal,
        knowledge: input.intent.knowledge.map(item => item.statement), residual: input.intent.residual,
        operationRef: input.operation.operationId, purpose: input.operation.purpose,
        sourceRefs: [...input.intent.sourceRefs, ...(input.intent.derivation?.parentRefs ?? []), ...input.operation.sourceRefs] }) : undefined;
      if (research?.status === "unavailable") throw new CentralRuntimeBlocked(research.reason, input.intent.sourceRefs, "preparation");

      const workRef = shortId("user-work", [input.intent.intentId, input.operation.operationId, state.questionRef, state.sourcePrefixRef]);

      if (!state.hasEvidence) throw new CentralRuntimeBlocked("user_evidence_missing",
        [state.ledgerRef, state.questionRef, state.sourcePrefixRef], "preparation");

      const funding = await peer.funding();
      if (!funding.ok) throw new CentralRuntimeBlocked(funding.reason, [state.sourcePrefixRef], "resources");

      const available = funding.projection.available, allowance = input.operation.allowance;
      if (available.calls < 1 || available.steps < 1 || available.tokens < 256) throw new CentralRuntimeBlocked("user_learning_budget_exhausted", [state.sourcePrefixRef], "resources");

      const maxTokens = Math.min(allowance.maxTokens, available.tokens), maxCalls = Math.min(allowance.maxCalls, allowance.maxSteps, available.calls, available.steps, 32);
      if (maxCalls < 1 || maxTokens < 256) throw new CentralRuntimeBlocked("user_learning_allowance_exhausted", [state.sourcePrefixRef], "resources");

      return { intentId: input.intent.intentId, operation: input.operation, workRef,
        frame: { kind: "user_learning", ledgerRef: state.ledgerRef, questionRef: state.questionRef, sourcePrefixRef: state.sourcePrefixRef,
          purpose: research?.purpose ?? input.operation.purpose, researchIntentRef: centralUser ? input.intent.intentId : null,
          maxTokensPerCall: maxTokens, maxTotalTokens: maxTokens, maxCalls,
          ...(centralUser && state.policyRefs[0] !== undefined ? { reconsiderVersionRef: state.policyRefs[0] } : {}),
          maxPromptChars: allowance.maxPromptChars, operationRef: workRef } };
    },

    async execute(work, signal) {
      if (work.frame.waitingReason === "user_evidence_missing") return missingEvidence(work);
      const input = readFrame(work);
      if (input === undefined) return { outcome: "failed", publicResult: "user_learning_frame_invalid", resultRefs: [] };
      return result(await peer.advance(input, signal));
    },

    async recover(work) {
      if (work.frame.waitingReason === "user_evidence_missing") return missingEvidence(work);

      const input = readFrame(work);
      if (input === undefined) return { outcome: "failed", publicResult: "user_learning_frame_invalid", resultRefs: [] };

      const localTimeout = await peer.recoverLocalTimeout(input);
      if (localTimeout !== undefined) return result(localTimeout);

      const status = await peer.operationStatus(input);
      if (status === "unavailable") return null;

      const found = peer.recover(work.workRef);
      if (status !== "unknown" && found !== undefined) return result(await peer.recoverBoundary(input) ?? found);

      if (status === "unsent") return { kind: "ready_to_execute" };

      return { outcome: status === "unknown" ? "unknown" : "failed", publicResult: status === "unknown"
        ? "User request has an original reservation but no durable private result; reconcile without replay."
        : "Original User source/frame is stale; reconsider the intent before dispatch.", resultRefs: [work.workRef],
        ...(status === "unknown" ? { wait: { kind: "facts" as const, sourceRefs: [work.workRef], reason: "user_learning_original_result_unresolved" } } : {}) };
    },
  };

  return { source, execution, readContract: USER_PEER_STATUS_READ_CONTRACT };
}

type UserSourceState = Extract<ReturnType<UserLearningPeer["inspect"]>, { readonly ok: true }>;

type SourceQuery = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

function relatedUserPurposes(state: UserSourceState, query?: SourceQuery) {
  const purposes: NonNullable<SourceQuery["purposes"]> = query?.purposes ?? query?.subjects.map(subject => ({ subject, sourceRefs: [] })) ?? [];
  return purposes.filter(purpose => purpose.subject.plane === "user"
    ? purpose.subject.ledgerRef === state.ledgerRef && purpose.subject.questionRef === state.questionRef
    : purpose.sourceRefs.includes(state.ledgerRef) && purpose.sourceRefs.includes(state.questionRef));
}

function userSourceMaterial(state: UserSourceState): CentralRuntimeMaterial {
  return createUserPeerStatusMaterial(state);
}

function userReportMaterial(state: UserSourceState, kind: CentralRuntimeMaterial["kind"], body: Readonly<Record<string, unknown>>): CentralRuntimeMaterial {
  const material = { kind, text: JSON.stringify(body), sourceRefs: [state.sourcePrefixRef] };
  return { ref: `user-report:${contentHashOf(material)}`, ...material };
}

function missingEvidence(work: CentralRuntimeWork): CentralRuntimeWorkResult {
  return { outcome: "returned", publicResult: JSON.stringify({ owner: "user_learning", state: "waiting",
    reason: "user_evidence_missing", waitFor: "source_change", questionRef: work.frame.questionRef }),
    resultRefs: typeof work.frame.sourcePrefixRef === "string" ? [work.frame.sourcePrefixRef] : [],
    wait: { kind: "facts", reason: "user_evidence_missing", sourceRefs: typeof work.frame.sourcePrefixRef === "string" ? [work.frame.sourcePrefixRef] : [] } };
}

function result(progress: UserPeerProgress): CentralRuntimeWorkResult {
  const wait = peerWait(progress);
  return { outcome: progress.outcome ?? (progress.state === "unavailable" ? "failed" : "returned"),
    publicResult: JSON.stringify(progress), resultRefs: [...progress.versionRefs,
      ...(progress.progressRef === undefined ? [] : [progress.progressRef]), ...(progress.clarificationRef === undefined ? [] : [progress.clarificationRef])],
    ...(wait === undefined ? {} : { wait }) };
}

function peerWait(progress: UserPeerProgress): CentralLearningWait | undefined {
  const sourceRefs = progress.waitRefs ?? [progress.questionRef, progress.sourcePrefixRef];

  if (progress.outcome === "unknown") {
    return progress.waitFor === "recovery" && (progress.waitRefs?.length ?? 0) > 0
      ? { kind: "facts", sourceRefs, reason: progress.reason } : undefined;
  }

  switch (progress.waitFor) {
    case "budget": case "resources": return { kind: "resources", sourceRefs, reason: progress.reason };
    case "dependency": case "source_change": case "user_clarification": return { kind: "facts", sourceRefs, reason: progress.reason };
    default: return undefined;
  }
}

function readFrame(work: CentralRuntimeWork): UserLearningSignal | undefined {
  const frame = work.frame;
  if (!objectValue(frame) || frame.kind !== "user_learning" || typeof frame.questionRef !== "string" || typeof frame.sourcePrefixRef !== "string"
    || typeof frame.purpose !== "string" || frame.operationRef !== work.workRef || typeof frame.maxTokensPerCall !== "number"
    || typeof frame.maxTotalTokens !== "number" || typeof frame.maxCalls !== "number" || typeof frame.maxPromptChars !== "number"
    || !(frame.reconsiderVersionRef === undefined || typeof frame.reconsiderVersionRef === "string")) return undefined;

  const cap = work.operation.allowance;
  if (frame.maxTotalTokens > cap.maxTokens || frame.maxTokensPerCall > frame.maxTotalTokens || frame.maxCalls > cap.maxCalls
    || frame.maxCalls > cap.maxSteps || frame.maxPromptChars > cap.maxPromptChars) return undefined;

  return { questionRef: frame.questionRef, sourcePrefixRef: frame.sourcePrefixRef, purpose: frame.purpose, operationRef: work.workRef,
    ...(frame.reconsiderVersionRef === undefined ? {} : { reconsiderVersionRef: frame.reconsiderVersionRef }),
    maxTokensPerCall: frame.maxTokensPerCall, maxTotalTokens: frame.maxTotalTokens, maxCalls: frame.maxCalls, maxPromptChars: frame.maxPromptChars };
}
