import {
  createQueueClaim,
  discoverQueuedSessions,
  nodeQueueDirIo,
  type QueueClaim,
  type QueueDirIo,
} from "./claim.js";
import { createFileHandoffStore, type HandoffStore } from "./handoff.js";
import {
  DEFAULT_WORKER_BUDGET,
  computeOwnerRef,
  passOf,
  receiptOf,
  recoverPlanFor,
} from "../../domain/worker.js";
import type { QueueClock } from "../../ports/background-queue.js";
import type {
  HandoffRecord,
  WorkerExecutionOwner,
  WorkerFailureCode,
  WorkerIdentity,
  WorkerJob,
  WorkerOutcome,
  WorkerPass,
  WorkerPort,
  WorkerReceipt,
  WorkerResult,
  WorkerTurnResult,
} from "../../ports/worker.js";

/**
 * 常驻 worker 本体（WP26 / A04）。
 *
 * ## 它是 daemon 的一个 step，不是又一个后台进程
 *
 * daemon 已经管了租约、心跳、停止通道；worker 若再起一套，就是 ADR §5 点名的
 * 「按十项另建十套后台总管」。所以 worker 只回答一个问题：**这一趟能不能从
 * 队列里领一条活，把它交给执行 owner，并把结局记下来。**
 *
 * ## 交接：为什么不再是「先删再跑」
 *
 * 早先是领走即删除，删除就是唯一的领取事实。那个形状在交接窗口里崩一下就说不清：
 * 队列项没了、owner 收没收到也不知道，补一句会跑两遍、不补就悄悄丢了。
 *
 * 现在分三步，**交接记录（handoff）才是领取事实**：
 *
 * 1. 先把 `handing_off` 记录落盘 —— 连同**派生出来的** ownerRef
 * 2. 再删队列项（只是「别让别人再拿到」，不再是领取事实）
 * 3. 交给执行 owner；成了标 `acked`，没成就去问 owner「你收到没有」
 *
 * ownerRef 是派生的（`worker_<sessionId>@<messageId>`），所以崩溃后拿着同一个 ref
 * 再问一次，问到的是同一个东西；重交也因此是幂等的，owner 看到重复 ref 知道
 * 「这条我有了」，不会把同一句话跑两遍。
 *
 * 崩溃窗口的四种落点由 `domain/worker.ts::recoverPlanFor` 决定，其中
 * `restore` 是「不丢任务」的那一步：owner 说没收到、而队列项已经删了，就把这条
 * **补回队列**。`hold`（记成 unknown）则是「不自动重做」：查不出来时既不动它
 * 也不重交，标成 unknown 交给人看 —— 重做一个可能已经跑过的任务，比丢一条更糟。
 */

export type FileWorkerOptions = {
  /** Where one session's queue lives. Same formula the CLI uses. */
  readonly queuePathFor: (sessionId: string) => string;
  /** The directory holding every session's queue file. */
  readonly queueDir: string;
  readonly clock: QueueClock;
  /** The execution owner. Production wires this to the existing loop runner. */
  readonly owner: WorkerExecutionOwner;
  /** Who is running it, so a receipt can be told apart from a predecessor's. */
  readonly worker: WorkerIdentity;
  /** Durable handoff records. Injected so a test can use a fake. */
  readonly handoffs: HandoffStore;
  /** Max jobs per pass. */
  readonly budget?: number;
  readonly io?: QueueDirIo;
};

/** Where this worker keeps its handoff records, next to the queues it serves. */
export function handoffPath(home: string): string {
  return `${home}/worker/handoff.ndjson`;
}

export function createFileWorker(options: FileWorkerOptions): WorkerPort {
  const budget = options.budget ?? DEFAULT_WORKER_BUDGET;
  const io = options.io ?? nodeQueueDirIo();
  const claim: QueueClaim = createQueueClaim({
    queuePathFor: options.queuePathFor,
    clock: options.clock,
  });
  const settled: WorkerReceipt[] = [];

  /**
   * 把一条活交给执行 owner，并把「交成了没有」落成记录。
   *
   * 队列项在调用它之前已经被 claim 移除了，所以这里**必须**问清楚 owner 收没收到：
   * 没收到就得补回队列，否则这条就真的没了。
   */
  async function handoffAndRun(job: WorkerJob): Promise<WorkerOutcome> {
    const ownerRef = computeOwnerRef(job.sessionId, job.messageId);
    const startedAtMs = options.clock.now();
    const base: HandoffRecord = {
      sessionId: job.sessionId,
      messageId: job.messageId,
      text: job.text,
      state: "handing_off",
      startedAtMs,
      worker: options.worker,
      ownerRef,
    };

    // 1. 领取事实先落盘 —— 它比队列项活得久，也说得清这条去了哪里。
    await options.handoffs.put(base);

    let result: WorkerTurnResult;
    // execute **正常返回**就意味着 owner 确实接过了这一轮 —— 哪怕它的结局是
    // failed / cancelled。只有它抛异常（进程崩、provider 连不上这一类）才谈得上
    // 「不知道交没交出去」，那时候才需要 probe。
    let threw = false;

    try {
      // 2. 交给 owner。ref 是幂等的，重复调用不会让同一句话跑两遍。
      result = await options.owner.execute(job);
    } catch (error) {
      threw = true;
      // 执行器自己炸了也算一条终局事实，而不是让异常穿出去打掉整个 tick。
      result = {
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const endedAtMs = options.clock.now();

    settled.push(receiptOf(job, result, startedAtMs, endedAtMs, options.worker));

    if (!threw) {
      // 正常返回：owner 接过这一轮了，队列项删得其所，不补回。
      await options.handoffs.put({
        ...base,
        state: "acked",
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      return result.outcome;
    }

    // 3. 没跑成：问 owner 到底收下没有。这是「不丢任务」与「不自动重做」的分水岭。
    const probe = await options.owner.probe(ownerRef);
    const stillQueued = await claim.has(job.sessionId, job.messageId);
    const plan = recoverPlanFor(probe, stillQueued);
    if (plan.action === "restore") {
      // 队列项已经删了、又问不出 owner 收没收到 —— 不补回去这条就没了。
      await claim.restore(job);
    }

    await options.handoffs.put({
      ...base,
      state: plan.mark,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });

    return result.outcome;
  }

  /**
   * 收拾上一任留下的交接窗口。
   *
   * 它只在「上一趟没走完」时才有东西：正常路径上每一步都把记录推到终态了。
   *
   * 要先于本趟的领取跑，否则刚补回队列的那条会被这一趟立刻又领一次。
   */
  async function recover(): Promise<number> {
    const pending = (await options.handoffs.list()).filter(
      (record) => record.state === "handing_off",
    );
    let handled = 0;

    for (const record of pending) {
      if (record.ownerRef === undefined) {
        // 连 ref 都没记下 —— 无从问起，只能交给人。
        await options.handoffs.put({ ...record, state: "unknown" });
        handled += 1;
        continue;
      }

      const probe = await options.owner.probe(record.ownerRef);
      const stillQueued = await claim.has(record.sessionId, record.messageId);
      const plan = recoverPlanFor(probe, stillQueued);
      if (plan.action === "retry") {
        // 队列项还在，下一趟会正常领到它；旧记录留着反而会让那一趟以为还在交接中。
        await options.handoffs.remove(record.sessionId, record.messageId);
      } else {
        if (plan.action === "restore") {
          await claim.restore({
            sessionId: record.sessionId,
            messageId: record.messageId,
            text: record.text,
            enqueuedAtMs: record.startedAtMs,
          });
        }
        await options.handoffs.put({
          ...record,
          state: plan.mark,
        });
      }

      handled += 1;
    }

    return handled;
  }

  async function run(job: WorkerJob): Promise<WorkerResult<WorkerReceipt>> {
    await handoffAndRun(job);
    const last = settled[settled.length - 1];
    if (last !== undefined) {
      return { ok: true, value: last };
    }

    return {
      ok: false,
      code: "executor_failed",
      message: "the job ended without a receipt",
    };
  }

  // 一个会话一次最多往前看几条，绕开被扣住的队首。有界是有意的：真要被扣住十几条，
  // 那是要人来处置的信号，不是让 worker 每 tick 把队列读穿的理由。
  const SESSION_LOOKS_PER_PASS = 16;

  async function pass(): Promise<WorkerPass> {
    const recovered = await recover();
    if (recovered > 0) {
      // 这一趟只做恢复。刚补回队列的那条不该在同一趟又被领走 —— 补回是让人和下一趟
      // 看见它，立刻执行等于恢复这件事没发生过，人也无从知道中间崩过一次。
      return passOf(0);
    }

    const sessions = discoverQueuedSessions(io, options.queueDir);
    let taken = 0;
    let refused: WorkerFailureCode | undefined;

    for (let slot = 0; slot < budget; slot += 1) {
      let job: WorkerJob | undefined;

      for (const sessionId of sessions) {
        // 队首带着交接记录（尤其 unknown：那条是补回队列给人看见的）就把它**留在原地**
        // 继续往后看。以前这里 `continue` 掉的是整个会话，一条无法判定的作业就把会话
        // 后面的消息堵死；自动再跑一遍又是"未知副作用不能重做"明确禁止的。
        // 有界扫描：一个会话一次最多看 16 条，超过就说明这堆该人来看了，
        // 而不是让 worker 每 tick 把整个队列读穿。
        const held = new Set<string>();

        for (let looks = 0; looks < SESSION_LOOKS_PER_PASS; looks += 1) {
          const head = await claim.peek(sessionId, held);
          if (head === undefined) {
            break;
          }

          const seen = await options.handoffs.get(sessionId, head.messageId);
          if (seen !== undefined) {
            held.add(head.messageId);
            continue;
          }

          const got = await claim.claim(sessionId, held);
          if (got.ok) {
            job = got.value;
            break;
          }

          if (got.code !== "no_work") {
            refused = got.code;
            break;
          }
        }

        if (job !== undefined || refused !== undefined) {
          break;
        }
      }

      if (refused !== undefined) {
        break;
      }

      if (job === undefined) {
        refused = "no_work";
        break;
      }

      const outcome = await handoffAndRun(job);

      taken += 1;

      // 只有跑成的才接着领下一条：一个刚失败的执行器，下一条大概率同样失败，
      // 连着跑会把第一条真正的报错淹进噪声里。
      if (outcome !== "completed") {
        break;
      }
    }

    return passOf(taken, refused);
  }

  return {
    claim: (sessionId) => claim.claim(sessionId),
    run,
    pass,
    receipts: async () => [...settled],
    budget: () => budget,
  };
}

/** The durable handoff store a daemon would hand to `createFileWorker`. */
export function createWorkerHandoffs(file: string): HandoffStore {
  return createFileHandoffStore({ file });
}
