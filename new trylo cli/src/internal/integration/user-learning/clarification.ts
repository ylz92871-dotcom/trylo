import type { LedgerPort } from "../../learning/domains/user/scheduler-ports.js";
import { fingerprintScopeV2 } from "../../learning/domains/user/scope-v2.js";
import { shortId } from "../../learning/domains/shared/hash.js";

/** PA-only private read: no model, funding, central material or inferred answer. */
export function readPendingUserClarification(input: { readonly ledger: LedgerPort; readonly userId: string; readonly workspaceId: string }) {
  const read = input.ledger.read();
  if (!read.ok || read.unreadable > 0) return { status: "unavailable" as const, reason: read.ok ? "user_ledger_unreadable" : read.reason };

  const scope = fingerprintScopeV2({ userId: input.userId, workspaceId: input.workspaceId });
  const progress = read.records.filter(item => item.record === "learning_progress").map(item => item.progress)
    .filter(item => item.scopeFingerprint === scope).at(-1);
  if (progress?.state !== "clarification" || progress.clarification === undefined) return { status: "none" as const };

  return { status: "pending" as const,
    ref: shortId("user-clarification", [progress.questionRef, progress.sourcePrefixRef, String(progress.step)]),
    question: progress.clarification, sourceRefs: [progress.questionRef, progress.sourcePrefixRef],
    instruction: "这是User学习的待澄清问题，不是用户意见；在相关交接处按需询问。当前明确指令优先，沉默和通用yes不作确认。" };
}
