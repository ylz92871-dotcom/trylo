import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProposalRecord } from "../../learning/domains/tool/awareness/index.js";
import type { ToolLearningPlan } from "../../learning/domains/tool/evolution/pipeline.js";
import { decodeLedgerRecord, readPendingToolPlans, readToolLedgerRows, TOOL_LEDGER_MAX_BYTES, ToolOutboxError } from "./outbox-reader.js";

/**
 * 工具学习的本地追加账（P05 工具学习规格 §9「存储走本地 app-data」）。
 *
 * **`node:fs` 只允许出现在组合层**，这是仓库既有的纪律（`learning/io-boundary.test.ts`
 * 把学习层碰 IO 判红，`integration/user-learning/ledger-file.ts` 是同型的先例）。
 * 所以账在组合层，学习层只拿一个端口形状。
 *
 * 账是**追加**的：一条 observation、一条提议、或者一条「本来想提但被频控拦下」。
 * 三种都记，因为三种都要能被追问——只记成功的那一条会让「为什么这个工具有问题却
 * 没提议」变成一个查不出来的问题。
 *
 * 提议那一条**故意长得像 `ProposalRecord`**：频控的判据（冷却按提议身份、每-run
 * 按工具、日上限按全局）要读历史，而历史就是这本账。多一层映射就多一处会漂。
 */

export const TOOL_LEDGER_FILE = "tool-learning.ndjson";

/** 一本账最多回看多少条。够覆盖 7 天冷却与当天日上限，又不至于越读越慢。 */
export const LEDGER_TAIL_RECORDS = 500;

export type ToolLedgerRecord =
  | {
      readonly kind: "observation";
      readonly at: string;
      readonly turnId: string;
      readonly reason: "no_self_report" | "no_objective_signal";
      readonly detail: string;
    }
  | {
      readonly kind: "proposal";
      readonly at: string;
      readonly turnId: string;
      readonly key: string;
      readonly tool?: string;
      readonly action: string;
      readonly capability: string;
      readonly reason: string;
      readonly pipelinePlan?: ToolLearningPlan;
    }
  | { readonly kind: "pipeline_handoff"; readonly at: string; readonly jobId: string; readonly outcome: "accepted" | "rejected"; readonly reason?: string }
  | {
      readonly kind: "throttled";
      readonly at: string;
      readonly turnId: string;
      readonly key: string;
      readonly reason: string;
    };

export type ToolLedgerPort = {
  readonly append: (record: ToolLedgerRecord) => Promise<void>;
  readonly tail: () => Promise<readonly ToolLedgerRecord[]>;
  /** File stores derive frequency history from the bounded complete log, not an evicting UI tail. */
  readonly history?: () => Promise<readonly ProposalRecord[]>;
};

export type ToolFileLedger = ToolLedgerPort & { readonly pendingPlans: () => Promise<readonly ToolLearningPlan[]> };

export function createFileToolLedger(root: string): ToolFileLedger {
  const file = path.join(root, TOOL_LEDGER_FILE);
  return {
    pendingPlans: () => readPendingToolPlans(file),
    history: async () => proposalHistoryOf(await readToolLedgerRows(file)),
    append: async (record) => {
      if (decodeLedgerRecord(record) === undefined) throw new ToolOutboxError("tool_outbox_corrupt");
      const data = `${JSON.stringify(record)}\n`;
      let size = 0;
      try { size = (await stat(file)).size; }
      catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw new ToolOutboxError("tool_outbox_unavailable"); }
      if (Buffer.byteLength(data, "utf8") > 65_536 || size + Buffer.byteLength(data, "utf8") > TOOL_LEDGER_MAX_BYTES) throw new ToolOutboxError("tool_outbox_too_large");
      await mkdir(root, { recursive: true });
      await appendFile(file, data, "utf8");
    },
    tail: async () => {
      const out: ToolLedgerRecord[] = [];
      for (const record of await readToolLedgerRows(file)) { out.push(record); if (out.length > LEDGER_TAIL_RECORDS) out.shift(); }
      return out;
    },
  };
}

/**
 * 账 → 频控要读的历史。
 *
 * 只有 `proposal` 那一种进历史：`observation` 不是提议（它没占额度），`throttled`
 * 更不是——被拦下的那一次如果也算作一次提议，冷却就永远解不开了。
 */
export function proposalHistoryOf(records: Iterable<ToolLedgerRecord>): readonly ProposalRecord[] {
  const out: ProposalRecord[] = [];
  for (const record of records) {
    if (record.kind !== "proposal") {
      continue;
    }
    out.push({
      key: record.key,
      runId: record.turnId,
      proposedAt: record.at,
      ...(record.tool === undefined ? {} : { tool: record.tool }),
    });
  }
  return out;
}
