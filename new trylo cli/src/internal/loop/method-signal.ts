import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import type { Transcript, TranscriptItem } from "../protocol/transcript.js";
import type { ToolPort } from "../ports/tools.js";
import type { MethodChannel, MethodChannelTake } from "./method-channel.js";
import { createMethodChannel } from "./method-channel.js";
import type { MethodFeedbackChannel } from "./method-feedback-channel.js";
import { createMethodFeedbackChannel } from "./method-feedback-channel.js";
import type { MethodLearningPort, MethodSlotDelivery, MethodSlotMessage } from "./method-port.js";
import type { ToolGapChannel, ToolGapTake } from "./tool-gap-channel.js";
import { createToolGapChannel } from "./tool-gap-channel.js";
import type { ToolGapPort } from "./tool-gap-port.js";
import { projectToolExecutions, toolVersionsOf } from "./tool-execution-projection.js";
import { methodContextCue } from "./method-context-cue.js";
import { methodExecutionSpan, methodRequestBoundary, previousMethodExecutionSpan } from "./method-execution-span.js";

/**
 * 执行侧传感器：一拍结算了什么。
 *
 * 执行环只掌握一件学习侧查不到的事实——哪些工具调用刚结算、它们怎么失败的。
 * 这个文件把那件事从 transcript 尾部投影出来，**就这些**：它不持策略、不做
 * 决定、不调端口。拿到失败之后该怎么办是板的事，而它连板都不能 import
 * （`loop/boundary.test.ts`）。
 *
 * 与 M1 的 `intra-signal.ts` 相比只有两处变化，都是 M2 机理要求的：
 *
 *  - 上报里多了**本拍真实的工具名**。门的第七条杠要拿它挡幻觉工具，而
 *    `tools.snapshot()` 是执行侧的东西，学习层拿不到——所以由这一层随事实一起
 *    报出去，而不是让学习层去取。
 *  - 上报里多了**附加通道抽出的原文**。M1 的卡来自另一枪 LLM；M2 的卡来自这
 *    一拍的正常回答（共枪），所以「这一拍有没有产出」是执行侧的观察，不是学习
 *    层的判断。
 *
 * 两条性质是承重的，逐字保留 M1 的写法：
 *
 *  - **拍域。** 只投影**最近一拍**结算的工具。transcript 是累积的，按 turn 读
 *    会把第一次失败在之后每一拍重报一次，让一次失败看起来像一个模式。由构造
 *    保证：当前拍的工具结果就是尾部连续的 `tool_result` 段。
 *  - **失败闭合带码。** 失败结果读不出失败码时报一次显式的投影失败，**绝不
 *    跳过**：静默丢弃会让传感器的证据取决于工具怎么措辞它的错误。
 */

/** 一条已结算的工具失败，缩到策略会比较的三项。 */
export type ToolFailureFact = {
  readonly tool: string;
  readonly code: string;
  /** 规范化参数 JSON 的哈希；参数本身从不出现。 */
  readonly fingerprint: string;
};

export type FailureProjectionCode = "tool_call_missing" | "failure_code_missing";

type ToolResultItem = Extract<TranscriptItem, { readonly kind: "tool_result" }>;

export type ProjectedBeat = {
  readonly failures: ReadonlyArray<ToolFailureFact>;
  readonly succeededTools: ReadonlyArray<string>;
};

export type FailureProjection =
  | { readonly kind: "ok"; readonly beat: ProjectedBeat }
  | { readonly kind: "unreadable"; readonly code: FailureProjectionCode };

/**
 * 结算一拍时要交给板的东西。
 *
 * 与 M1 的 `IntraTurnObservation` 同形，加了两项执行侧才知道的事实（工具目录、
 * 附加通道产出）。它仍然是**事实**而不是请求：没有一处能让学习层改变这一拍
 * 执行了什么。
 */
export type MethodBeatContext = {
  readonly turnId: string;
  /** 1-based 迭代序号：一次 provider 请求加它结算的一切。 */
  readonly beat: number;
  readonly failures: ReadonlyArray<ToolFailureFact>;
  readonly succeededTools: ReadonlyArray<string>;
  readonly toolNames: ReadonlyArray<string>;
  /** 本拍抽出的 proposal 原文；缺席 = 这一拍没有产出。 */
  readonly proposal?: string;
};

/**
 * 一个失败的失败码。
 *
 * `tool-execution.ts` 保证失败结果的文本以它的码开头（或者以 `code:` 再前缀
 * 一次），所以码就是第一个冒号之前的一切。形状检查是拦住「人话被当成码」的
 * 那一步：码是小写标识符，别的形状意味着传感器说不清哪里失败了。
 */
export function failureCodeOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const colon = trimmed.indexOf(":");
  const candidate = colon === -1 ? trimmed : trimmed.slice(0, colon);

  return /^[a-z][a-z0-9_]*$/.test(candidate) ? candidate : undefined;
}

/**
 * 一次调用的参数身份。
 *
 * 哈希前先规范化键序：同一个调用换了键序仍然是同一个调用，而指纹的全部意义
 * 就是说出这件事。哈希而不是留着 JSON，是为了账与卡里一个参数值都不出现。
 */
export function toolFingerprint(args: JsonObject, length = 16): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex").slice(0, length);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const parts: string[] = [];

  for (const key of Object.keys(value).sort()) {
    const entry = (value as JsonObject)[key];
    if (entry === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }

  return `{${parts.join(",")}}`;
}

export function projectToolFailures(transcript: Transcript): FailureProjection {
  const settled = trailingToolResults(transcript);
  const argumentsById = new Map<string, JsonObject>();

  for (const item of transcript) {
    if (item.kind === "tool_call") {
      argumentsById.set(item.toolCallId, item.arguments);
    }
  }

  const failures: ToolFailureFact[] = [];
  const succeededTools: string[] = [];

  for (const item of settled) {
    if (item.outcome === "succeeded") {
      succeededTools.push(item.name);
      continue;
    }

    if (item.outcome === "cancelled") {
      continue;
    }

    const args = argumentsById.get(item.toolCallId);
    if (args === undefined) {
      return { kind: "unreadable", code: "tool_call_missing" };
    }

    const code = failureCodeOf(item.output);
    if (code === undefined) {
      return { kind: "unreadable", code: "failure_code_missing" };
    }

    failures.push({ tool: item.name, code, fingerprint: toolFingerprint(args) });
  }

  return { kind: "ok", beat: { failures, succeededTools } };
}

/** 尾部连续的已结算工具结果，就是这一拍的。 */
function trailingToolResults(transcript: Transcript): ReadonlyArray<ToolResultItem> {
  const settled: ToolResultItem[] = [];

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item === undefined || item.kind !== "tool_result") {
      break;
    }
    settled.unshift(item);
  }

  return settled;
}

/**
 * 本拍真实存在的工具名。
 *
 * 抛异常的目录不许把 turn 带下水：读不到就是空集，于是卡里点名的工具一个都
 * 认不出来，门会拒掉它——失败方向是「不上场」，不是「上场一张没验证过的
 * 卡」。这与 `request.ts::toolSpecs` 对同一个 `snapshot()` 的处理同一口径。
 */
export function toolNamesOf(tools: ToolPort): ReadonlyArray<string> {
  try {
    return tools.snapshot().map((binding) => binding.name);
  } catch {
    return [];
  }
}

/**
 * What a beat asks the board before it starts, if it asks anything.
 *
 * Both halves answer a question about *this* beat, so both are resolved before
 * the stream opens: the slot goes into the request, the channel decides whether
 * the answering text gets stripped. They are resolved together, and the intent
 * is read before the slot is compiled, so the strip side and the prompt side
 * cannot come away with different answers about whether this beat teaches.
 *
 * Absent port or absent turn is `{}` — no compile, no channel, and the caller's
 * spreads then leave both optional fields off. That is the whole of "learning
 * off" on the execution side: one function call that returns an empty object.
 */
export type Teaching = {
  /**
   * 这一拍的方法槽：一条 `system` **加上**它带出去的身份（ME0-1）。
   *
   * 交付物整体留在这里而不是立刻拆开，是因为拆开之后 receipt 就没有主人：
   * 只有 `message` 进请求，而 `receipts` 要一直活到真实发送那一刻（ME0-2）。
   */
  readonly slot?: MethodSlotDelivery;
  readonly channel?: MethodChannel;
  /**
   * 反馈剥离器（ME0-3）。
   *
   * 与 `channel` 是**两台各自独立的机器**，不共用一个实现：一个从回答里剥出
   * proposal（写给板的），一个剥出帮助自报（写给账的）。只在**这一拍真的编进了
   * receipt** 时才装——没有上场就没有可归因的反馈，装了也只会把正常正文误当围
   * 栏去削。于是「关学习 / 空档」与「开着但这一拍没上场」在剥离这一层同样不可
   * 区分（都不装）。
   */
  readonly feedbackChannel?: MethodFeedbackChannel;
  /**
   * The tool-gap half, resolved in the same call and for the same reason.
   *
   * Two subsystems, one decision point: whatever the tool-gap port says about
   * *this* beat is read here, next to the method intent, so the prompt side and
   * the strip side can never come away with different answers about whether
   * this beat asks for a self-report.
   */
  readonly toolGapSlot?: MethodSlotMessage;
  readonly toolGapChannel?: ToolGapChannel;
};

export async function teachingFor(
  port: MethodLearningPort | undefined,
  toolGap: ToolGapPort | undefined,
  turnId: string | undefined,
  beat: number,
  tools: ToolPort,
  transcript?: Transcript,
): Promise<Teaching> {
  if (turnId === undefined || (port === undefined && toolGap === undefined)) {
    return {};
  }

  const names = toolNamesOf(tools);
  const requested = port !== undefined && port.intentOn(turnId, beat);
  const cue = port === undefined ? undefined : methodContextCue(transcript);
  const boundary = port === undefined ? undefined : methodRequestBoundary(transcript);
  const previousExecutionSpan = port === undefined || transcript === undefined ? undefined : previousMethodExecutionSpan(transcript);
  const slot = port === undefined ? undefined : await port.requestSlot({ turnId, beat, toolNames: names,
    ...cue, ...(boundary === undefined ? {} : { requestBoundarySequence: boundary }),
    ...(previousExecutionSpan === undefined ? {} : { previousExecutionSpan }) });
  const confirmed = port?.confirmIntent?.(turnId, beat) ?? true;
  const channel = requested && confirmed ? createMethodChannel() : undefined;
  // Only a beat that actually fielded a card can receive attributable feedback,
  // so the stripper is installed exactly when there is at least one receipt to
  // resolve a ref against. No receipts -> no channel -> the answer text is never
  // walked for a feedback fence (byte-identical to learning-off, F12).
  const feedbackChannel =
    slot !== undefined && slot.receipts.length > 0
      ? createMethodFeedbackChannel(slot.receipts)
      : undefined;
  const gapChannel = toolGap !== undefined && toolGap.intentOn(turnId, beat) ? createToolGapChannel() : undefined;
  const gapSlot =
    toolGap === undefined ? undefined : await toolGap.requestPrompt({ turnId, beat, toolNames: names });

  return {
    ...(slot === undefined ? {} : { slot }),
    ...(channel === undefined ? {} : { channel }),
    ...(feedbackChannel === undefined ? {} : { feedbackChannel }),
    ...(gapSlot === undefined ? {} : { toolGapSlot: gapSlot }),
    ...(gapChannel === undefined ? {} : { toolGapChannel: gapChannel }),
  };
}

/**
 * 把一拍结算报给板，如果有板的话。
 *
 * 没有端口或没有 turn 就是无事可做、无额度可花——整次调用是一个 no-op，这正
 * 是生产默认（`no_learning`，不接端口）**免费**而不只是**便宜**的原因。
 *
 * 附加通道的降级码也在这里上报：`§5.3` 要求剥不掉的那一段原样外发（那件事由
 * `method-channel.ts` 自己做完了），同时留一条 `observation`。传感器在这里当
 * 一个纯上报口，不再多看那个码一眼——「怎么处置失败」不是它的权限。
 */
export async function reportBeat(host: {
  readonly port: MethodLearningPort | undefined;
  readonly turnId: string | undefined;
  readonly beat: number;
  readonly transcript: Transcript;
  readonly tools: ToolPort;
  readonly take: MethodChannelTake | undefined;
  readonly emit: (kind: string, payload: JsonObject) => void;
}): Promise<void> {
  const { port, turnId } = host;

  if (port === undefined || turnId === undefined) {
    return;
  }

  if (host.take?.code !== undefined) {
    host.emit("observation", {
      degraded: true,
      component: "method_channel",
      reason: host.take.code,
    });
  }

  const projection = projectToolFailures(host.transcript);
  if (projection.kind !== "ok") {
    host.emit("observation", {
      degraded: true,
      component: "method_sensor",
      reason: projection.code,
    });
    return;
  }

  const proposal = host.take?.proposal;
  const executionSpan = methodExecutionSpan(host.transcript);

  await port.observe({
    turnId,
    beat: host.beat,
    failures: projection.beat.failures,
    succeededTools: projection.beat.succeededTools,
    toolNames: toolNamesOf(host.tools),
    ...(executionSpan === undefined ? {} : { executionSpan }),
    ...(proposal === undefined ? {} : { proposal }),
  });
}

/**
 * 把一拍的**自报**报给工具学习的意识层（P05 工具学习规格 §2 源③）。
 *
 * 与 `reportBeat` 分成两个函数而不是合成一个，是因为它们的**触发条件不同**：
 * 方法子系统那条路是「有板就报」，工具学习这条是「接了意识层才报」。合成一个会
 * 让「只接了方法子系统」的默认路径也开始读 transcript 并可能发 observation，
 * 那就破坏了关学习的逐字节一致。所以这一条是纯增量：不接端口 = 一次空转。
 *
 * 投影失败**不**在这里重报——`reportBeat` 已经就同一个投影发过一条 degraded，
 * 同一次读取报两遍只会让线上看起来像两个毛病。
 */
export async function reportToolGapBeat(host: {
  readonly port: ToolGapPort | undefined;
  readonly turnId: string | undefined;
  readonly beat: number;
  readonly transcript: Transcript;
  readonly tools: ToolPort;
  readonly take: ToolGapTake | undefined;
  readonly emit: (kind: string, payload: JsonObject) => void;
}): Promise<void> {
  const { port, turnId } = host;

  if (port === undefined || turnId === undefined) {
    return;
  }

  if (host.take?.code !== undefined) {
    host.emit("observation", {
      degraded: true,
      component: "tool_gap_channel",
      reason: host.take.code,
    });
  }

  const projection = projectToolFailures(host.transcript);
  if (projection.kind !== "ok") {
    return;
  }

  const selfReport = host.take?.selfReport;

  await port.observe({
    turnId,
    beat: host.beat,
    failures: projection.beat.failures,
    toolNames: toolNamesOf(host.tools),
    executions: projectToolExecutions(host.transcript, args => toolFingerprint(args, 64), failureCodeOf, toolVersionsOf(host.tools)),
    ...(selfReport === undefined ? {} : { selfReport }),
  });
}


/**
 * 关上这一 turn 在板上的那一页。
 *
 * M1 在这里丢掉「还在场上」的卡；M2 没有「本 turn 一张」这个状态了（卡过门即
 * 入档，跨 turn 可上场），所以这里只剩账：释放计数、待记账、未消解族。板仍然
 * 拒绝为一个它不持有的 turn 回答任何问题，所以即使一个 turn 没有干净收尾，
 * 它的残留也漏不到下一个 turn——这次调用是收拾干净的那一半，不是保证本身。
 */
export async function reportTurnEnd(
  port: MethodLearningPort | undefined,
  turnId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (port === undefined || turnId === undefined) {
    return;
  }
  await port.endTurn(turnId, signal);
}
