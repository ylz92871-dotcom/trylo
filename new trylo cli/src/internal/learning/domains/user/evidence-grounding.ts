import { hashUserText } from "../shared/privacy.js";
import { shortId, sha256Hex } from "../shared/hash.js";
import {
  unansweredFiveQuestions,
  type EvidenceDurability,
  type EvidenceEventKind,
  type EvidenceSourceFacts,
  type UserEvidence,
  type UserSignalKind,
} from "./contracts.js";

const TASK_LOCAL_MARK = /这次|当前任务|这个任务|先把这|先修这|仅本次|临时/;
const COLLABORATION_MARK =
  /不要反复|少审核|减少审核|重复审核|同目的|别写那么长|不要长篇|别搞复杂|直接干|先规划|只要结论|先说结论|背景优先|依据展开|报告|汇报|周报|先看结构|先出一版|完整草稿|以后|每次|默认/;

export type UserSignal = {
  readonly durability: EvidenceDurability;
  readonly signalKind: UserSignalKind;
};

/**
 * 用户信号归类：只看"这条信号能活多久、是什么性质"，不做任何长期推断。
 * 明确协作偏好 → long_term_candidate；只栓在本次任务 → task_local；
 * 其余 → session_local。归类错了顶多影响升格速度，不会凭空造出偏好。
 */
export function classifyUserSignal(text: string, eventKind: EvidenceEventKind): UserSignal {
  if (eventKind === "override" || eventKind === "intervention") {
    return { durability: "task_local", signalKind: "task_override" };
  }

  if (COLLABORATION_MARK.test(text)) {
    return { durability: "long_term_candidate", signalKind: "collaboration_preference" };
  }

  if (TASK_LOCAL_MARK.test(text)) {
    return { durability: "task_local", signalKind: "task_requirement" };
  }

  if (eventKind === "correction") {
    return { durability: "session_local", signalKind: "correction" };
  }

  return { durability: "session_local", signalKind: "task_requirement" };
}

export type GroundingCandidate = {
  readonly candidateId: string;
  readonly proposedClaim: string;
  readonly proposedRaw?: string;
  readonly proposedEventKind?: EvidenceEventKind;
};

export type GroundingSourceEvent = {
  readonly eventId: string;
  readonly actor: "user" | "agent" | "system";
  readonly text: string;
};

export type GroundingDecision =
  | { readonly accepted: true; readonly reasonCode: "grounded_user_event"; readonly evidence: UserEvidence }
  | {
      readonly accepted: false;
      readonly reasonCode:
        | "actor_not_user"
        | "source_event_missing"
        | "raw_span_mismatch"
        | "duplicate_source";
    };

/**
 * 证据接地：候选解读必须能锚回一条真实用户事件。
 * 拒绝执行产物、拒绝空文本、拒绝重复来源（调用方传入 seen 做跨批去重）。
 * 纯函数：seen 由调用方持有并传入，本函数只读不写——写入由调用方在
 * accepted 后执行，避免"先占坑后失败"的半截状态。
 */
export function groundEvidenceCandidate(input: {
  readonly candidate: GroundingCandidate;
  readonly event?: GroundingSourceEvent;
  readonly source: EvidenceSourceFacts;
  readonly seen: ReadonlySet<string>;
  readonly now?: number;
}): GroundingDecision {
  if (input.event === undefined) {
    return { accepted: false, reasonCode: "source_event_missing" };
  }

  if (input.event.actor !== "user") {
    return { accepted: false, reasonCode: "actor_not_user" };
  }

  const observation = input.event.text.trim();
  if (observation.length === 0) {
    return { accepted: false, reasonCode: "raw_span_mismatch" };
  }

  const proposedRaw = (input.candidate.proposedRaw ?? "").trim();
  if (proposedRaw.length > 0 && !observation.includes(proposedRaw) && proposedRaw !== observation) {
    return { accepted: false, reasonCode: "raw_span_mismatch" };
  }

  const dedupe = `sh_${sha256Hex([input.source.sessionId, input.event.eventId, observation].join(""))}`;
  if (input.seen.has(dedupe)) {
    return { accepted: false, reasonCode: "duplicate_source" };
  }

  const eventKind = input.candidate.proposedEventKind ?? "explicit_statement";
  const signal = classifyUserSignal(observation, eventKind);
  const now = input.now ?? Date.now();

  return {
    accepted: true,
    reasonCode: "grounded_user_event",
    evidence: {
      id: input.candidate.candidateId,
      rawText: observation,
      claim: input.candidate.proposedClaim,
      eventKind,
      durability: signal.durability,
      signalKind: signal.signalKind,
      answers: {
        ...unansweredFiveQuestions(),
        semantic: 0.7,
        relevance: 0.7,
        contextInformedness: "unknown",
        governance: 2,
      },
      source: input.source,
      sourceHash: dedupe,
      textHash: hashUserText(observation),
      createdAt: now,
    },
  };
}

export function evidenceIdFor(source: EvidenceSourceFacts, textHash: string): string {
  return shortId("ev", [`sh_${sha256Hex([source.sessionId, source.turnId ?? "", textHash].join(""))}`, textHash]);
}
