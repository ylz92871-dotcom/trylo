import type { GoalRecord } from "../domain/goal.js";
import type { ToolPort } from "./tools.js";

/** Goal policy at the ordinary execution boundary; never a second loop. */
export interface GoalExecutionPort {
  readonly tools: ToolPort;
  current(): GoalRecord;
  checkpoint(totalTokens: number, attemptId?: string, round?: number): Promise<void>;
  reminder(): string;
}
