import { shortId, sha256Hex } from "../../learning/domains/shared/hash.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";
import type { UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";
import type { UserLearningVersion, UserPolicyFielding } from "../../learning/domains/user/learning-cycle-contract.js";
import type { UserPolicySelection } from "../../learning/domains/user/prepare.js";

export function readLearnedUserPolicy(input: { readonly records: readonly UserLearningRecord[];
  readonly userId: string; readonly workspaceId: string; readonly now: number }) {
  const scope = fingerprintScopeV2({ userId: input.userId, workspaceId: input.workspaceId });
  const version = input.records.filter(item => item.record === "learning_version")
    .map(item => item.version).filter(item => item.scopeFingerprint === scope && item.availability !== "candidate").at(-1);
  if (version === undefined) return { status: "unavailable" as const, reason: "user_policy_not_learned" };

  const paused = new Set(input.records.filter(item => item.record === "policy_feedback")
    .map(item => item.feedback).filter(item => item.scopeFingerprint === scope && item.disposition === "pause")
    .flatMap(item => item.ruleIds));

  return { status: "ready" as const, policy: { ...version, policies: version.policies.filter(item => !paused.has(item.rule.id)) } };
}

/** Deterministic scope/condition selection. The current user's instruction always has precedence. */
export function selectLearnedUserPolicy(policy: UserLearningVersion, taskText: string, budgetChars: number): UserPolicySelection {
  const text = taskText.toLowerCase();
  const matched = policy.policies.filter(item => !item.excludeTerms.some(term => text.includes(term.toLowerCase()))
    && (item.includeTerms.length === 0 || item.includeTerms.some(term => text.includes(term.toLowerCase()))));
  const header = "[user policy] 适用的协作政策；当前用户明确要求优先；推断仅作可撤销建议，不改变权限或审批。";
  const lines: string[] = [], kept: string[] = [];

  for (const item of matched) {
    const line = `- [${item.rule.originMark === "explicit" ? "用户明确表达" : "推断建议"}] ${item.rule.instruction}（适用：${item.applicability}）`;
    if (`${header}\n${[...lines, line].join("\n")}`.length > budgetChars) continue;
    lines.push(line);
    kept.push(item.rule.id);
  }

  const segment = kept.length === 0 ? undefined : `${header}\n${lines.join("\n")}`;

  return { segment, adoptedRuleIds: kept, droppedRuleIds: matched.map(item => item.rule.id).filter(id => !kept.includes(id)), chars: segment?.length ?? 0 };
}

export function createUserFieldingRecords(input: { readonly policy: UserLearningVersion; readonly selectedRuleIds: readonly string[];
  readonly turnId: string; readonly attemptId: string; readonly beat: number; readonly at: number }): UserLearningRecord[] {
  const ruleIds = [...new Set(input.selectedRuleIds)].filter(id => input.policy.policies.some(item => item.rule.id === id));
  if (ruleIds.length === 0) return [];
  const fielding: UserPolicyFielding = { receiptId: shortId("user-fielding", [input.policy.versionId, input.attemptId, input.turnId,
    String(input.beat), ...ruleIds]), versionId: input.policy.versionId, scopeFingerprint: input.policy.scopeFingerprint,
    ruleIds, attemptId: input.attemptId, turnId: input.turnId, beat: input.beat, at: input.at };
  return [{ record: "policy_fielding", fielding }];
}

export function readLatestScopeFielding(records: readonly UserLearningRecord[], scopeFingerprint: string, excludeTurnId?: string): UserPolicyFielding | undefined {
  return records.filter(item => item.record === "policy_fielding").map(item => item.fielding)
    .filter(item => item.scopeFingerprint === scopeFingerprint && item.turnId !== excludeTurnId).at(-1);
}

/** User text supplies the outcome. Task-only exceptions remain observations, never a global pause. */
export function createUserFeedbackRecords(input: { readonly records: readonly UserLearningRecord[]; readonly fielding: UserPolicyFielding;
  readonly eventId: string; readonly text: string; readonly signal: "steer" | "correction"; readonly at: number;
  readonly sourceEvidenceId?: string }): UserLearningRecord[] {
  const helpful = /(?:这样|这么)(?:更好|很好|就对了)|以后(?:就)?这样|符合预期|正是我要的|保持这样/u.test(input.text);
  const harmful = /不对|不是这样|恢复(?:以前|原来)|别再这样|这样不好|没帮助|反而更麻烦|撤销这个偏好/u.test(input.text);
  if (!helpful && !harmful && input.signal !== "correction") return [];

  const signal = harmful ? "explicit_unhelpful" : helpful ? "explicit_helpful" : "correction";
  const feedbackId = shortId("user-feedback", [input.eventId, input.fielding.receiptId, signal]);
  if (input.records.some(item => item.record === "policy_feedback" && item.feedback.feedbackId === feedbackId)) return [];

  return [{ record: "policy_feedback", feedback: { feedbackId, sourceEventId: input.eventId,
    ...(input.sourceEvidenceId === undefined ? {} : { sourceEvidenceId: input.sourceEvidenceId }),
    receiptId: input.fielding.receiptId, versionId: input.fielding.versionId, scopeFingerprint: input.fielding.scopeFingerprint,
    // Exposure is not attribution. Only a later source-grounded semantic revision
    // may target one policy; a generic complaint remains an observation.
    ruleIds: input.fielding.ruleIds, signal, disposition: "observe", at: input.at } }];
}

export function userSourcePrefix(records: readonly UserLearningRecord[], workspaceId: string): string {
  const scope = fingerprintScopeV2({ workspaceId });
  const refs = records.flatMap(item => item.record === "evidence" && item.evidence.source.workspaceId === workspaceId
    ? [[item.evidence.id, item.evidence.sourceHash]] : item.record === "policy_feedback" && item.feedback.scopeFingerprint === scope ? [[item.feedback.feedbackId]] : []);
  return `user-source:${sha256Hex(JSON.stringify(refs))}`;
}
