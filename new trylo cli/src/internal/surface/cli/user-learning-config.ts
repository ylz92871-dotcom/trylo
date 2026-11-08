import path from "node:path";
import {
  createFileFactStore,
  createFileLedgerPort,
  createUserLearningRuntime,
  createUserMemoryService,
  createUserLearningPeer,
  readPendingUserClarification,
  type UserLearningPeerDeps,
  type UserLearningRuntime,
  type UserMemoryService,
  type UserMemoryTurn,
} from "../../integration/user-learning/index.js";
import { DEFAULT_METHOD_GRANT } from "../../learning/method/contracts.js";
import { decideScopeV2 } from "../../learning/domains/user/scope-v2.js";
import {
  createCeilingBudgetPort,
  createFlagCollectionPort,
  createLocalWorkOrderPort,
} from "../../learning/domains/user/index.js";
import { methodLearningRoot } from "./learning-sink.js";

/**
 * 用户学习的宿主侧装配：把「家在哪、总顶多大、谁在听降级」这三样宿主才知道的事，
 * 补成一个能跑的运行时。
 *
 * 三件事钉在这里：
 *
 *  - **家只有一个公式。** 用户账的根是 `methodLearningRoot(...)/user`，而
 *    `methodLearningRoot` 又是 `tryloHome(...)/learning` 的唯一一份。本文件不重拼
 *    任何一段路径，于是 `TRYLO_HOME` 被设置的那天不会出现「两个家只搬一个」。
 *  - **总顶与 LLM 无关、但与方法子系统的槽同一个数。** 直接取
 *    `DEFAULT_METHOD_GRANT.slotChars`，不写第二个字面量：D4 要的是「用户政策段与
 *    方法槽共享一个总预算顶」，那就得真的是同一个数，而不是两个碰巧相等的数。
 *  - **用户身份不由这里发明。** CLI 没有学习侧的用户账号，所以取 `scope-v2` 自己
 *    的默认身份（`decideScopeV2` 不给 userId 时那个值）——调用它一次，而不是抄一个
 *    字面量过来。
 */

/** 用户账的根：`tryloHome/learning/user`。 */
export function userLearningRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(methodLearningRoot(homeDir, env), "user");
}

/** 共享总顶。与方法槽同源，见文件头第二条。 */
export const USER_POLICY_CEILING_CHARS = DEFAULT_METHOD_GRANT.slotChars;

/** 宿主交给组合根的那半个用户学习开关。 */
export type UserLearningHost = {
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspaceId: string;
  readonly now: () => number;
  /** 降级说给谁听。每次运行最多一行。 */
  readonly warn: (message: string) => void;
};

/**
 * 默认四端口：旗门 + 硬顶 + 本地工单 + 本地账。
 *
 * 四条都给 `true` / 常量，是因为「没有控制板」时的正确默认就是**全开、按硬顶**；
 * 一个默认就拒绝的端口会让子系统在没人接管时永远不动，那不是保守，是坏掉。控制板
 * 以后实现这四份接口即接管——`UserLearningHost` 里没有一处能表达「谁来管」，那个
 * 问题的答案在调用方（测试用 stub，生产用这份默认）。
 */
export function createUserLearningRuntimeFor(host: UserLearningHost): UserLearningRuntime {
  return createUserLearningRuntime({
    ports: {
      collection: createFlagCollectionPort(true),
      budget: createCeilingBudgetPort(USER_POLICY_CEILING_CHARS),
      workOrder: createLocalWorkOrderPort(true, USER_POLICY_CEILING_CHARS),
      ledger: createFileLedgerPort(userLearningRoot(host.homeDir, host.env)),
    },
    userId: decideScopeV2({ workspaceId: host.workspaceId }).identity.userId,
    workspaceId: host.workspaceId,
    now: host.now,
    warn: host.warn,
    policyMode: "learned",
  });
}

/** Independent central composition uses the same private ledger as normal task capture. */
export function createUserLearningPeerFor(host: UserLearningHost,
  model: Pick<UserLearningPeerDeps, "provider" | "model" | "maxOutputTokens" | "funding" | "fundingOwnerId" | "enabled">) {
  return createUserLearningPeer({ ...model, ledger: createFileLedgerPort(userLearningRoot(host.homeDir, host.env)),
    userId: decideScopeV2({ workspaceId: host.workspaceId }).identity.userId,
    workspaceId: host.workspaceId, now: host.now });
}

export function readUserLearningClarificationFor(host: UserLearningHost) {
  return readPendingUserClarification({ ledger: createFileLedgerPort(userLearningRoot(host.homeDir, host.env)),
    userId: decideScopeV2({ workspaceId: host.workspaceId }).identity.userId, workspaceId: host.workspaceId });
}

/**
 * 正式用户记忆：显式"请记住 / 改正 / 撤回"的唯一写入口。
 *
 * 与 `createUserLearningRuntimeFor` 分开构造，是因为两者的生命周期不同：运行时
 * 是"每一拍都可能写证据"的观察者，记忆服务是"一轮可能被调用零次"的命令端点。
 * 但它们**指向同一个家**——`userLearningRoot` 只算一次，事实与账本不会分家。
 *
 * 开关值由调用方传入而不是从 `UserLearningHost` 里猜：宿主那一层才知道
 * `--learning` 实际取了什么值，猜一个就等于允许"UI 看着开着、运行时其实关着"。
 */
export function createUserMemoryFor(
  host: UserLearningHost,
  input: { readonly switchValue: string; readonly turn: UserMemoryTurn },
): UserMemoryService {
  return createUserMemoryService({
    store: createFileFactStore(userLearningRoot(host.homeDir, host.env)),
    userId: decideScopeV2({ workspaceId: host.workspaceId }).identity.userId,
    workspaceId: host.workspaceId,
    now: host.now,
    switchValue: input.switchValue,
    turn: input.turn,
  });
}
