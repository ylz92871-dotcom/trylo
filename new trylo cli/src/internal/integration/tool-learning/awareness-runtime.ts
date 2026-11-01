import {
  admitProposal,
  assessToolAwareness,
  decideProposalAction,
  observationsFromFailures,
  objectiveSignalOf,
  parseSelfReport,
  type AwarenessOutcome,
  type FailureFact,
  type ObjectiveSignal,
  type ProposalAction,
  type ProposalRecord,
  type SelfReport,
  type TaskScope,
} from "../../learning/domains/tool/awareness/index.js";
import { TOOL_GAP_FENCE, type ToolGapPort } from "../../learning/domains/tool/awareness/port.js";
import { proposalHistoryOf, type ToolLedgerPort } from "./ledger-file.js";
import type { ToolLearningPlan } from "../../learning/domains/tool/evolution/pipeline.js";

/**
 * 工具学习意识层的运行时（P05 工具学习规格 §2 + §5，TP-1 的**第一次通电**）。
 *
 * 这个文件是「零件 → 生产可达」的那一步。它做四件事，每一件都窄：
 *
 *  - **攒。** 一拍一拍地收失败事实（源① 的原料）与围栏自报（源③ 的原文）。
 *  - **判。** 调用学习层的纯函数：佐证规则 → 决策树 → 频控。
 *  - **记。** 三种结局都进本地账（observation / proposal / throttled）。
 *  - **说。** 提议写一行给用户。**只写一行**：界面（面板、授权确认、进展展示）
 *    按意志脉络 §3 归 desktop 后随，本层不假装有界面。
 *
 * 三条刻意的边界：
 *
 *  - **一拍之内不联网。** `observe` 是执行环 `await` 的，把一次网络往返放进去会
 *    卡住整拍。候选检索是**提议之后**的事（`acquisition-search.ts`），不在拍上。
 *  - **不扩权。** 运行时不下载、不安装、不切换工具。它唯一的输出是一个数据对象
 *    加一行日志。换/升级要用户显式授权——那是另一段接线，且是另一包（OPEN-TP1-11）。
 *  - **缺席即零构造。** 没有 `--learning` 就没有这个运行时：不建目录、不读账、
 *    不写一行。
 */

export type ToolLearningHost = {
  readonly pipelineScope?: string;
  readonly ledger: ToolLedgerPort;
  readonly now: () => number;
  /** 提议与降级说给谁听。每次运行最多几行。 */
  readonly warn: (message: string) => void;
};

export type ToolGapRuntime = {
  /** 交给执行环的那一份（形状与 `loop/tool-gap-port.ts` 互相可赋值）。 */
  readonly port: ToolGapPort;
  /** 这一进程里已提出的提议（读一次，给 doctor 之类用）。 */
  readonly proposals: () => readonly ProposalRecord[];
  /** 本进程已接纳提议的只读快照；保留领域层选出的信号与证据，不拥有执行权。 */
  readonly proposalDetails: () => readonly ToolGapProposalDetail[];
  readonly close: () => Promise<void>;
};

export type ToolGapProposalDetail = {
  readonly record: ProposalRecord;
  readonly signal: ObjectiveSignal;
  readonly selfReport: SelfReport;
  readonly evidenceRefs: readonly string[];
  readonly scope: TaskScope;
  readonly action: ProposalAction;
};

/**
 * 一拍的任务坐标。
 *
 * 第一版的诚实取值：`taskFamily` 是固定的 `"run"`，`capability` 取自模型自报的那
 * 句话。执行环不报这两个事实，而缺口检测只是拿它们**分组**（本层一次只喂一组），
 * 所以它们影响的是提议里给人看的那句话，不是判定。这张表登记为 OPEN-TP1-12：
 * 等执行环能报出真实的任务族，这里换成它。
 */
const TASK_FAMILY = "run";
const CAPABILITY_PLACEHOLDER = "unstated";
/** 自报那句话当 capability 用时截到多长——它是给人看的，不是哈希。 */
const CAPABILITY_MAX_CHARS = 120;

type TurnSlot = {
  readonly failures: FailureFact[];
  /** 频控要的历史。第一次 `observe` 时从账里读一次，之后只追加。 */
  history: readonly ProposalRecord[] | undefined;
  details: readonly ToolGapProposalDetail[];
};

export function createToolGapRuntime(host: ToolLearningHost): ToolGapRuntime {
  const turns = new Map<string, TurnSlot>();
  let closed = false, unavailable = false;

  const slotOf = (turnId: string): TurnSlot => {
    const found = turns.get(turnId);
    if (found !== undefined) {
      return found;
    }
    const fresh: TurnSlot = { failures: [], history: undefined, details: [] };
    turns.set(turnId, fresh);
    return fresh;
  };

  const intends = (turnId: string): boolean => {
    if (closed || unavailable) return false;
    const slot = turns.get(turnId);
    if (slot === undefined || slot.failures.length === 0) {
      return false;
    }
    const adapted = observationsFromFailures(slot.failures, scopeOf(CAPABILITY_PLACEHOLDER), isoNow());
    if (!adapted.ok) {
      return false;
    }
    const signal = objectiveSignalOf(adapted.value, slot.failures);
    return signal.ok && signal.value !== undefined;
  };

  const port: ToolGapPort = {
    intentOn: (turnId) => intends(turnId),

    requestPrompt: async (request) =>
      intends(request.turnId) ? { role: "system", content: instruction() } : undefined,

    observe: async (report) => {
      try { await observeReport(report); }
      catch {
        // Collection cannot invalidate the user's execution or admit against an unreadable history.
        unavailable = true;
        host.warn("tool learning: acceptance recording unavailable; no further proposals this turn");
      }
    },
  };

  async function observeReport(report: Parameters<ToolGapPort["observe"]>[0]): Promise<void> {
    if (closed || unavailable) return;
    const slot = slotOf(report.turnId);
    for (const failure of report.failures) slot.failures.push(failure);
    const reportBody = payloadOf(report.selfReport);
    const scope = scopeOf(capabilityOf(parseSelfReport(reportBody), report.failures));
    const outcome = assessToolAwareness({
      failures: slot.failures, scope, recordedAt: isoNow(),
      ...(reportBody === undefined ? {} : { selfReport: reportBody }),
    });
    if (outcome.kind === "silent") return;
    if (outcome.kind === "observation") {
      await host.ledger.append({ kind: "observation", at: isoNow(), turnId: report.turnId,
        reason: outcome.reason, detail: outcome.detail });
      return;
    }
    await recordProposal(report.turnId, scope, outcome);
  }

  async function recordProposal(
    turnId: string,
    scope: TaskScope,
    proposal: Extract<AwarenessOutcome, { readonly kind: "proposal" }>,
  ): Promise<void> {
    const slot = slotOf(turnId);
    slot.history ??= host.ledger.history === undefined ? proposalHistoryOf(await host.ledger.tail()) : await host.ledger.history();
    const action = decideProposalAction({
      // 领域层已按工具/能力选定客观信号；组合层不得拿第一条失败或自报重建它。
      signal: proposal.signal,
      report: proposal.report,
      refinementAttemptedFor: [],
      // TP-1 手上没有成功轨迹（B 归 TP-2），所以恒走「换 Y」那一支。
      successfulTrajectories: 0,
    });
    const key = actionKey(action, scope.capability);
    const tool = toolOf(action);
    const at = isoNow();
    const verdict = admitProposal({
      candidate: { key, ...(tool === undefined ? {} : { tool }) },
      runId: turnId,
      at,
      history: slot.history,
    });
    if (!verdict.allowed) {
      await host.ledger.append({ kind: "throttled", at, turnId, key, reason: verdict.reason });
      return;
    }
    const pipelinePlan: ToolLearningPlan | undefined = host.pipelineScope === undefined ? undefined : {
      type: "tool_learning_plan", schemaVersion: 1, scope: host.pipelineScope, capability: scope.capability, createdAt: at,
      trigger: { runId: turnId, proposalKey: key, action: action.kind, evidenceRefs: proposal.evidenceRefs,
        ...(tool === undefined ? {} : { tool }) },
    };
    await host.ledger.append({
      kind: "proposal",
      at,
      turnId,
      key,
      ...(tool === undefined ? {} : { tool }),
      action: action.kind,
      capability: scope.capability,
      reason: `tool gap signal for ${scope.capability}`,
      ...(pipelinePlan === undefined ? {} : { pipelinePlan }),
    });
    const record: ProposalRecord = { key, runId: turnId, proposedAt: at, ...(tool === undefined ? {} : { tool }) };
    slot.details = [...slot.details, {
      record,
      signal: proposal.signal,
      selfReport: proposal.report,
      evidenceRefs: proposal.evidenceRefs,
      scope,
      action,
    }];
    slot.history = [...slot.history, record];
    host.warn(`tool learning: proposal ${action.kind} — ${describe(action, scope.capability)}\n`);
  }

  return {
    port,
    proposals: () => [...turns.values()].flatMap((slot) => slot.details.map((detail) => ({ ...detail.record }))),
    // 每次深拷贝隔离调用方，冻结数组避免把一个读快照误作可追加的队列。
    proposalDetails: () => Object.freeze(structuredClone([...turns.values()].flatMap((slot) => slot.details))),
    close: async () => {
      closed = true;
      turns.clear();
    },
  };

  function isoNow(): string {
    return new Date(host.now()).toISOString();
  }
}

export function actionKey(action: ProposalAction, capability: string): string {
  return action.kind === "replace_or_add" ? `${action.kind}:${capability}` : `${action.kind}:${action.tool}`;
}

export function toolOf(action: ProposalAction): string | undefined {
  return action.kind === "replace_or_add" ? undefined : action.tool;
}

function describe(action: ProposalAction, capability: string): string {
  switch (action.kind) {
    case "replace_or_add":
      return `no tool covers "${capability}"`;
    case "light_upgrade":
      return `refine the description of ${action.tool}`;
    case "replace_tool":
      return `replace ${action.tool}`;
    case "heavy_upgrade":
      return `crystallize a replacement for ${action.tool}`;
  }
}

function scopeOf(capability: string): TaskScope {
  return {
    taskFamily: TASK_FAMILY,
    capability,
    // 执行环不报这两个事实，取最保守的默认：普通重要度、有退路。
    // 于是源① 的门槛就是命名常量那一个，不会因为这里被猜出一个 high 而收紧。
    criticality: "normal",
    fallbackAvailable: true,
  };
}

function capabilityOf(report: SelfReport | undefined, failures: readonly FailureFact[]): string {
  const raw = report === undefined ? undefined : report.need;
  const fallback = failures[failures.length - 1]?.tool ?? CAPABILITY_PLACEHOLDER;
  const text = (raw ?? fallback).trim();
  return text.length > CAPABILITY_MAX_CHARS ? text.slice(0, CAPABILITY_MAX_CHARS) : text;
}

/** 围栏里的原文 → 载荷对象。读不出来就是「没自报」，不是错误。 */
function payloadOf(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 请模型自报的那段固定话（规格 §2 源③「run 末给模型一个第二型围栏」）。
 *
 * 它是**固定字符串**，不是每次现编的提示词：一段会变的话意味着「模型为什么写/不写
 * 这个围栏」这件事无法复现，也就无法归因。围栏名与载荷形状在这里写死，与学习侧
 * 的解析器（`awareness/self-report.ts`）是同一份约定。
 */
export function instruction(): string {
  return [
    "如果你在这件事上反复碰到工具方面的问题，可以在回答的最后加一个围栏，用一行 JSON 说清楚。",
    "两种写法，只说一件最要紧的：",
    `- 手上**没有工具**能做这件事：{"need":"新工具:<用一句话说清是什么事>"}`,
    `- 某个工具的**描述总让你用错**：{"need":"改进:<它怎么让你用错的>","tool":"<工具名>"}`,
    "",
    `格式（围栏标记逐字如此）：${"```"}${TOOL_GAP_FENCE}`,
    "没有就说没有——不要为了写而写。",
  ].join("\n");
}
