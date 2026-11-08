import type { LearningReceipt, OutcomeObservation, UserEvidence } from "./contracts.js";
import type { UserCycleRecord } from "./learning-cycle-contract.js";

/**
 * 用户学习的四个调度端口 —— 总控制板将来接管的那个 seam（UE-1）。
 *
 * 总纲领 §5.5 把控制板要做的事收成三件：**采集 / 总预算 / 点名子系统并给额度**；
 * 用户学习自己再加一件：**账本**（证据与观察往哪落）。本文件把这四件事写成四个
 * 端口，学习侧只**提问**，不自己决定答案。
 *
 * 三条纪律：
 *
 *  - **端口只回答自己的那一问。** 采集口只说「本次采集开不开」，预算口只说「还有
 *    多少可用」，工单口只说「这次轮不轮到用户学习、给多少额度」，账本口只管存取。
 *    没有任何一个口能看到别人的答案，也就没有任何一个口能替别人做主。
 *  - **默认实现是「最小可用」，不是「占位」。** 旗门（一个布尔）、硬顶（一个上界）、
 *    本地工单（点名就是自己）、内存账（进程内）。控制板以后实现这四份接口即接管，
 *    学习侧一行不用改——这正是 seam 的意义。
 *  - **拒绝即停手。** 三个决定口里任何一个说不，子系统就**整个不跑**：不读账、
 *    不落证据、不产注入。这不是优化，是隐私红线的落点：采集关闭时连一次读都不该
 *    发生，所以「关掉采集还会不会偷偷留痕」这个问题在代码里没有答案可言。
 */

/** 采集口：这一次要不要采集。 */
export type CollectionPort = {
  readonly capture: (request: CaptureRequest) => boolean;
};

export type CaptureRequest = {
  readonly turnId: string;
};

/** 预算口：总共还能花多少字符。`available` 为假即整次不跑。 */
export type BudgetPort = {
  readonly allowance: () => BudgetAllowance;
};

export type BudgetAllowance = {
  readonly available: boolean;
  /** 总顶（字符）。用户策略段与方法槽共享它，见 `prepare.ts`。 */
  readonly totalChars: number;
};

/** 工单口：总控制板点名子系统并给额度。不点名就没有这一次。 */
export type WorkOrderPort = {
  readonly grant: (request: WorkOrderRequest) => WorkOrder | undefined;
};

export type WorkOrderRequest = {
  readonly turnId: string;
  readonly taskText: string;
  readonly scopeFingerprint: string;
};

export type WorkOrder = {
  readonly subsystem: "user";
  /** 本次工单允许的字符数。预算口的总顶仍是硬上界。 */
  readonly chars: number;
};

/** 账本里能出现的东西。闭集，判别联合——新增一种记录要改这里，改不了别处。 */
export type UserLearningRecord =
  | UserCycleRecord
  | { readonly record: "evidence"; readonly evidence: UserEvidence }
  | {
      readonly record: "signal";
      readonly signal: StrongSignalKind;
      /** journal 事件号：这就是「绑运行身份」的坐标。 */
      readonly eventId: string;
      readonly sessionId?: string;
      readonly turnId?: string;
      readonly at: number;
    }
  | {
      readonly record: "policy";
      /** 采用与否、采用哪些规则——**只记身份，不记正文**（D7）。 */
      readonly adopted: boolean;
      readonly ruleIds: readonly string[];
      readonly matched: number;
      readonly chars: number;
      readonly scopeFingerprint: string;
      readonly bundleChecksum: string;
      readonly turnId?: string;
      readonly at: number;
    }
  | { readonly record: "receipt"; readonly receipt: LearningReceipt }
  | { readonly record: "observation"; readonly observation: OutcomeObservation };

/**
 * 强信号闭集（D5：只落强信号，不埋全 trace）。
 *
 * 七个成员对应执行环真的会发生的七件事；`rollback` 在第一版**没有生产来源**
 * （还原是另一条 CLI 命令，不在一次 turn 里，见 `UE-HANDOFF-MANIFEST` 的
 * `OPEN-UE-1`），闭集里留着它是因为账本格式一旦发出去就不好改了。
 */
export const STRONG_SIGNALS = [
  "approve",
  "interrupt",
  "correction",
  "reject",
  "rollback",
  "steer",
  "artifact",
] as const;

export type StrongSignalKind = (typeof STRONG_SIGNALS)[number];

export type LedgerReadResult =
  | {
      readonly ok: true;
      readonly records: readonly UserLearningRecord[];
      /** 读到但读不懂的行数。非零即一次降级，由调用方上报。 */
      readonly unreadable: number;
    }
  | { readonly ok: false; readonly reason: string };

export type LedgerWriteResult =
  | { readonly ok: true; readonly appended: number }
  | { readonly ok: false; readonly reason: string };

/**
 * 账本口：观察与证据的存取。
 *
 * 两个动词之外没有第三个——没有 `delete`、没有 `rewrite`。删除是分域协调操作
 * （V0.3 规格 §治理），不是一次本地文件写；一个没有删除口的账本就是「不做删除」
 * 在接口层面的样子。写入失败 **不抛**：账写不进不该让用户的任务失败。
 */
export type LedgerPort = {
  readonly read: () => LedgerReadResult;
  readonly append: (records: readonly UserLearningRecord[]) => LedgerWriteResult;
};

export type UserLearningPorts = {
  readonly collection: CollectionPort;
  readonly budget: BudgetPort;
  readonly workOrder: WorkOrderPort;
  readonly ledger: LedgerPort;
};

/** 旗门：开关关着就一次都不采集。这是默认实现，也是唯一在没有控制板时该用的。 */
export function createFlagCollectionPort(enabled: boolean): CollectionPort {
  return { capture: () => enabled };
}

/**
 * 硬顶：总预算与已花的差额。
 *
 * 默认实现不记账（`spentChars` 缺省恒 0），因为「已花多少」是每拍的事实，由调用
 * 方按当前请求提供；控制板接管后这里会换成一块真的预算板。
 */
export function createCeilingBudgetPort(
  totalChars: number,
  spentChars: () => number = () => 0,
): BudgetPort {
  return {
    allowance: () => {
      const remaining = Math.max(0, totalChars - spentChars());
      return { available: remaining > 0, totalChars: remaining };
    },
  };
}

/**
 * 本地工单：没有人点名子系统时，开关本身就是那份点名。
 *
 * `chars` 取总顶；于是「预算」与「额度」是两个独立的否决点而不互相替代——这正是
 * 控制板以后要分开管的两件事。
 */
export function createLocalWorkOrderPort(granted: boolean, chars: number): WorkOrderPort {
  return {
    grant: () => (granted ? { subsystem: "user", chars } : undefined),
  };
}

export type MemoryLedgerOptions = {
  readonly seed?: readonly UserLearningRecord[];
  /** 注入一次读失败，用来在用例里证明「读不到就 fail closed」。 */
  readonly readError?: string;
  /** 注入一次写失败，用来证明「账写不进不改变用户任务的结局」。 */
  readonly writeError?: string;
};

/** 内存账：进程内的默认实现，也是接口合同测试里的那把尺子。 */
export function createMemoryLedgerPort(options: MemoryLedgerOptions = {}): LedgerPort {
  let records: UserLearningRecord[] = [...(options.seed ?? [])];
  return {
    read: () =>
      options.readError === undefined
        ? { ok: true, records: [...records], unreadable: 0 }
        : { ok: false, reason: options.readError },
    append: (incoming) => {
      if (options.writeError !== undefined) {
        return { ok: false, reason: options.writeError };
      }
      records = [...records, ...incoming];
      return { ok: true, appended: incoming.length };
    },
  };
}
