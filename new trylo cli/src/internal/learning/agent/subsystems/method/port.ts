import type {
  LabelVocabulary,
  MethodCard,
  ObservedFact,
  VariantRecord,
} from "./domain/contracts.js";

/**
 * 学习侧的对外声明。
 *
 * 本接口与冻结执行侧 `loop/method-port.ts` 保持结构兼容，两边互不 import。
 * `loop/method-port.contract.test.ts` 要求双向可赋值，防止两份声明漂移。
 *
 * 执行侧只报告结算事实、索取本拍注入物；情景检索与模型提炼由方法域及其宿主适配器拥有。
 */

/** 一拍执行事实，由执行侧上报。 */
export type MethodBeatReport = {
  readonly executionSpan?: import("./domain/execution-trace.js").MethodExecutionSpan;
  readonly turnId: string;
  /** 1-based 迭代序号：一次 provider 请求加它结算的一切。 */
  readonly beat: number;
  readonly failures: ReadonlyArray<ObservedFact>;
  readonly succeededTools: ReadonlyArray<string>;
  /**
   * 本拍真实的工具目录。
   *
   * 由执行侧上报而不是学习层去取（`tools.snapshot()` 是执行侧的东西），门的第
   * 七条杠拿它挡幻觉工具：卡里点名的工具必须真的在这一拍发得出去。
   */
  readonly toolNames: ReadonlyArray<string>;
  /**
   * 本拍附加通道抽出来的 proposal 原文（严格 JSON 文本）。
   *
   * 缺席（而不是空串）表示这一拍没有产出：模型没写围栏、围栏坏了、或者压根
   * 没带学习意图。三种情况对学习层是同一种事实——这一拍没有卡。
   */
  readonly proposal?: string;
};

/** 一次请求要注入什么，由执行侧提问。 */
export type MethodRequest = {
  readonly previousExecutionSpan?: import("./domain/execution-trace.js").MethodExecutionSpan;
  readonly requestBoundarySequence?: number;
  /** Bounded, ephemeral current-task text for ranking applicability cues. */
  readonly retrievalCue?: string;
  readonly retrievalSequence?: number;
  readonly turnId: string;
  /** 正在构建的那一拍的序号。 */
  readonly beat: number;
  /**
   * 本轮真实存在的工具名。
   *
   * 由执行侧提供而不是学习层去取，因为 `tools.snapshot()` 是执行侧的东西；
   * 学习层拿到的是一份名字集，用它做候选的免费求值。
   */
  readonly toolNames: ReadonlyArray<string>;
};

/** 注入的那一条消息：`system`，且仅此一条。 */
export type MethodMessage = {
  readonly role: "system";
  readonly content: string;
};

/**
 * 一条被真正编进这一拍的 receipt（ME0-1）。
 *
 * `ref` 是本请求内的短引用，其余字段保留档案与真实情境身份。
 * loop 镜像声明不得 import learning；合同测试要求两边互相可赋值。
 *
 * `ref` 只在**本请求**内有效。这不是实现细节，是防止「拿上一个请求的回执来给这
 * 一个请求记账」的那条边界的全部内容——所以接收方判未知引用时，比较对象必须是
 * 本请求发出去的那一组 receipts，而不是任何跨请求的清单。
 */
export type MethodSlotReceipt = {
  readonly ref: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly nicheId: string;
  /** Frozen when the slot is built, carried unchanged to the real-send ledger. */
  readonly binding?: import("./domain/exposure-binding.js").ExperienceExposureBinding;
};

/**
 * 槽的交付物：**文本**与**身份**分开（ME0-1）。
 *
 * 只发 `message` 的那一版，执行侧无从知道「刚才那句话是哪一版的」；而把身份掺
 * 进文本又会让提示词里出现不该出现的内部 ID。所以两者一起交出去，但**只有
 * `message` 进 provider 请求**——receipts 只在执行侧内存里流转，永不进
 * transcript、session、Desktop Protocol 或用户正文。
 *
 * `receipts` 与 `message` 里渲染出来的 `[mN]` **同源同序**（都由
 * `compile.ts` 的 `methodRefOf` 定序），所以二者不必由谁去对齐两个数组。
 */
export type MethodSlotDelivery = {
  readonly message: MethodMessage;
  readonly receipts: ReadonlyArray<MethodSlotReceipt>;
};

/**
 * 一次**真实发送**的通知（ME0-2）。
 *
 * 与 `loop/method-port.ts::MethodFieldingNotice` 同形，由合同测试要求互相可赋值。
 * 执行环在收到本 attempt 的第一条 `stream_start` 之后才发它——在那之前 provider
 * 可能抛错、取消或断开，模型根本没接受这个请求，「上场」不成立。
 *
 * 它**没有** `observedAt`：执行环不读环境时钟，上场时刻由板用它注入的 `now()`
 * 盖章（`board.ts::recordFielding`）。身份由 `attemptId + beat + versionId` 承担，`ref`
 * 只是本请求内的短引用，从不进账。
 */
export type MethodFieldingNotice = {
  readonly attemptId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly receipts: ReadonlyArray<MethodSlotReceipt>;
};

/**
 * 一条帮助自报（ME0-3）。
 *
 * 与 `loop/method-port.ts::MethodFeedbackItem` 同形，由合同测试要求互相可赋值。
 * ref 在执行侧解析为持久 versionId，application 保留自报性质。
 */
export type MethodFeedbackItem = {
  readonly versionId: string;
  readonly helped: boolean;
  readonly application?: import("./domain/application-report.js").MethodApplicationReport;
};

/**
 * 一次**已完成回答**里的帮助自报（ME0-3）。
 *
 * 与 `loop/method-port.ts::MethodFeedbackNotice` 同形，由合同测试要求互相可赋值。
 * 执行环只在流正常收尾之后才发它；attemptId/beat 与上场通知同源，板由它们和 versionId
 * 重新派生出与上场相同的 `exposureId`（`board-write.ts::recordFeedback`），于是反馈
 * 能精确归因到那一次真实展示。它没有 `observedAt`：时刻由板注入的 `now()` 盖章。
 */
export type MethodFeedbackNotice = {
  readonly context?: import("./experience-port.js").ExperienceContext;
  readonly attemptId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly items: ReadonlyArray<MethodFeedbackItem>;
};

/** 一条要注入的方法经验：这一版要说的话，加上它在档里的身份。 */
export type FieldedHint = {
  readonly receipt: MethodSlotReceipt;
  readonly hint: string;
};

/**
 * 板上决策写到哪里去。
 *
 * 由组合根借出，因为学习层不得自己持有 journal：一个没有 sink 的板，它的决策
 * 是不可观察的，所以接线是显式的而不是默认的。载荷是**平**的——板上报的是码与
 * 身份，从不报嵌套文档，于是 sink 能直接接上 loop 的 `emitRaw` 而不必转译。
 */
export type MethodEventPayload = Readonly<Record<string, string | number | boolean>>;

export type MethodEventSink = (kind: string, payload: MethodEventPayload) => void;

export type MethodLearningService = {
  observe(report: MethodBeatReport): Promise<void>;
  /** 本拍是否带着学习意图（决定执行文本要不要装剥离器）。 */
  intentOn(turnId: string, beat: number): boolean;
  /** 编译后的可选确认；旧实现缺省仍按原intent工作，不增加权限。 */
  readonly confirmIntent?: (turnId: string, beat: number) => boolean;
  requestSlot(request: MethodRequest): Promise<MethodSlotDelivery | undefined>;
  /** 真实发送之后落一条持久上场（ME0-2）；写失败只降级，不失败用户任务。 */
  recordFielding(notice: MethodFieldingNotice): Promise<void>;
  /**
   * 回答收尾之后落帮助自报（ME0-3）。
   *
   * 归因不上保持 unknown；false 不变成工具反例或即时淘汰。
   * 持久写口更新反馈投影，endTurn 再按批处理沉降。写失败只降级。
   */
  recordFeedback(notice: MethodFeedbackNotice): Promise<void>;
  endTurn(turnId: string, signal?: AbortSignal): Promise<void>;
};

/**
 * board-writer 是唯一持久写口。settle 只追加中间层/LRU事实；stable 由双门域合同派生。
 */
export type ArchiveLoadResult =
  | {
      readonly ok: true;
      readonly variants: ReadonlyArray<VariantRecord>;
      /**
       * Board 上指向某一版的 `shadow` 激活，`versionId -> activationId`。
       *
       * 本包**不写**它（入档停在最远合法状态，见 `M-RUN.md` §入档落点），但读到
       * 就要如实带出来：档里有没有别的写入者留下的影子证据，是档案读者该知道
       * 的事实，不是可以替它决定的事实。
       */
      readonly shadowActivations: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly reason: string };

export type ArchiveWriteResult =
  | {
      readonly ok: true;
      readonly events: number;
      /**
       * 这一版（或这条证据）**已经在档里**，所以这次写入什么都没改。
       *
       * 它是 `ok` 而不是失败：同一张卡被第二次抽出来（同一 niche、同一句话）不是
       * 错误，是模型重复了自己，而档里那一张已经在。适配器把控制板的
       * `active_content_immutable` / `duplicate_proposal` 读成这个含义——写口的
       * 幂等性由内容身份（`versionId`）承担，不由调用方记得去查重。
       */
      readonly duplicate: boolean;
      /** Canonical post-write view from the persistent writer. */
      readonly variants?: ReadonlyArray<VariantRecord>;
    }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export type CommitCardInput = {
  readonly card: MethodCard;
  readonly nicheId: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly evidenceId: string;
  /** 同 niche 的上一版；没有就是这一 niche 的第一张。 */
  readonly parentVersionId?: string;
  /**
   * 幂等键的根。
   *
   * 同一张卡重放两次（比如进程在入档中途被杀）不会在板上留下第二条生命周期：
   * 适配器由它派生出每条命令的 `commandId`，而 reducer 对已应用的 `commandId`
   * 直接重放。
   */
  readonly writeId: string;
  /** 触发这次入档的失败样本（`tool:code`，不含参数）。 */
  readonly sample: string;
  readonly observedAt: string;
};

export type AccountInput = {
  readonly writeId: string;
  readonly evidenceId: string;
  readonly proposalId: string;
  readonly outcome: "supports" | "counterexamples";
  readonly samples: ReadonlyArray<string>;
  readonly observedAt: string;
};

export type UseInput = {
  /** 幂等键根：同一 exposure 重放得同一 `commandId`。 */
  readonly writeId: string;
  readonly exposureId: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly requestId: string;
  readonly scope: string;
  readonly binding?: import("./domain/exposure-binding.js").ExperienceExposureBinding;
  readonly observedAt: string;
};

export type FeedbackInput = {
  readonly application?: import("./domain/application-report.js").MethodApplicationReport;
  readonly context?: import("./experience-port.js").ExperienceContext;
  readonly observation?: import("./domain/inference.js").MethodObservation;
  readonly writeId: string;
  readonly versionId: string;
  readonly turnId: string;
  readonly helped: boolean;
  readonly exposureId?: string;
  readonly providerAttemptId?: string;
  readonly sourceEventId?: string;
  readonly observedAt: string;
};

export type MethodArchivePort = {
  /** Optional for legacy embedders; production writer always supplies lifecycle maintenance. */
  settle?(input: { readonly turnId: string; readonly observedAt: string }): Promise<ArchiveLoadResult>;
  load(): Promise<ArchiveLoadResult>;
  commitCard(input: CommitCardInput): Promise<ArchiveWriteResult>;
  recordAccount(input: AccountInput): Promise<ArchiveWriteResult>;
  /** 上场记录（M1）：只接受本轮实际展示过的版本，由写口检查。 */
  recordUse(input: UseInput): Promise<ArchiveWriteResult>;
  /** 帮助反馈（M1）：只接受已展示版本；缺失保持 unknown，不当 false。 */
  recordFeedback(input: FeedbackInput): Promise<ArchiveWriteResult>;
};

/**
 * 围栏标记。
 *
 * `loop/method-channel.ts` 用它从执行文本里切出 proposal；这里用它写给模型看。
 * 两边必须逐字相同，而学习层与 loop 不得互 import，所以这个常量在两处各有一
 * 份、由合同测试要求相等（`method-port.contract.test.ts`）。
 */
export { LEARNING_FENCE } from "./domain/message-contract.js";

/**
 * 反馈围栏标记（ME0-3）。
 *
 * `loop/method-feedback-channel.ts` 用它从执行文本里切出模型的帮助自报；这里用它
 * 写给模型看（`feedbackSegment`）。两边必须逐字相同，而学习层与 loop 不得互
 * import，所以这个常量在两处各有一份、由合同测试要求相等。它与 `LEARNING_FENCE`
 * 是**两个不同的围栏**：一个收卡（教学），一个收对已展示卡的帮助自报（反馈）。
 */
export { METHOD_FEEDBACK_FENCE } from "./domain/message-contract.js";

/** 与方法槽一起发出的两段（`§8.4`）。两段都可缺。 */
export type SlotMessageInput = {
  /**
   * 本拍要注入的方法经验，按上场次序。空数组就是空槽。
   *
   * 每一项自带 receipt，而不是把 hints 与 receipts 分成两个平行数组：平行数组
   * 需要「按下标对齐」这条只在人头里成立的约定，而一个 `FieldedHint` 把话说死。
   */
  readonly fielded: ReadonlyArray<FieldedHint>;
  /** 本拍是否带学习意图。 */
  readonly intent: boolean;
  readonly vocabulary: LabelVocabulary;
};

export { methodMessage } from "./orchestration/slot-message.js";
