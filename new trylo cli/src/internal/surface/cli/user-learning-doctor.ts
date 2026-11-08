import path from "node:path";
import { USER_LEDGER_FILE } from "../../integration/user-learning/ledger-file.js";
import { USER_POLICY_CEILING_CHARS, userLearningRoot } from "./user-learning-config.js";
import type { DoctorCheck, DoctorIo } from "./doctor.js";

/**
 * `doctor` 里用户学习那一行（UE-4 验收 #9）。
 *
 * 三条规矩与 `doctor.ts` 的 `learningCheck` 同源：
 *
 *  - **关着的时候一个字都不多说。** 默认分支仍由 `doctor.ts` 打印原来那句
 *    （零差异门 I1 把诊断输出也算在内），本文件只在开关真的点了用户学习时才被调用。
 *  - **只报事实，不读正文。** 报的是开关、账的根、总顶、最近证据条数。政策正文一个字
 *    都不进诊断——诊断会被人贴进 issue，正文不该那样离开这台机器。
 *  - **数得清楚它数的是什么。** 计数只认 `record === "evidence"` 的行；读不懂的行算
 *    `unreadable` 并如实报出来，而不是把它们当零。
 */

export type UserLearningDoctorIo = Pick<DoctorIo, "readFile" | "homeDir" | "env">;

type LedgerCounts = {
  readonly evidence: number;
  readonly signals: number;
  readonly receipts: number;
  readonly unreadable: number;
};

export function userLearningCheck(io: UserLearningDoctorIo, switchValue: string): DoctorCheck {
  const root = userLearningRoot(io.homeDir, io.env);
  const raw = io.readFile(path.join(root, USER_LEDGER_FILE));
  const counts = raw === undefined ? undefined : countRecords(raw);
  if (counts === undefined) {
    return {
      id: "learning.user_policy",
      status: "skip",
      detail: `user learning wired (${switchValue}); no ledger yet at ${root}`,
    };
  }

  return {
    id: "learning.user_policy",
    status: counts.unreadable > 0 ? "warn" : "ok",
    detail:
      `user learning wired (${switchValue}); ceiling ${USER_POLICY_CEILING_CHARS} chars; ` +
      `evidence ${counts.evidence}, signals ${counts.signals}, receipts ${counts.receipts}` +
      `${counts.unreadable > 0 ? `, unreadable ${counts.unreadable}` : ""}; ` +
      "policy text is never printed",
  };
}

/**
 * 数一遍账。
 *
 * 这里**不 import** 账本实现：`doctor` 的每一个答案都从注入的 `io` 里取，而
 * `ledger-file.ts` 的实现直接读真实文件系统——用它会把「诊断读的是哪一份」从注入
 * 面挪到进程面，测试就再也摆布不了它了。代价是这里有一份「认判别字段」的小逻辑，
 * 它只用来**计数**，不用来解码内容：认不出的行算 `unreadable`。
 */
function countRecords(raw: string): LedgerCounts {
  let evidence = 0;
  let signals = 0;
  let receipts = 0;
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

    const record =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["record"]
        : undefined;
    if (record === "evidence") {
      evidence += 1;
    } else if (record === "signal") {
      signals += 1;
    } else if (record === "receipt") {
      receipts += 1;
    } else if (record !== "policy" && record !== "observation") {
      unreadable += 1;
    }
  }

  return { evidence, signals, receipts, unreadable };
}
