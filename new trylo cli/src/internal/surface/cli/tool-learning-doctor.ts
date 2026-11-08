import path from "node:path";
import { TOOL_LEDGER_FILE } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { toolLearningRoot } from "./tool-learning-config.js";
import type { DoctorCheck, DoctorIo } from "./doctor.js";

/**
 * `doctor` 里工具学习那一行（TP-1 施工包 §7 待接线清单 N6）。
 *
 * 三条规矩与 `user-learning-doctor.ts` 同源，一条不少：
 *
 *  - **关着的时候一个字都不多说。** 默认分支仍由 `doctor.ts` 打印原来那句（零差异
 *    门把诊断输出也算在内），本文件只在开关真的点了工具学习时才被调用。
 *  - **只报条数，不报正文。** 账里的 `capability` 是模型自己写的一句话，可能捎带
 *    用户的事；诊断会被人贴进 issue，那句话不该那样离开这台机器。所以这里只数
 *    `proposal` / `observation` / `throttled`，**一个 capability 字都不打印**。
 *  - **数得清楚它数的是什么。** 只认三种 `kind`；读不懂的行算 `unreadable` 并如实
 *    报出来，而不是把它们当零。
 */

export type ToolLearningDoctorIo = Pick<DoctorIo, "readFile" | "homeDir" | "env">;

type LedgerCounts = {
  readonly proposal: number;
  readonly observation: number;
  readonly throttled: number;
  readonly unreadable: number;
};

export function toolLearningCheck(io: ToolLearningDoctorIo, switchValue: string): DoctorCheck {
  const root = toolLearningRoot(io.homeDir, io.env);
  const raw = io.readFile(path.join(root, TOOL_LEDGER_FILE));
  const counts = raw === undefined ? undefined : countRecords(raw);
  if (counts === undefined) {
    return {
      id: "learning.tools",
      status: "skip",
      detail: `tool learning wired (${switchValue}); no ledger yet at ${root}`,
    };
  }

  return {
    id: "learning.tools",
    status: counts.unreadable > 0 ? "warn" : "ok",
    detail:
      `tool learning wired (${switchValue}); ` +
      `proposals ${counts.proposal}, observations ${counts.observation}, throttled ${counts.throttled}` +
      `${counts.unreadable > 0 ? `, unreadable ${counts.unreadable}` : ""}; ` +
      "capability text is never printed",
  };
}

/**
 * 数一遍账。
 *
 * 与 `user-learning-doctor.ts` 同型：**不 import** 账本实现，因为它的实现直接读真实
 * 文件系统——用它会把「诊断读的是哪一份」从注入面挪到进程面，测试就再也摆布不了。
 * 代价是这里有一份「认判别字段」的小逻辑，它只用来**计数**，不用来解码内容。
 */
function countRecords(raw: string): LedgerCounts {
  let proposal = 0;
  let observation = 0;
  let throttled = 0;
  let unreadable = 0;

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      unreadable += 1;
      continue;
    }

    const kind =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["kind"]
        : undefined;
    if (kind === "proposal") {
      proposal += 1;
    } else if (kind === "observation") {
      observation += 1;
    } else if (kind === "throttled") {
      throttled += 1;
    } else {
      unreadable += 1;
    }
  }

  return { proposal, observation, throttled, unreadable };
}
