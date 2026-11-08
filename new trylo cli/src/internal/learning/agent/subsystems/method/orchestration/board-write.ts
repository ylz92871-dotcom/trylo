import { shortId } from "../../../../domains/shared/hash.js";
import { parentVersionFor, variantOf, withVariant } from "../assets/archive.js";
import { familiesOf } from "./board-ledger.js";
import type { BoardState } from "./board.js";
import type { MethodRelease } from "../domain/contracts.js";
import type { GateVerdict } from "../domain/gate.js";
import { nicheOf } from "../domain/niche.js";
import type { MethodBeatReport, MethodFeedbackNotice, MethodFieldingNotice } from "../port.js";
import { vocabularyOf } from "../domain/vocabulary.js";

/**
 * 入档那一次写入。
 *
 * 与 `board.ts` 分开，是因为它们回答的是两个不同的问题：那边是「**什么时候**去看
 * 这一拍的产出」（次序、对账、放权、记账），这边是「**一旦**过了门，怎么落下去」
 * （身份、血缘、词表、留给下一拍的东西）。分开之后，落盘路径的每一行都只谈档，
 * 而不是夹在三次 `if` 与一次 `emit` 之间。
 *
 * 它 import `board.ts` 的 `BoardState` 是**只读类型**的一条边（`import type`，运行时
 * 不存在），所以两个文件之间没有真的循环——与 `board-ledger.ts` 一样。
 */

/** 一张过了门的卡。写成别名，是因为下面那个函数签名要短到看得清它的四个输入。 */
export type AdmittedVerdict = Extract<GateVerdict, { kind: "admitted" }>;

/**
 * 过门的卡写进档，并记下这一拍要留给下一拍的东西。
 *
 * 身份由**内容**派生（`versionId = shortId(niche, hint)`），所以「同一句话第二次
 * 被抽出来」这件事由身份说出来，而不是由调用方记得去查重：写口把控制板的
 * `active_content_immutable` 读成 `duplicate`，于是这一次入档不会在档里多出一张
 * 同句变体。待记账、钩子与词表仍然更新——它们说的是「这一拍请过它说话」，与档里
 * 有没有第二张同句卡无关。
 */
export async function commitAdmitted(
  state: BoardState,
  verdict: AdmittedVerdict,
  release: MethodRelease,
  report: MethodBeatReport,
): Promise<void> {
  const card = verdict.card;
  const nicheId = nicheOf(card);
  const versionId = shortId("method", [nicheId, card.hint]);
  const proposalId = shortId("method_proposal", [versionId]);
  const parentVersionId = parentVersionFor(state.archive, nicheId);
  const written = await state.options.archive.commitCard({
    card,
    nicheId,
    versionId,
    proposalId,
    evidenceId: shortId("method_evidence", [versionId, "admission"]),
    ...(parentVersionId === undefined ? {} : { parentVersionId }),
    writeId: versionId,
    sample: `${release.tool}:${release.code}`,
    observedAt: state.options.now(),
  });
  if (!written.ok) {
    state.options.emit("observation", {
      degraded: true,
      component: "method_archive",
      reason: written.reason,
      versionId,
    });
    return;
  }

  if (written.variants !== undefined) {
    state.archive = written.variants;
  } else if (!written.duplicate) {
    state.archive = withVariant(
      state.archive,
      variantOf({ versionId, proposalId, card, accounting: [] }),
    );
  }

  // 追加就在这一刻进词表：卡进不去，词也进不去，所以不需要第二条写入路径。
  state.vocabulary = vocabularyOf(state.archive);
  state.hook = verdict.hook;
  state.hookBeat = report.beat;
  state.pending = {
    versionId,
    proposalId,
    families: familiesOf(card),
    admittedBeat: report.beat,
  };
  state.options.emit("observation", {
    component: "method_card",
    versionId,
    nicheId,
    family: card.family ?? "-",
    labels: card.labels.join("+"),
    additions: verdict.additions.map((addition) => addition.id).join("+"),
    duplicate: written.duplicate,
  });
}

/**
 * 一次**真实发送**落一条持久上场（ME0-2）。
 *
 * 执行环在收到本 attempt 的第一条 `stream_start` 之后才调它，所以「上场」在这里
 * 已经是既成事实：模型真的接了这个请求。每条 receipt 落一条 `recordUse`，身份由
 * 身份包含 attemptId、beat 和 versionId。宿主一次 turn 可在多拍复用 attemptId；
 * beat 防止首次试用与进入情景后的不同真实请求被折成同一次展示。
 * （`method-fielding.ts::useCommandOf`），于是重复递送在 Board 上是幂等重放，不
 * 是第二条事实。`requestId` 用 `attemptId`，`scope` 用 `nicheId`。
 *
 * `observedAt` 由板注入的 `now()` 盖章，而不是执行环带进来：执行环不读环境时钟
 * （`verify` step 3 会拒），上场时刻是学习层的事实。
 *
 * 写失败**只降级、不失败用户任务**（F10）：每条 receipt 各自落一条 degraded 观察，
 * 循环继续，绝不抛出去。fail-closed 的档读不出来那一支已经在 `loadArchive` 报过
 * 一次，这里直接静默返回——不往一个读不出来的档上写。
 */
export async function recordFielding(state: BoardState, notice: MethodFieldingNotice): Promise<void> {
  await state.load;

  if (state.unavailable !== undefined) {
    return;
  }

  const observedAt = state.options.now();

  for (const receipt of notice.receipts) {
    const exposureId = exposureIdFor(notice.attemptId, notice.beat, receipt.versionId);
    const written = await state.options.archive.recordUse({
      writeId: exposureId,
      exposureId,
      versionId: receipt.versionId,
      proposalId: receipt.proposalId,
      turnId: notice.turnId,
      beat: notice.beat,
      requestId: notice.attemptId,
      scope: receipt.nicheId,
      ...(receipt.binding === undefined ? {} : { binding: receipt.binding }),
      observedAt,
    });
    if (!written.ok) {
      state.options.emit("observation", {
        degraded: true,
        component: "method_fielding",
        reason: written.reason,
        versionId: receipt.versionId,
        exposureId,
      });
    } else if (written.variants !== undefined) {
      state.archive = written.variants;
    }
  }
}

/**
 * 一次**已完成回答**里的帮助自报落账（ME0-3）。
 *
 * 与 `recordFielding` 同源同序：执行环只在流正常收尾后才发它，且**总是在上场之后**
 * （`runner.ts` 里 `recordFielding` 先于 `recordFeedback`），所以归因要找的那条上场
 * 已经在板上。每条 item 用与上场**完全相同**的公式重新派生
 * `exposureIdFor(attemptId, beat, versionId)`，于是 canonical
 * reducer（`learning/control/apply-method-ledger.ts::applyRecordMethodFeedback`，在
 * Board 写锁内）能按 `(exposureId, versionId, turnId)` 三者全等命中那一次真实展示；
 * 命中不了（版本没上场过、attempt 对不上、反馈迟到）就是 `feedback_unattributable`，
 * **拒绝写入、保持 unknown**，绝不当成 false（F03/F05）。
 *
 * `writeId` 用 `exposureId`，于是 `commandId`（`method-fielding.ts::feedbackCommandOf`）
 * 由 `(attemptId, beat, versionId, turnId, helped)` 确定性派生：同一条反馈重放得同一
 * `commandId`，Board 幂等重放、不多出第二条事实（F07）。
 *
   * `helped:false` 在这里**只落一条反馈事实**：它不进 `recordAccount`（反例/支持是
   * 另一条由真实工具判决的路径），不触发即时休眠/删除；沉降在 turn 末按累计数执行。false 与缺失是两件
 * 事——false 是「模型说了没用」，缺失是「模型没说」，后者保持 unknown。
 *
 * 写失败只降级、不失败用户任务，与 `recordFielding` 同口径（F10）。
 */
export async function recordFeedback(state: BoardState, notice: MethodFeedbackNotice): Promise<void> {
  await state.load;

  if (state.unavailable !== undefined) {
    return;
  }

  const observedAt = state.options.now();

  for (const item of notice.items) {
    const exposureId = exposureIdFor(notice.attemptId, notice.beat, item.versionId);
    const written = await state.options.archive.recordFeedback({
      ...(notice.context === undefined ? {} : { context: notice.context }),
      writeId: exposureId,
      versionId: item.versionId,
      turnId: notice.turnId,
      helped: item.helped,
      ...(item.application === undefined ? {} : { application: item.application }),
      exposureId,
      providerAttemptId: notice.attemptId,
      observedAt,
    });
    if (!written.ok) {
      state.options.emit("observation", {
        degraded: true,
        component: "method_feedback",
        reason: written.reason,
        versionId: item.versionId,
        exposureId,
      });
    } else if (written.variants !== undefined) {
      state.archive = written.variants;
    }
  }
}

function exposureIdFor(attemptId: string, beat: number, versionId: string): string {
  return shortId("method-exposure", [attemptId, String(beat), versionId]);
}
