import type { RunCommandOptions } from "./args-primitives.js";
import type { LearningSwitch } from "../../integration/user-learning/switch.js";

/** Session replacements keep the user's explicit switches and ceilings, never a live claim or worker. */
export type SessionLearningOptions = Pick<RunCommandOptions,
  "centralLearning" | "centralLearningThoughtMaxTokens" | "learning" | "skillLearningAllowance" | "workflowLearning" | "workflowLearningBudget" | "workflowLearningBudgetId" | "collaborationLearning">;

export function sessionLearningOptions(source: SessionLearningOptions): SessionLearningOptions {
  return {
    ...(source.centralLearning === undefined ? {} : { centralLearning: source.centralLearning }),
    ...(source.centralLearningThoughtMaxTokens === undefined ? {} : { centralLearningThoughtMaxTokens: source.centralLearningThoughtMaxTokens }),
    ...(source.learning === undefined ? {} : { learning: source.learning }),
    ...(source.skillLearningAllowance === undefined ? {} : { skillLearningAllowance: source.skillLearningAllowance }),
    ...(source.workflowLearning === undefined ? {} : { workflowLearning: source.workflowLearning }),
    ...(source.workflowLearningBudget === undefined ? {} : { workflowLearningBudget: source.workflowLearningBudget }),
    ...(source.workflowLearningBudgetId === undefined ? {} : { workflowLearningBudgetId: source.workflowLearningBudgetId }),
    ...(source.collaborationLearning === undefined ? {} : { collaborationLearning: source.collaborationLearning }),
  };
}

/** A replacement REPL session keeps the same explicit learning configuration. */
export function replSessionOptions(sessionId: string, learning?: LearningSwitch, options: SessionLearningOptions = {}): RunCommandOptions {
  return { message: [], readStdin: false, session: sessionId, ...sessionLearningOptions(options),
    ...(learning === undefined ? {} : { learning }) };
}
