import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import { dispatchDecision } from "../../domain/background-queue.js";
import type { BackgroundQueue, QueueFailureCode } from "../../ports/background-queue.js";
import type { CliContext } from "./context.js";
import { sessionQueuePath } from "./session-paths.js";

/**
 * 空闲时的后台消息派发（WP08 / C41）。
 *
 * 这是让 `trylo queue` 从「能写」变成「会被消费」的那一步。会话每结束一轮、
 * 回到 idle，才来这里问一次队首；有一条就起一轮，没有就什么都不做。
 *
 * **为什么取出来就删。** 派发即删除，照 Codex 的 `dispatch_if_idle` 原样：一条
 * 消息只能被一个 turn 拿走。若改成「跑完再删」，那么 turn 失败或进程在中间
 * 被杀时，那条消息既没被回答、也还在队列里 —— 下一次 idle 会把它再取一次，
 * 于是同一条被回答两遍。删在前面时，失败的后果是「这条丢了」，可以在
 * `trylo queue list` 里看得见；重复回答则连痕迹都没有。
 *
 * **为什么失败时不吵人。** `queue_locked` 与 `queue_unreadable` 都是别的写者
 * 正在动这个文件的正常瞬间。这里只在失败**种类**变化时说一句，同一种反复
 * 出现不再刷屏 —— 一个每轮都喊「队列读不到」的提示符，比不喊更糟。
 */
export type IdleDispatch =
  | { readonly kind: "turn"; readonly id: string; readonly text: string; readonly remaining: number }
  | { readonly kind: "idle" }
  | { readonly kind: "unknown"; readonly code: QueueFailureCode };

/**
 * 取一轮的后台输入。由 composition root 构造、由 TUI 循环在 idle 时调用；
 * TUI 目录自己不构造队列（`tui/discipline.test.ts` 禁它 import `adapters/`）。
 */
export type IdleDispatchSource = (sessionId: string) => Promise<IdleDispatch>;

/**
 * One queue per session, built on first use and kept.
 *
 * Kept rather than rebuilt per call because the writer lock is a file next to
 * the queue: a fresh object every idle tick would create and remove that file
 * on every tick, which turns a quiet session into a writer that constantly
 * competes with the very `trylo queue` invocation it is waiting for.
 */
export function createIdleDispatch(ctx: CliContext): IdleDispatchSource {
  const queues = new Map<string, BackgroundQueue>();
  const queueFor = (sessionId: string): BackgroundQueue => {
    const existing = queues.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const created = createFileBackgroundQueue({
      path: sessionQueuePath(ctx.homeDir, ctx.env, sessionId),
      clock: { now: ctx.now, newId: ctx.newId },
    });

    queues.set(sessionId, created);

    return created;
  };

  return async (sessionId) => {
    const queue = queueFor(sessionId);
    const page = await queue.list(0, 2);
    if (!page.ok) {
      return { kind: "unknown", code: page.code };
    }

    const decision = dispatchDecision(page);
    if (decision.kind === "unknown") {
      return { kind: "unknown", code: decision.code };
    }

    if (decision.kind === "idle") {
      return { kind: "idle" };
    }

    const id = decision.message.id;
    const dropped = await queue.delete(id);
    if (!dropped.ok) {
      // The head was read but could not be taken. Refusing here rather than
      // answering it anyway: answering a message that is still in the queue is
      // how one message gets answered twice.
      return { kind: "unknown", code: dropped.code };
    }

    return {
      kind: "turn",
      id,
      text: decision.message.text,
      remaining: Math.max(0, page.value.total - 1),
    };
  };
}

/**
 * 后台队列读不到时的退出码归属（与 `commands-queue.ts` 同一口径）。
 *
 * 保留为导出的原因不是复用，而是让「同一个失败在两个面上同一个类」这件事
 * 有一处可查：TUI 面上它只印一行字，不产生退出码。
 */
export function idleDispatchExitCode(code: QueueFailureCode): ExitCode {
  return code === "queue_locked" || code === "queue_unwritable"
    ? EXIT_CODES.TEMPORARY
    : EXIT_CODES.USAGE;
}
