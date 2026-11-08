import { createToolCentralLearning } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { CentralLearningNominationUnavailable, type CentralLearningExecutionPort } from "./contracts.js";

type ToolExecutionOwner = Pick<ReturnType<typeof createToolCentralLearning>, "nominateResult" | "prepare" | "dispatch" | "observe">;

/** The host supplies the existing pipeline composition, preserving its real provider and Permission. */
export function createCentralToolExecutor(options: Parameters<typeof createToolCentralLearning>[0],
  owner: ToolExecutionOwner = createToolCentralLearning(options)): CentralLearningExecutionPort {
  return { domain: "tool", async nominate(signal) {
    signal.throwIfAborted();
    const result = await owner.nominateResult(signal);
    signal.throwIfAborted();
    if (!result.ok) throw new CentralLearningNominationUnavailable("tool", result.reason);
    return result.issueIds;
  }, prepare: owner.prepare, dispatch: owner.dispatch, observe: owner.observe };
}
