/**
 * 执行侧对学习方法子系统的声明。
 *
 * 与 `learning/method/port.ts` 是一对：那一份说「学习层提供什么」，这一份说
 * 「执行环会调用什么」。**两份都手写、互不 import**，因为 loop 是冻结核心，
 * 学习层不得伸手进去（`loop/boundary.test.ts` 会把任何一条 `loop -> learning`
 * 的 import 判红）。它们只在合同测试里相遇：那里要求两个类型互相可赋值，于是
 * 「声明打架」变成一次编译错误，而不是一次运行时惊喜。
 *
 * 这个口刻意窄。执行环只说三件事：
 *
 *  - 一拍**结算了什么**（工具名、失败事实、附加通道抽出的原文）；
 *  - 这一拍**要不要带学习意图**；
 *  - 这一拍**要注入什么**（一条 `system`，或者什么都不注入）。
 *
 * 它从不告诉学习层一个请求的形状、一个 envelope、一个工具的参数，所以一张学到
 * 的卡永远是一句话，而不是一个能力。这是「执行不被学习污染」（I3）在接口层面
 * 的样子：能传出去的信息里没有一处能改变执行语义。
 */

/**
 * 一条已结算的工具失败事实。
 *
 * 与 `learning/method/contracts.ts::ObservedFact` 同形（`tool`/`code`/
 * `fingerprint`），由合同测试要求互相可赋值。参数本身从不外传——只有它的哈希，
 * 因为账与卡都不该记住用户往工具里塞了什么。
 */
export type ObservedFailureFact = {
  readonly tool: string;
  readonly code: string;
  readonly fingerprint: string;
};

export type MethodExecutionSpan = { readonly firstSequence: number; readonly lastSequence: number;
  readonly toolNames: readonly string[] };

/** 一拍执行事实，由执行侧上报。 */
export type MethodBeatObservation = {
  readonly executionSpan?: MethodExecutionSpan;
  readonly turnId: string;
  /** 1-based 迭代序号：一次 provider 请求加它结算的一切。 */
  readonly beat: number;
  readonly failures: ReadonlyArray<ObservedFailureFact>;
  readonly succeededTools: ReadonlyArray<string>;
  /**
   * 本拍真实的工具目录。
   *
   * 由执行侧上报而不是学习层自己去取（`tools.snapshot()` 是执行侧的东西）。
   * 门的第七条杠拿它挡幻觉工具：卡里点名的工具必须真的在这一拍发得出去。
   */
  readonly toolNames: ReadonlyArray<string>;
  /**
   * 本拍附加通道抽出的 proposal 原文（严格 JSON 文本）。
   *
   * 缺席（而不是空串）表示这一拍没有产出：模型没写围栏、围栏坏了、或者压根没
   * 带学习意图。三种情况对学习层是同一种事实——这一拍没有卡。
   */
  readonly proposal?: string;
};

/** 一次请求要注入什么，由执行侧提问。 */
export type MethodSlotRequest = {
  readonly previousExecutionSpan?: MethodExecutionSpan;
  readonly requestBoundarySequence?: number;
  readonly retrievalCue?: string;
  readonly retrievalSequence?: number;
  readonly turnId: string;
  /** 正在构建的那一拍的序号。 */
  readonly beat: number;
  readonly toolNames: ReadonlyArray<string>;
};

/** 注入的那一条消息：`system`，且仅此一条。 */
export type MethodSlotMessage = {
  readonly role: "system";
  readonly content: string;
};

/**
 * 一条被真正编进这一拍的 receipt（ME0-1）。
 *
 * 与 `learning/method/port.ts::MethodSlotReceipt` 同形，由合同测试要求互相可
 * 赋值——两份都是手写的，因为 loop 不得 import learning。
 *
 * `ref` 只在本请求内有效：判「未知引用」时要比对的是**本请求发出去的那一组**，
 * 不是任何跨请求的清单。
 */
export type MethodSlotReceipt = {
  readonly ref: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly nicheId: string;
  /** Opaque learning provenance. The execution loop only transports it. */
  readonly binding?: {
    readonly compilationId?: string;
    readonly requestBoundarySequence?: number;
    readonly context: {
      readonly taskId: string; readonly opportunityId: string; readonly situation: string;
      readonly features: Readonly<Record<string, string>>;
    };
  };
};

/**
 * 槽的交付物：**文本**与**身份**分开（ME0-1）。
 *
 * 只有 `message` 进 provider 请求；`receipts` 只在执行侧内存里流转，永不进
 * transcript、session、Desktop Protocol 或用户正文。执行侧拿到身份，是为了在
 * 真实发送之后能说出「刚才那句话是哪一版的」（ME0-2）。
 */
export type MethodSlotDelivery = {
  readonly message: MethodSlotMessage;
  readonly receipts: ReadonlyArray<MethodSlotReceipt>;
};

/**
 * 一次**真实发送**的通知（ME0-2）。
 *
 * 执行环在收到本 attempt 的第一条 `stream_start` 之后才发它：在那之前 provider
 * 可能抛错、取消或断开，那时模型根本没接受这个请求，「上场」不成立。所以这条
 * 通知携带的正是「刚刚真的发出去的那一组身份」——`attemptId` 界定是哪一次发送
 * （重放幂等的根），`receipts` 是这一请求真正编进槽的那些版本。
 *
 * 它**刻意没有** `observedAt`：执行环不读环境时钟（`verify` step 3 会拒），上场
 * 的时刻由学习侧用它自己注入的 `now()` 盖章。与 `learning/method/port.ts` 的同名
 * 声明互相可赋值，由合同测试钉住。
 */
export type MethodFieldingNotice = {
  readonly attemptId: string;
  readonly turnId: string;
  /** 1-based 迭代序号：与 `MethodSlotRequest.beat` 同一口径。 */
  readonly beat: number;
  readonly receipts: ReadonlyArray<MethodSlotReceipt>;
};

/**
 * 一条帮助自报（ME0-3）。
 *
 * 与 `learning/method/port.ts::MethodFeedbackItem` 同形，由合同测试要求互相可赋值。
 * 这里携带的是 **versionId 而不是 ref**：ref 只在本请求内有效（见
 * `MethodSlotReceipt`），把 ref 对回 versionId 的解析发生在执行侧的反馈剥离器
 * （`method-feedback-channel.ts`）里，账只认持久身份。
 */
export type MethodFeedbackItem = {
  readonly versionId: string;
  readonly helped: boolean;
  /** Actual practice/observed result self-report; never a tool-success claim. */
  readonly application?: { readonly practice: string; readonly result: string };
};

/**
 * 一次**已完成回答**里的帮助自报（ME0-3）。
 *
 * 执行环只在流正常收尾（`sawFinish`）之后才发它：被切断、取消或出错的理解不构成
 * 「模型对这一回答的自报」，那时反馈保持 unknown，而不是被当成 false（F03/F05）。
 * attemptId/beat 与上场通知同源——学习侧由它们和 versionId 重新派生出与上场相同的
 * `exposureId`，于是反馈能精确归因到那一次真实展示；归因不上就拒绝落账（保持
 * unknown），绝不让迟到或错配的反馈进账。
 *
 * 它**刻意没有** `observedAt`，理由与 `MethodFieldingNotice` 相同：执行环不读环境
 * 时钟，时刻由学习侧注入的 `now()` 盖章。
 */
export type MethodFeedbackNotice = {
  readonly attemptId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly items: ReadonlyArray<MethodFeedbackItem>;
};

/**
 * 执行环持有的学习方法子系统。
 *
 * `intentOn` 是同步的、纯读的，因为它决定**要不要装剥离器**，而那件事发生在
 * 流开始之前——一个 `Promise` 会让「这一拍装不装」变成一次等待，而它是可以
 * 由「这一拍放权了没有」直接回答的。
 *
 * `requestSlot` 是异步的，因为它在想拿一张卡时可能要做一次编译；但它**不跑
 * LLM、不读磁盘**（档在构造时 `load()` 一次进内存），所以它永远不增加 provider
 * 调用数——这是 T10 的断言，也是「取卡不跑 LLM」的兑现处。
 */
export type MethodLearningPort = {
  observe(report: MethodBeatObservation): Promise<void>;
  intentOn(turnId: string, beat: number): boolean;
  /** Confirm after requestSlot that the proposal instruction fitted. Absent keeps legacy semantics. */
  readonly confirmIntent?: (turnId: string, beat: number) => boolean;
  requestSlot(request: MethodSlotRequest): Promise<MethodSlotDelivery | undefined>;
  /**
   * 报告「这一 attempt 真的发出去了」（ME0-2）。
   *
   * 只在收到本 attempt 的第一条 `stream_start` 之后调用一次；start 前的失败/取消/
   * 断开不调用它，于是「送达 unknown」与「已上场」在账上分得开。实现侧把每条
   * receipt 落成一条持久上场，写失败只产生结构化降级，**绝不让用户任务失败**。
   */
  recordFielding(notice: MethodFieldingNotice): Promise<void>;
  /**
   * 报告「这一回答里模型对方法卡的帮助自报」（ME0-3）。
   *
   * 只在流正常收尾、且反馈剥离器认出一个合法块之后调用。实现侧把每条 item 归因到
   * 一次真实上场再落账：归因不上（版本没上场过、attempt 对不上）就保持 unknown，
   * **绝不**把缺失当成 false；`helped:false` 也只记一条反馈事实，不触发反例、休眠、
   * 删除或沉降（那是别的写入者的事）。写失败只产生结构化降级，绝不让用户任务失败。
   */
  recordFeedback(notice: MethodFeedbackNotice): Promise<void>;
  endTurn(turnId: string, signal?: AbortSignal): Promise<void>;
};

/**
 * 围栏标记。
 *
 * `loop/method-channel.ts` 用它从执行文本里切出 proposal；学习层用它写给模型
 * 看。两边必须逐字相同，而两层不得互 import，所以这个常量在两处各有一份、由
 * 合同测试要求相等。放在这里而不是 `method-channel.ts`，是因为「写给模型的那
 * 一份」在 `learning/method/port.ts` 里——两份对等的声明，各自靠近自己的用途。
 */
export const LEARNING_FENCE = "trylo-learning";
