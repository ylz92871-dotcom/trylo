// 深导入 `file-ledger.js`，不走 `permission-store/index.js` 这个 barrel：barrel 把
// 同目录的 memory-fake 一并再导出，而 `verify.mjs` 的 3-lint-hygiene 有一条成文规则
// ——**生产可达文件不得 import fake 模块**（规则注释原文指向「2026-09 工具链雷的同一
// 形状」）。走 barrel 会让 `index.ts` 变成生产可达，于是内存 fake 被拉进生产 import
// 图。深导入让生产路径只碰真零件，`memory-fake.ts` 留在 test_support。
import {
  createFilePermissionStore,
  type FilePermissionStore,
  type StoreFailure,
} from "../../adapters/permission-store/file-ledger.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { RunFailure } from "./run-failure.js";

/**
 * 持久 Permission 账本的组合根接线。
 *
 * **为什么这里有一个「就绪读取」。** 账本的唯一消费者是工具链的准入门
 * （`tooling/approval/gates.ts`），而工具链整体仍在 deferred 清单里（W6，先要
 * W3 拆雷）。所以本波接通的不是「谁在记账」，而是**账本本身可不可信**：开关打开
 * 意味着「这次运行以这本账为背书」，那么一本读不出来的账必须让运行拒绝启动，
 * 而不是被静默当成「没有账本」——把「账本坏了」伪装成「没有账本」正是本规格
 * §4 R1 与 §7 W1 的禁止项。
 *
 * 就绪读取走 store 自己的读路径（`getGrant`），不是第二个解码器：
 *   - 健康：`{ ok: true, grant: undefined }`（探针引用不可能对应真实授权）；
 *   - 损坏/撕裂/版本不符：`{ ok: false, code }`，分类码原样上报。
 *
 * 它**不写**：`getGrant` 不加锁、不建目录、不产生任何事件，所以「开关打开且账本
 * 健康」的运行与开关关闭的运行在磁盘上完全一致（唯一差别是那条读取）。
 */

/**
 * 探针引用：`deriveGrantId` 的输出恒为 `grant:<24 hex>`，所以任何真实授权都不可能
 * 叫这个名字，健康账本对它的回答必然是「没有这条授权」。
 */
const READINESS_PROBE = "readiness-probe";

export type PermissionLedgerInput = {
  /** 追加式事件文件。签发、撤销与消费共享同一本账。 */
  readonly path: string;
};

/**
 * 借出的类型：组合根用它们标注字段，不必再自己 import 一次 adapter ——
 * 「谁碰 adapter」在这条线上只有一个答案（本模块）。
 */
export type { FilePermissionStore, StoreFailure };

export function openPermissionLedger(input: PermissionLedgerInput): FilePermissionStore {
  return createFilePermissionStore({ path: input.path });
}

/**
 * 这次运行能否以这本账为背书。`undefined` 表示「不需要账本」或「账本健康」。
 *
 * 两个入参都可缺席，且**缺席即关**：开关没打开时 `store` 与 `requested` 都是
 * `undefined`，这个函数一个字节都不读就返回，所以默认路径上不存在任何账本行为。
 */
export async function permissionLedgerRefusal(
  store: FilePermissionStore | undefined,
  requested: PermissionLedgerInput | undefined,
): Promise<RunFailure | undefined> {
  if (store === undefined || requested === undefined) {
    return undefined;
  }

  const failure = await ledgerFailure(store);
  if (failure === undefined) {
    return undefined;
  }

  return {
    // 52 = config：账本的位置来自配置（`TRYLO_HOME` + 开关），它的不可用是运行前
    // 就必须挡住的前提失败，而不是某次工具调用失败。
    exitCode: EXIT_CODES.CONFIG,
    message: `durable permission ledger is unusable: ${failure.code}: ${failure.message}`,
    hint: `repair or delete ${requested.path}; a ledger that cannot be read is never treated as no ledger`,
  };
}

async function ledgerFailure(store: FilePermissionStore): Promise<StoreFailure | undefined> {
  const lookup = await store.getGrant(READINESS_PROBE);
  return lookup.ok ? undefined : { code: lookup.code, message: lookup.message };
}
