import type { JsonObject } from "../protocol/envelope.js";
import type { MethodFeedbackTake } from "./method-feedback-channel.js";
import type { MethodLearningPort, MethodSlotDelivery } from "./method-port.js";

/**
 * 真实发送 → 落一条持久上场（ME0-2 的执行侧一半）。
 *
 * runner 只编排，所以「什么时候该记上场」这条判断住在这里，而不是塞进热文件。
 * 它是纯编排：不持策略、不派生身份（那是板的事，`board.ts::recordFielding`），只
 * 回答「这一拍到底发出去了没有、发出去的是哪一组 receipt」。
 *
 * 三条 no-op，每条都对应验收矩阵里的一格，方向一律是**不记**：
 *
 *  - 没有端口 / 没有 turn / 没有 attemptId：无从归因。attemptId 是 `exposureId`
 *    的身份根，缺了它记一条上场就是记一件说不清是哪次发送的事。
 *  - 没见过 `stream_start`（F02/F09 前半）：provider 在模型接受请求之前就抛错、
 *    取消或断开了，「上场」不成立。见过 start 之后的失败（F03）不在这一支——那一
 *    拍 `sawStreamStart` 为真，照记，任务结果自己失败。
 *  - 这一拍没有 receipt（关学习、空档、无匹配）：没有版本被真正编进槽，记上场就
 *    是记一张没发出去的卡。
 *
 * 写失败由板那一侧收成结构化降级，绝不冒泡到这里——用户任务不因学习记账而失败。
 */
export async function recordFielding(host: {
  readonly port: MethodLearningPort | undefined;
  readonly turnId: string | undefined;
  readonly attemptId: string | undefined;
  readonly beat: number;
  readonly slot: MethodSlotDelivery | undefined;
  readonly sawStreamStart: boolean;
}): Promise<void> {
  const { port, turnId, attemptId, slot } = host;

  if (port === undefined || turnId === undefined || attemptId === undefined) {
    return;
  }

  if (!host.sawStreamStart) {
    return;
  }

  const receipts = slot?.receipts ?? [];
  if (receipts.length === 0) {
    return;
  }

  await port.recordFielding({ attemptId, turnId, beat: host.beat, receipts });
}

/**
 * 已完成回答里的帮助自报 → 落账（ME0-3 的执行侧一半）。
 *
 * 与 `recordFielding` 是同一类东西：runner 只编排，「什么时候该记反馈」这条判断住
 * 在这里。它也是纯编排——ref→versionId 的解析早在剥离器（`method-feedback-channel.ts`）
 * 里做完了，归因（把反馈对回一次真实上场）是板的事（`board-write.ts::recordFeedback`）。
 * 这里只回答「这一回答到底完成了没有、剥离器认出了什么」。
 *
 * 三道闸门按顺序，缺一道都可能把 unknown 误记成 false：
 *
 *  1. 没有端口 / 没有 turn / 没有 attemptId：无从归因，整次调用 no-op（关学习免费）。
 *  2. 剥离器的降级码：先原样发一条 `observation`（`§5.3` 的「剥不掉要说出来」），
 *     但**不**据此落账——一个坏块不是一次反馈。这条 emit 是 `recordFielding` 没有的：
 *     上场失败由板那一侧报，而反馈块的解析失败只有执行侧看得见。
 *  3. `finished` 为假（被切断 / 取消 / 出错）：**不记**。这正是 F03/F05 要的——没完成
 *     的回答里模型没给出可信自报，反馈保持 unknown，绝不当成 false。
 *
 * items 为空同样不记：空块是「模型没回反馈」，与「回了 false」是两件事。
 */
export async function recordFeedback(host: {
  readonly port: MethodLearningPort | undefined;
  readonly turnId: string | undefined;
  readonly attemptId: string | undefined;
  readonly beat: number;
  readonly finished: boolean;
  readonly take: MethodFeedbackTake | undefined;
  readonly emit: (kind: string, payload: JsonObject) => void;
}): Promise<void> {
  const { port, turnId, attemptId } = host;

  if (port === undefined || turnId === undefined || attemptId === undefined) {
    return;
  }

  if (host.take?.code !== undefined) {
    host.emit("observation", {
      degraded: true,
      component: "method_feedback_channel",
      reason: host.take.code,
    });
  }

  const items = host.take?.items;
  if (items === undefined || items.length === 0 || !host.finished) {
    return;
  }

  await port.recordFeedback({ attemptId, turnId, beat: host.beat, items });
}
