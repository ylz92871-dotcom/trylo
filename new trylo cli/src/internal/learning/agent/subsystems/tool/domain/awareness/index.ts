/**
 * 意识层（P05 工具学习规格 §2 + §5）的对外面。
 *
 * 出口刻意窄：只导出「怎么判」和「判要用的形状」，不导出任何 IO、任何写路径、
 * 任何执行环类型。上一层（组合层）拿到的是纯函数，所以「Agent 只提议、换与升级
 * 要用户授权」在这里是字面事实，而不是一句要记得遵守的纪律。
 */

export {
  CRYSTAL_MIN_SUCCESSES,
  DAILY_PROPOSAL_LIMIT,
  PER_TOOL_PROPOSALS_PER_RUN,
  PROPOSAL_COOLDOWN_MS,
  TOOL_FAILURE_THRESHOLD,
} from "./constants.js";
export { assessToolAwareness, objectiveSignalOf, signalClassOf, type AwarenessInput } from "./corroboration.js";
export { decideProposalAction, type DecisionInput, type ProposalAction } from "./decision.js";
export { tallyToolFailures, toolsAtOrOverThreshold } from "./failure-stats.js";
export { observationKindFor, observationsFromFailures } from "./gap-adapt.js";
export { parseSelfReport } from "./self-report.js";
export {
  admitProposal,
  type ProposalRecord,
  type ThrottleDenial,
  type ThrottleInput,
  type ThrottleVerdict,
} from "./throttle.js";
export type {
  AwarenessOutcome,
  FailureFact,
  FailureTally,
  ObjectiveSignal,
  SelfReport,
  SignalClass,
  TaskScope,
} from "./types.js";
