import { createSkillLearningGrant, SkillLearningGrantError } from "../../integration/skill-learning/grant-runtime.js";
import { withSkillLearningGrant } from "../../integration/skill-learning/grant-provider.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { CliContext } from "./context.js";
import { skillDailyBoard } from "./skill-daily-board.js";

type Allowance = { readonly maxTokens: number; readonly maxCalls: number };

type Paths = { readonly boardRoot: string; readonly workspaceId: string };

/** Runtime request identity and Board money. This object owns no asset or permission. */
export function createSkillDailyBudget(ctx: Pick<CliContext, "now" | "newId">, paths: Paths) {
  const runtime = createSkillLearningGrant({ board: skillDailyBoard(paths.boardRoot), workspaceId: paths.workspaceId,
    now: () => new Date(ctx.now()).toISOString() });
  let request: { readonly grantId: string; readonly sourceRef: string; readonly allowance: Allowance } | undefined;

  return {
    async open(allowance: Allowance, sourceRef?: string) {
      if (request !== undefined) {
        if (allowance.maxCalls > request.allowance.maxCalls || allowance.maxTokens > request.allowance.maxTokens) throw new SkillLearningGrantError("learning_grant_conflict");
        return request.grantId;
      }

      // Zero-model correction invalidation can run without allocating money.
      if (allowance.maxCalls === 0 || allowance.maxTokens === 0) return undefined;

      const source = sourceRef ?? `skill-command:${ctx.newId("skill-request")}`;
      const grantId = `skill-grant:${contentHashOf([paths.workspaceId, source]).slice(0, 32)}`;
      const opened = await runtime.open({ grantId, sourceRef: source, maxCalls: allowance.maxCalls, maxOutputTokens: allowance.maxTokens });
      if (!opened.ok) throw new SkillLearningGrantError(opened.code);

      request = { grantId, sourceRef: source, allowance };

      return grantId;
    },

    guard(provider: ProviderPort): ProviderPort {
      if (request === undefined) throw new SkillLearningGrantError("learning_grant_not_found");
      return withSkillLearningGrant(provider, { runtime, grantId: request.grantId,
        reservationIdFactory: () => ctx.newId("skill-model-call") });
    },

    async usage() {
      if (request === undefined) return { calls: 0, tokens: 0, outputTokens: 0, reported: true, status: "unallocated" as const };

      const result = await runtime.read(request.grantId);
      if (!result.ok) throw new SkillLearningGrantError(result.code);

      const snapshot = result.snapshot;

      return { grantId: request.grantId, calls: snapshot.callsReserved, tokens: snapshot.reportedTotalTokens,
        outputTokens: snapshot.reportedOutputTokens, reported: snapshot.reservations.every(item => item.state === "reported"),
        status: snapshot.status, allowance: snapshot.allowance };
    },

    async close(reason: "completed" | "cancelled" | "failed" = "completed") {
      if (request === undefined) return;
      const result = await runtime.close({ grantId: request.grantId, reason });
      if (!result.ok) throw new SkillLearningGrantError(result.code);
    },
  };
}
