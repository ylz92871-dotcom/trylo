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
} from "../domain/awareness/index.js";
import { TOOL_GAP_FENCE, type ToolGapPort } from "../domain/awareness/port.js";
import { proposalHistoryOf, type ToolLedgerPort } from "./ledger-file.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolExecutionFact, decodeToolOpportunityReport, type ToolExecutionFact, type ToolOpportunityEvidence } from "../domain/awareness/opportunity.js";
import { bindToolOpportunity, type ToolOpportunityInput, type ToolOpportunityResult } from "./opportunity-runtime.js";
import type { ToolPort, ToolBinding } from "../../../../../ports/tools.js";
import type { ToolObservedCapability } from "../domain/awareness/observed-catalog.js";
import { captureObservedCatalog } from "./observed-catalog.js";
import { captureToolTaskText, type ToolTaskText } from "../domain/awareness/task-text.js";

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
  readonly decisionHistory?: (tool: string | undefined) => Promise<{ readonly refinementAttemptedFor: readonly string[]; readonly successfulTrajectories: number }>;
};

export type ToolGapRuntime = {
  readonly captureCatalog?: (turnId: string, bindings: readonly ToolBinding[]) => void;
  /** Called only by the host's verified current user-text boundary. */
  readonly captureTask?: (turnId: string, text: string) => void;
  readonly toolsForTask?: (taskId: string) => ToolPort;
  /** 交给执行环的那一份（形状与 `loop/tool-gap-port.ts` 互相可赋值）。 */
  readonly port: ToolGapPort;
  /** 这一进程里已提出的提议（读一次，给 doctor 之类用）。 */
  readonly proposals: () => readonly ProposalRecord[];
  /** 本进程已接纳提议的只读快照；保留领域层选出的信号与证据，不拥有执行权。 */
  readonly proposalDetails: () => readonly ToolGapProposalDetail[];
  readonly reportOpportunity: (input: ToolOpportunityInput) => Promise<ToolOpportunityResult>;
  readonly close: () => Promise<void>;
};

export type ToolGapProposalDetail = {
  readonly record: ProposalRecord;
  readonly signal: ObjectiveSignal;
  readonly selfReport: SelfReport;
  readonly evidenceRefs: readonly string[];
  readonly scope: TaskScope;
  readonly action: ProposalAction;
  readonly opportunity?: ToolOpportunityEvidence;
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
  readonly executions: ToolExecutionFact[];
  readonly opportunityReports: Set<string>;
  semanticPrompted: boolean;
  semanticPromptBeat?: number;
  /** 频控要的历史。第一次 `observe` 时从账里读一次，之后只追加。 */
  history: readonly ProposalRecord[] | undefined;
  details: readonly ToolGapProposalDetail[];
  catalog?: readonly ToolObservedCapability[];
  task?: ToolTaskText;
};

export function createToolGapRuntime(host: ToolLearningHost): ToolGapRuntime {
  const turns = new Map<string, TurnSlot>();
  let closed = false, unavailable = false;

  const slotOf = (turnId: string): TurnSlot => {
    const found = turns.get(turnId);
    if (found !== undefined) {
      return found;
    }

    const fresh: TurnSlot = { failures: [], executions: [], opportunityReports: new Set(), semanticPrompted: false, history: undefined, details: [] };

    turns.set(turnId, fresh);

    return fresh;
  };

  const intends = (turnId: string, beat: number): boolean => {
    if (closed || unavailable) return false;

    const slot = turns.get(turnId);
    if (slot === undefined) {
      return false;
    }

    if (beat >= 2 && slot.executions.length > 0 && (!slot.semanticPrompted || slot.semanticPromptBeat === beat)) return true;

    if (slot.failures.length === 0) return false;

    const adapted = observationsFromFailures(slot.failures, scopeOf(CAPABILITY_PLACEHOLDER), isoNow());
    if (!adapted.ok) {
      return false;
    }

    const signal = objectiveSignalOf(adapted.value, slot.failures);

    return signal.ok && signal.value !== undefined;
  };

  const port: ToolGapPort = {
    intentOn: (turnId, beat) => intends(turnId, beat),

    requestPrompt: async (request) => {
      if (!intends(request.turnId, request.beat)) return undefined;
      slotOf(request.turnId).semanticPrompted = true;
      slotOf(request.turnId).semanticPromptBeat = request.beat;
      return { role: "system", content: instruction() };
    },

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

    for (const raw of report.executions ?? []) {
      const fact = decodeToolExecutionFact(raw);
      if (fact !== undefined && !slot.executions.some(item => item.toolCallId === fact.toolCallId)) slot.executions.push(fact);
    }

    if (slot.executions.length > 128) slot.executions.splice(0, slot.executions.length - 128);

    const reportBody = payloadOf(report.selfReport);
    if (decodeToolOpportunityReport(reportBody) !== undefined) {
      await reportOpportunity({ turnId: report.turnId, reportId: `${report.turnId}:${report.beat}`, source: "model", report: reportBody });
      return;
    }

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
    opportunity?: ToolOpportunityEvidence,
  ): Promise<boolean> {
    const slot = slotOf(turnId);

    slot.history ??= host.ledger.history === undefined ? proposalHistoryOf(await host.ledger.tail()) : await host.ledger.history();
    const selectedTool = proposal.signal.kind === "failure" ? proposal.signal.tally.tool
      : proposal.report.kind === "improve_tool" ? proposal.report.tool : undefined;
    const decisionHistory = await host.decisionHistory?.(selectedTool);
    const action = decideProposalAction({
      // 领域层已按工具/能力选定客观信号；组合层不得拿第一条失败或自报重建它。
      signal: proposal.signal,
      report: proposal.report,
      refinementAttemptedFor: decisionHistory?.refinementAttemptedFor ?? [],
      successfulTrajectories: decisionHistory?.successfulTrajectories ?? 0,
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
      return false;
    }

    const pipelinePlan: ToolLearningPlan | undefined = host.pipelineScope === undefined ? undefined : {
      type: "tool_learning_plan", schemaVersion: 1, scope: host.pipelineScope, capability: scope.capability, createdAt: at,
      trigger: { runId: turnId, proposalKey: key, action: action.kind, evidenceRefs: proposal.evidenceRefs,
        ...(tool === undefined ? {} : { tool }) },
      ...(opportunity === undefined ? {} : { opportunity }),
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
      ...(opportunity === undefined ? {} : { opportunity }),
    }];
    slot.history = [...slot.history, record];
    host.warn(`tool learning: proposal ${action.kind} — ${describe(action, scope.capability)}\n`);

    return true;
  }

  async function reportOpportunity(input: ToolOpportunityInput): Promise<ToolOpportunityResult> {
    if (closed || unavailable) return { kind: "ignored", reason: "closed" };

    const slot = slotOf(input.turnId);
    if (slot.opportunityReports.has(input.reportId)) return { kind: "ignored", reason: "duplicate" };

    const bound = bindToolOpportunity(input, slot.executions, slot.catalog, slot.task);
    if ("kind" in bound) return bound;

    const assessment = bound.assessment;
    const opportunity = bound;
    const report: SelfReport = assessment.tool === undefined ? { kind: "new_tool", need: assessment.need }
      : { kind: "improve_tool", tool: assessment.tool, need: assessment.need };
    const accepted = await recordProposal(input.turnId, scopeOf(capabilityOf(report, [])), { kind: "proposal", report,
      signal: { kind: "opportunity", evidence: opportunity }, evidenceRefs: [`opportunity:${bound.reportId}`,
        ...bound.executions.map(fact => `tool-call:${fact.toolCallId}`)] }, opportunity);

    slot.opportunityReports.add(input.reportId);

    return accepted ? { kind: "accepted", reportId: input.reportId } : { kind: "ignored", reason: "throttled" };
  }

  return {
    port,
    captureCatalog: (turnId, bindings) => {
      if (closed || unavailable) return;
      try { slotOf(turnId).catalog = captureObservedCatalog(bindings); }
      catch {
        // Visibility is optional evidence. Its serialization must not take over
        // the ordinary task's execution or invent facts about missing tools.
        delete slotOf(turnId).catalog;
        host.warn("tool learning: mounted-tool visibility could not be captured; no absence conclusion was recorded");
      }
    },
    captureTask: (turnId, text) => {
      if (closed || unavailable) return;

      const slot = slotOf(turnId);

      try {
        const task = captureToolTaskText(turnId, text);
        if (task === undefined) delete slot.task; else slot.task = task;
      } catch {
        delete slot.task;
        host.warn("tool learning: user task text could not be captured; no independent task requirement was recorded");
      }
    },
    reportOpportunity,
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
    '- 工具没有报错，但任务中出现值得复用的重复劳动、绕行或不足：{"kind":"opportunity","need":"<希望改善的能力>","reason":"<结合本任务事实说明原因>","tool":"<可选工具名>","toolCallIds":["<真实调用ID>"],"existingCapability":"insufficient|configuration_sufficient|unknown","expectedBenefit":"<预期收益，尚未证实>"}',
    "只报告一项有实际任务依据且值得改善的机会。已有工具调整配置即可解决时写 configuration_sufficient，不创建学习任务；成功本身不需要报告。",
    "",
    `格式（围栏标记逐字如此）：${"```"}${TOOL_GAP_FENCE}`,
    "没有就说没有——不要为了写而写。",
  ].join("\n");
}
