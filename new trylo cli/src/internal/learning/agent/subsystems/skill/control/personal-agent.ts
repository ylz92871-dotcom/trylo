import type { CentralLearningAllowance } from "../../../../control/coordination-contract.js";
import type { createSkillCoordination } from "./coordination.js";
import type { SkillDispatchResult, SkillFocus } from "./contracts.js";

type Decision = Omit<SkillFocus, "allowance">;

type Options = {
  readonly coordination: Pick<ReturnType<typeof createSkillCoordination>, "focus">;
  readonly grantId: string;
  readonly allowance?: CentralLearningAllowance;
  readonly runFocused: (issueId: string, signal: AbortSignal) => Promise<SkillDispatchResult>;
  readonly dispatchFunded: (signal: AbortSignal) => Promise<SkillDispatchResult>;
};

/** One explicit host allocation per invocation; reports and PA retries cannot create another purse. */
export function createSkillPersonalAgentFocus(options: Options) {
  return {
    async focus(input: Decision, signal: AbortSignal): Promise<SkillDispatchResult> {
      if (signal.aborted) return { ok: false, reason: "learning_aborted" };
      if (options.allowance === undefined) return { ok: false, reason: "skill_learning_allowance_required" };
      const focused = await options.coordination.focus({ ...input, allowance: options.allowance }, { grantId: options.grantId });
      return focused.ok ? options.runFocused(focused.issue.issueId, signal) : focused;
    },
    resume: options.dispatchFunded,
  };
}
