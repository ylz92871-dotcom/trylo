import type {
  HandoffProbe,
  WorkerFailureCode,
  WorkerIdentity,
  WorkerJob,
  WorkerOutcome,
  WorkerPass,
  WorkerReceipt,
  WorkerTurnResult,
} from "../ports/worker.js";

/**
 * 后台 worker 的纯策略（WP26 / A04）。
 *
 * 这一层不碰磁盘、不碰时钟、不碰进程表：所有判断都是「给定事实，回答一个问题」。
 * 这样 worker 的全部不变式都可以在没有真实队列的情况下被测到。
 */

/**
 * 交接标识：由会话和消息**派生**，不由执行 owner 返回。
 *
 * 派生的理由是一个崩溃窗口：如果 ref 是 owner 给的，那么 owner 收下之后、回话之前
 * 进程死掉，worker 手里就没有 ref —— 下一轮它既查不到、也不敢重交，只能干等。
 * 派生的 ref 在**交接之前**就确定了，崩溃后拿着它再去问一次，问到的是同一个东西。
 *
 * 它同时让重交变幂等：同一个 `(sessionId, messageId)` 永远得到同一个 ref，owner
 * 看到重复的 ref 就知道「这条我已经有了」，不会把同一句话跑两遍。这与本仓库既有的
 * occurrence 派生 id（`scheduleId@dueAtMs`）是同一个规矩。
 */
export function computeOwnerRef(sessionId: string, messageId: string): string {
  return `worker_${sessionId}@${messageId}`;
}

/**
 * 崩溃之后，一条「交接中」的记录该怎么办。
 *
 * 四种落点，每一种都对应一个具体的下一步，没有一种是「猜」：
 *
 * - `ack`：owner 确实收下了 → 把确认补上，队列项删掉
 * - `retry`：owner 说没收到，而队列项还在 → 再交一次（安全，因为没发生副作用）
 * - `restore`：owner 说没收到，但队列项已经被删了 → **补回队列**。这一步是
 *   「交接中崩溃不能丢任务」的全部内容：不补回去，这条就真的没了
 * - `hold`：查不出来 → 不动它，也不重做，标成 unknown 交给人看
 */
export type RecoveryPlan = {
  /** 该做什么。 */
  readonly action: "ack" | "retry" | "restore";
  /** 交接记录最终记成什么。 */
  readonly mark: "acked" | "unknown";
};

/**
 * 崩溃之后，一条「交接中」的记录该怎么办。
 *
 * 关键的一条是 `unknown`：**它也补回队列**。因为那一刻队列项已经删了、又问不出
 * owner 收没收到，什么都不做就等于这条没了 —— 「不丢任务」排在「不重做」前面。
 *
 * 「不自动重做」由 `mark: "unknown"` 承担：补回去是为了让人**看见**它，而 worker
 * 下一趟看到 unknown 记录会跳过这条，不会自己再跑一遍。两者不是一回事：
 * 补回是可见性，重做是副作用。
 */
export function recoverPlanFor(
  probe: HandoffProbe,
  queueHasItem: boolean,
): RecoveryPlan {
  if (probe === "received") {
    return { action: "ack", mark: "acked" };
  }

  if (probe === "not_received") {
    return queueHasItem
      ? { action: "retry", mark: "acked" }
      : { action: "restore", mark: "acked" };
  }

  return { action: "restore", mark: "unknown" };
}

/**
 * 一趟最多领几条。
 *
 * 有上限而不是「领到空为止」，因为队列可以装 100 条（`MAX_QUEUED_MESSAGES`），
 * 而每条都要起一轮 —— 一个 tick 把 100 轮全跑完，会让「daemon 在忙」和
 * 「daemon 卡死」在观测上无法区分。
 */
export const DEFAULT_WORKER_BUDGET = 3;

/**
 * 领到的活跑完以后，这一趟还该不该继续。
 *
 * 只有 `completed` 继续。失败的活不再接着领下一条，因为一个执行器刚刚失败
 * （provider 401、工具炸了、工作目录没了）时，下一条大概率以同样方式失败，
 * 而连续失败会把错误刷成一片噪声，把第一条真正的报错淹掉。
 *
 * `unknown` 也停 —— 「副作用可能落了」这件事必须先被人看见，而不是继续往前推。
 */
export function shouldContinuePass(result: WorkerTurnResult): boolean {
  return result.outcome === "completed";
}

/**
 * 一条活的终局回执。
 *
 * `startedAtMs` / `endedAtMs` 由调用方给，而不是这里读时钟 —— 否则同一个
 * 「跑了多久」的问题会有两个答案（worker 记的和心跳记的），而它们不一致时
 * 没人知道该信哪个。
 */
export function receiptOf(
  job: WorkerJob,
  result: WorkerTurnResult,
  startedAtMs: number,
  endedAtMs: number,
  worker: WorkerIdentity,
): WorkerReceipt {
  const base = {
    sessionId: job.sessionId,
    messageId: job.messageId,
    outcome: result.outcome,
    startedAtMs,
    endedAtMs,
    worker,
  };
  return result.detail === undefined ? base : { ...base, detail: result.detail };
}

/** 一句话说清一轮是怎么结束的，给 `ps` 那类列表用。 */
export function describeOutcome(outcome: WorkerOutcome): string {
  switch (outcome) {
    case "completed":
      return "ran and finished";
    case "failed":
      return "ran and failed";
    case "cancelled":
      return "was cancelled";
    case "unknown":
      return "ended without knowing whether its effects landed";
    default:
      return "ended in an unrecognised way";
  }
}

/** 一条回执给人看的一行。 */
export function renderReceipt(receipt: WorkerReceipt): string {
  const ms = Math.max(0, receipt.endedAtMs - receipt.startedAtMs);
  const head = `${receipt.sessionId} ${receipt.messageId} ${describeOutcome(receipt.outcome)}`;
  const tail = receipt.detail === undefined ? "" : ` — ${receipt.detail}`;
  return `${head} (${ms}ms)${tail}`;
}

/**
 * 判定一趟 pass 的结果：领了几条、为什么停。
 *
 * 抽出这个函数是因为「跑了但没有全部跑完」和「一条都没跑」是两种很不同的收场，
 * 而调用方（daemon 的 tick）只想问一句「这一趟值不值得记进心跳」。
 */
export function passOf(taken: number, refused?: WorkerFailureCode): WorkerPass {
  return refused === undefined ? { taken } : { taken, refused };
}

/**
 * 这一步该不该整趟停止。
 *
 * `no_work`（队列空）**不**停止：那是正常状态，daemon 还要继续跑 cron 和 watch。
 * 只有「队列读不到 / 写不了 / 被别人锁着」才停 —— 这些意味着这一趟拿不到可信事实，
 * 继续 tick 会在同一个坏文件上反复空转。
 */
export function passShouldStop(refused: WorkerFailureCode): boolean {
  return refused !== "no_work";
}

/**
 * 一条回执是否已经陈旧到不可信。
 *
 * 判据是**身份对**而不是「进程还在不在」：pid 会被复用，所以「pid 还活着」不等于
 * 「还是那个 worker」。调用方拿 pid 现在的启动时间和回执里记的比，不同就是换过人了
 * （Codex `pid.rs:168,555` 同一个规矩）。
 */
export function receiptIsStale(
  receipt: WorkerReceipt,
  currentStartFor: (pid: number) => number | undefined,
): boolean {
  const nowStart = currentStartFor(receipt.worker.pid);
  if (nowStart === undefined) {
    return true;
  }
  return nowStart !== receipt.worker.startedAtMs;
}
