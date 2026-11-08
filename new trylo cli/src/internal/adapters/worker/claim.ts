import { readdirSync, statSync } from "node:fs";
import { createFileBackgroundQueue } from "../queue-store/file-queue.js";
import { dispatchDecision } from "../../domain/background-queue.js";
import {
  MAX_QUEUED_MESSAGES,
  type BackgroundQueue,
  type QueueClock,
} from "../../ports/background-queue.js";
import type { WorkerJob, WorkerResult } from "../../ports/worker.js";

/**
 * 队列发现与领取（WP26 / A04 worker）。
 *
 * ## 为什么 worker 要自己扫描队列目录
 *
 * 前台 TUI 知道自己在跑哪个会话，所以它能直接按 id 找到队列。后台 worker **不
 * 知道**：它启动时没有人告诉它「去消费这几个会话」。队列文件按会话分片放在
 * `tryloHome/queue/<sessionId>.ndjson`（`session-paths.ts`），所以扫描这个目录就是
 * 「找出哪些会话有活等着」—— 这正是规格里「前台退出后继续」需要的自主性。
 *
 * ## 删除队列项现在意味着什么（这是修过的）
 *
 * 早先的形状是「领走 = 删掉」：删完就再没有别的痕迹，交接窗口里崩一下就说不清
 * 这条去了哪里 —— 补一句会跑两遍，不补就悄悄丢了。
 *
 * 现在删除**不再是领取事实本身**，只是「别让别人再拿到它」；真正的领取事实写在
 * 交接记录里（`handoff.ts`）。所以这里多了 `restore`：当交接确认失败、而队列项
 * 已经删掉时，把这条**补回队列**，而不是让它消失。
 *
 * 补回去只能到队尾，位置变了。这是有意的取舍：丢掉一条任务是「没了」，换位置
 * 只是「晚点做」，两者不是一个量级的坏。
 *
 * ## 串行约束
 *
 * 同一会话的队列在任一时刻只有一个写者（队列自己的写锁）。worker 和前台 TUI 走
 * 的是同一把锁，所以「谁先拿到队首」是串行的 —— worker 没有另起一套并发。
 */

export const QUEUE_FILE_SUFFIX = ".ndjson";

export type QueueDirIo = {
  readonly readDir: (absolutePath: string) => ReadonlyArray<string>;
  readonly statFile: (absolutePath: string) => number | undefined;
};

/**
 * 哪些会话有队列文件。
 *
 * 只认文件名的**前缀**是会话 id，别的形态一律跳过而不是猜 —— 队列目录里若混进
 * 别的东西，把它当会话去消费会去敲一个不存在的会话。
 */
export function discoverQueuedSessions(io: QueueDirIo, dir: string): ReadonlyArray<string> {
  let names: ReadonlyArray<string>;

  try {
    names = io.readDir(dir);
  } catch {
    return [];
  }

  const out: { readonly id: string; readonly modifiedAtMs: number }[] = [];

  for (const name of names) {
    if (!name.endsWith(QUEUE_FILE_SUFFIX)) {
      continue;
    }

    const id = name.slice(0, -QUEUE_FILE_SUFFIX.length);
    if (id.length === 0 || id.includes("/") || id.includes("\\") || id.includes("..")) {
      continue;
    }

    const modifiedAtMs = io.statFile(`${dir}/${name}`);
    if (modifiedAtMs === undefined) {
      continue;
    }

    out.push({ id, modifiedAtMs });
  }

  // 老的最先：队列是先进先出的，先动的应该是等得最久的那条。
  return out
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)
    .map((entry) => entry.id);
}

export function nodeQueueDirIo(): QueueDirIo {
  return {
    readDir: (absolutePath) => readdirSync(absolutePath),
    statFile: (absolutePath) => {
      try {
        return statSync(absolutePath).mtimeMs;
      } catch {
        return undefined;
      }
    },
  };
}

export type QueueClaim = {
  /**
   * 取第一条**可以领**的消息并把它从队列移除。真正的领取事实写在交接记录里，不在这里。
   *
   * `skip` 里的 id 留在队列里不动：它们带着交接记录（比如 `unknown` 那条是补回来
   * 给人看见的），自动再跑一遍正是"未知副作用不能自动重做"要拦的事。跳过它们继续往
   * 后走，是为了别让一条无法判定的作业把整个会话的队首堵死 —— 顺序照旧先进先出，
   * 只是"这一条今天不领"。
   */
  readonly claim: (sessionId: string, skip?: ReadonlySet<string>) => Promise<WorkerResult<WorkerJob>>;
  /** 把一条任务补回队列（队尾）。用于交接没成、而队列项已经删掉的时候。 */
  readonly restore: (job: WorkerJob) => Promise<boolean>;
  /**
   * 第一条**不在 `skip` 里**的消息是谁（**不移除**）。
   *
   * 有了它才能做到「补回去的任务不被自动再跑一遍」：先 peek 到它、查到记录，就把它
   * 加进 skip 继续往后看 —— 而不是领走再后悔。
   */
  readonly peek: (sessionId: string, skip?: ReadonlySet<string>) => Promise<WorkerJob | undefined>;
  /**
   * 这条消息还在队列里吗。
   *
   * 补回之前必须先问这一句：队列项还在却补一次，同一句话就变成两条。
   */
  readonly has: (sessionId: string, messageId: string) => Promise<boolean>;
};

/**
 * 领走一条活的适配器。
 *
 * 队列对象**缓存**而不是每次重建：写锁是队列文件旁边的一个文件，每 tick 新建对象
 * 就会每 tick 创建又删除它，把一个安静的会话变成不断和 `trylo queue` 抢锁的写者。
 *
 * `restore` 复用同一个缓存对象，因此它和 `claim` 争的是**同一把锁**，不会变成
 * 第二个写者。
 */
export function createQueueClaim(options: {
  readonly queuePathFor: (sessionId: string) => string;
  readonly clock: QueueClock;
}): QueueClaim {
  const queues = new Map<string, BackgroundQueue>();
  const queueFor = (sessionId: string): BackgroundQueue => {
    const existing = queues.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const created = createFileBackgroundQueue({
      path: options.queuePathFor(sessionId),
      clock: options.clock,
    });

    queues.set(sessionId, created);

    return created;
  };

  return {
    claim: async (sessionId, skip) => {
      const queue = queueFor(sessionId);
      const page = await queue.list(0, MAX_QUEUED_MESSAGES);
      const decision = dispatchDecision(page);
      if (decision.kind === "idle") {
        return {
          ok: false,
          code: "no_work",
          message: `the queue for ${sessionId} is empty`,
        };
      }

      if (decision.kind === "unknown") {
        return {
          ok: false,
          code: decision.code,
          message: `the queue for ${sessionId} could not be read (${decision.code})`,
        };
      }

      const items = page.ok ? page.value.items : [];
      const message =
        skip === undefined || skip.size === 0
          ? decision.message
          : items.find((item) => !skip.has(item.id));
      if (message === undefined) {
        // 说清楚是"都被扣住"而不是"没活"：把无法判定的作业读成空队列，
        // 和静默丢失是同一种失败。
        return {
          ok: false,
          code: "no_work",
          message: `every queued message in ${sessionId} is held by a handoff record`,
        };
      }

      const dropped = await queue.delete(message.id);
      if (!dropped.ok) {
        // 领不到就不能跑。跑一条还在队列里的消息，是让同一个问题被回答两次的唯一方式。
        return {
          ok: false,
          code: dropped.code,
          message: `the head of ${sessionId}'s queue could not be taken (${dropped.code})`,
        };
      }

      return {
        ok: true,
        value: {
          sessionId,
          messageId: message.id,
          text: message.text,
          enqueuedAtMs: message.enqueuedAtMs,
        },
      };
    },
    restore: async (job) => {
      // 保 id、保到达时间：交接记录是按原消息 id 键控的，换一个新 id 就等于把
      // 「这条已经被看过」的证据弄丢了 —— unknown 的那条会因此被反复重跑。
      const enqueued = await queueFor(job.sessionId).requeue({
        id: job.messageId,
        text: job.text,
        enqueuedAtMs: job.enqueuedAtMs,
      });
      return enqueued.ok;
    },
    peek: async (sessionId, skip) => {
      const page = await queueFor(sessionId).list(0, MAX_QUEUED_MESSAGES);
      if (!page.ok) {
        return undefined;
      }

      const head =
        skip === undefined || skip.size === 0
          ? page.value.items[0]
          : page.value.items.find((item) => !skip.has(item.id));
      if (head === undefined) {
        return undefined;
      }

      return {
        sessionId,
        messageId: head.id,
        text: head.text,
        enqueuedAtMs: head.enqueuedAtMs,
      };
    },
    has: async (sessionId, messageId) => {
      const page = await queueFor(sessionId).list(0, MAX_QUEUED_MESSAGES);
      if (!page.ok) {
        // 读不到就当不在：宁可补回一条（多一条能看见），也不当作还在而
        // 什么也不做（少一条看不见）。
        return false;
      }

      return page.value.items.some((item) => item.id === messageId);
    },
  };
}
