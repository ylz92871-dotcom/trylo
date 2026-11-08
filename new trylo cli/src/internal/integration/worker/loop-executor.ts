import { runTurn, type LoopPorts, type RunTurnRequest } from "../../loop/runner.js";
import type { ExecutionState } from "../../domain/state.js";
import type {
  HandoffProbe,
  WorkerExecutionOwner,
  WorkerJob,
  WorkerOutcome,
  WorkerTurnResult,
} from "../../ports/worker.js";

/**
 * 后台 worker 的执行 owner：**现有 Trylo loop runner**（WP26 / A04 通电）。
 *
 * ## 为什么是它
 *
 * 主人指定接现有 loop runner，不把 L32 外部 workd 当默认后台执行器。所以这里做的
 * 只是「把队列里的一句话喂给 `runTurn`」，**不另造执行总管** —— 跑一轮这件事在本
 * 仓库只有一个实现，就是它。
 *
 * ## 为什么它只认 `LoopPorts`
 *
 * `LoopPorts` 由组合根（`surface/cli/wiring.ts::wirePorts`）组装好再递进来，本文件
 * 不去碰 provider / 工具 / 权限怎么来的。这样它不依赖 surface，也不重复那套组装。
 *
 * ## probe 为什么恒返回 unknown
 *
 * `probe` 要回答「崩溃之后，这条到底交出去没有」。诚实的答案在这个位置是**不知道**：
 * 崩溃后多半已经换了一个进程，内存里什么都没留下；唯一能确认的是持久的 session
 * journal，而查它要接 session-store（跨包，不在本批）。
 *
 * 所以这里保守返回 `unknown`，而不是猜 `not_received`。这个选择直接对应两条要求：
 *
 * - unknown → worker **补回队列**（不丢任务）
 * - unknown → 记录标 unknown，下一趟 worker 跳过它（**不自动重做**）
 *
 * 换句话说，保守的 unknown 同时满足「不丢」与「不重做」，而猜成 not_received
 * 会让 worker 认为「确定没发生」从而重交 —— 那是在赌副作用没落地。
 */

/** 一轮的结局怎么翻译成 worker 的结局。 */
export function outcomeOfTurn(state: ExecutionState): WorkerOutcome {
  // 没走到终态，说明这一轮被打断了；副作用可能已经落了，所以是 unknown 而不是 failed。
  if (state.phase !== "terminal") {
    return "unknown";
  }
  switch (state.terminalReason) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

export type LoopWorkerExecutorOptions = {
  /** Assembled by the composition root; this file never builds it. */
  readonly ports: LoopPorts;
  /**
   * 这一轮用哪个模型。
   *
   * **必须传，不能省**：模型是**逐轮请求**上的字段（`runner-engine.ts`：
   * `request.model ?? "default"`），不是 provider 与生俱来的属性 —— 组合根在
   * `wirePorts` 里选好的那个 model 只有经这里传下去才到得了 wire。
   *
   * 这条是实测撞出来的：漏传时真 provider 收到 `model:"default"`，端点回 404
   * `model_not_found`；而夹具 provider 根本不看 model，于是离线那组全绿把它盖住了。
   */
  readonly model: string;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
};

/**
 * 一轮后台任务怎么变成一次 `runTurn`。
 *
 * 单独出来是为了能被测到：`model` 是不是真的传下去了，是这个文件里唯一一条
 * 「漏了就静默走错」的规则（漏了不会报错，只会让真 provider 换一个模型问）。
 */
export function workerTurnRequest(
  job: WorkerJob,
  options: Pick<LoopWorkerExecutorOptions, "model" | "now" | "newId">,
): RunTurnRequest {
  return {
    sessionId: job.sessionId,
    turnId: options.newId("turn"),
    correlationId: options.newId("corr"),
    text: job.text,
    model: options.model,
    now: options.now,
  };
}

export function createLoopWorkerExecutor(
  options: LoopWorkerExecutorOptions,
): WorkerExecutionOwner {
  return {
    execute: async (job: WorkerJob): Promise<WorkerTurnResult> => {
      const result = await runTurn(options.ports, workerTurnRequest(job, options));
      const outcome = outcomeOfTurn(result.state);

      return {
        outcome,
        detail:
          outcome === "unknown" && result.state.phase !== "terminal"
            ? `the turn stopped in phase ${result.state.phase}`
            : `turn ended ${outcome} after ${result.iterations} iteration(s)`,
      };
    },

    // 保守：见文件头。宁可让 worker 补回并标 unknown，也不猜「确定没交出去」。
    probe: async (_ref: string): Promise<HandoffProbe> => "unknown",
  };
}
