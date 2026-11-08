/**
 * 用户学习的组合层（UE-1..UE-4 的接缝都在这一个目录里）。
 *
 * 目录边界与理由：
 *
 *  - `switch.ts` —— `--learning` 的总开关闭集，一个口进、两个子系统分别接。
 *  - `chain.ts` —— 账本内容 → 当前有效政策包（跑一遍 UL 落座的纯域链）。
 *  - `runtime.ts` —— 一次 turn 的三件事：强信号落账 / 每拍注入 / 轮末效果事实。
 *  - `observer.ts` —— journal envelope → 学习侧的事件视图（协议包与学习域在这里碰面）。
 *  - `ledger-file.ts` —— 本地追加账（`node:fs` 只允许出现在这里，见 `learning/io-boundary.test.ts`）。
 *  - `port.ts` —— 把方法槽与用户段合成一个 `system`，共享一个总预算顶。
 *
 * 学习层（`learning/**`）不知道 `node:fs`、不知道 `--learning`、不知道执行环的
 * envelope 长什么样；它只提供纯函数与端口形状。上面每一条「知道」都落在本目录，
 * 也就是落在**组合层**——这正是「学习不伸手进执行、执行不伸手进学习」在文件树上的
 * 样子。
 */

export { deriveUserPolicy, evidenceOf, type DerivedUserPolicy, type DeriveInput } from "./chain.js";
export { createUserLearningPeer, type UserLearningPeer, type UserLearningPeerDeps } from "./peer.js";
export { createUserPeerRuntimeAdapter } from "./central-runtime-adapter.js";
export { USER_PEER_STATUS_READ_CONTRACT_VERSION, USER_PEER_STATUS_READ_CONTRACT } from "./central-status-navigation.js";
export { readPendingUserClarification } from "./clarification.js";
export type { UserLearningSignal, UserPeerProgress, UserLearningVersion } from "../../learning/domains/user/learning-cycle-contract.js";
export { createFileLedgerPort, LEDGER_TAIL_RECORDS, USER_LEDGER_FILE } from "./ledger-file.js";
export {
  createFileFactStore,
  USER_FACTS_FILE,
  type FactAppendResult,
  type FactReadResult,
  type UserFactStore,
} from "./facts-file.js";
export {
  createUserMemoryService,
  type RememberRequest,
  type ReviseRequest,
  type UserMemoryDeps,
  type UserMemoryService,
  type UserMemoryTurn,
} from "./memory-service.js";
export { deleteUserMemory, type MemoryDeleteResult } from "./memory-delete.js";
export {
  decodeLegacyDocument,
  importLegacyFacts,
  legacyRecordId,
  type LegacyDecode,
  type LegacyDecision,
  type LegacyDocument,
  type LegacyFactEntry,
} from "./legacy-import.js";
export { journalEventOf, userLearningObserver } from "./observer.js";
export {
  composeLearningPorts,
  type ComposeLearningInput,
  type LearningPortShape,
} from "./port.js";
export {
  createUserLearningRuntime,
  type UserLearningRuntime,
  type UserLearningRuntimeDeps,
  type UserPolicyInjection,
} from "./runtime.js";
export {
  isLearningSwitch,
  LEARNING_SWITCH_ALL,
  LEARNING_SWITCH_TOOL,
  LEARNING_SWITCH_SKILL,
  LEARNING_SWITCH_USER,
  LEARNING_SWITCH_VALUES,
  LEARNING_SWITCHES,
  methodSwitchFor,
  switchEnablesMethod,
  switchEnablesTool,
  switchEnablesCheck,
  switchEnablesSkill,
  switchEnablesUser,
  type LearningSwitch,
} from "./switch.js";
