import {
  DEFAULT_METHOD_GRANT,
  type FailureFamily,
  type LabelVocabulary,
  type MethodGrant,
  type MethodHook,
  type MethodRelease,
  type VariantRecord,
} from "../domain/contracts.js";
import { emptyArchive, selectShadowVariants, type ShadowVariant } from "../assets/archive.js";
import { accountPending, factsOf, resolvedFamily } from "./board-ledger.js";
import { commitAdmitted, recordFeedback, recordFielding } from "./board-write.js";
import { intentOn, requestSlotFor } from "./board-slot.js";
import { admitCard } from "../domain/gate.js";
import {
  type ArchiveLoadResult,
  type MethodArchivePort,
  type MethodBeatReport,
  type MethodEventSink,
  type MethodLearningService,
} from "../port.js";
import {
  createReleaseLedger,
  releaseFor,
  withRelease,
  type ReleaseLedger,
} from "../domain/release.js";
import { vocabularyOf } from "../domain/vocabulary.js";
import type { ExperienceRuntime } from "./experience-runtime.js";

/**
 * 板：把一个 turn 的方法学习从「一拍执行事实」接到「下几拍上场的经验」。
 *
 * 它是四件事唯一相遇的地方——放权判定（`release.ts`）、附加通道的产出
 * （`gate.ts`）、变体档（`archive.ts`）与上场编译（`compile.ts`）——而它们的
 * 次序就是全部机理：
 *
 *   1. 一拍结算的事实到达；
 *   2. **先记账**：上一拍入档的卡由这一拍的事实判决（同类失败没复现 = 支持，
 *      复现 = 反例，这一拍没 settle = 不记账）；
 *   3. 同一批事实交给放权判定，它可能放权（那一拍允许带学习意图）；
 *   4. 本拍附加通道抽出的 proposal 过门；过门即入档，**不需要**验收拍；
 *   5. 请求构建时编译一次槽；turn 结束由持久写口按反馈批量沉降。
 *
 * 三条性质是结构性的，不是纪律：
 *
 *  - **可写状态只有一处。** 档的真相在控制板；板内只持有它的内存视图，写入是
 *    `options.archive` 的三个动词，而它们没有第四个（没有删除）。
 *  - **档读一次。** 组合根构造板的时候发起一次 `load()`；写口把内存视图同步
 *    更新。所以「档变则重编」是同步成立的，不需要重读磁盘。
 *  - **没有到 `active` 的路。** 入档停在最远合法状态（见 `M-RUN.md` §入档落点），
 *    且 `MethodPointer` 只有 `"shadow"` 一个值。
 *
 * 读档失败一律 **fail closed 但不阻塞**（`§9`）：上报一条 degraded 观察，这一 turn
 * 按空档跑（不上场、不写入），用户的任务照做。那个「closed」由 `state.unavailable`
 * 兑现——见 `observeBeat` 的头几行，以及 `BoardState` 里那个字段的说明。
 */

export type MethodBoardOptions = {
  readonly experience?: ExperienceRuntime;
  readonly archive: MethodArchivePort;
  /** 板上的决策写到哪里去。缺省的板是不可观察的板，所以这里必填。 */
  readonly emit: MethodEventSink;
  /** ISO-8601 时刻，由组合根注入——学习层不读时钟。 */
  readonly now: () => string;
  /** 额度来自顶板。缺省 `DEFAULT_METHOD_GRANT`：一拍一次放权，槽 1200 字符 / 8 张（8 只当兜底）。 */
  readonly grant?: MethodGrant;
};

/** 等待记账的入档。 */
export type PendingAccount = {
  readonly versionId: string;
  readonly proposalId: string;
  readonly families: ReadonlySet<string>;
  readonly admittedBeat: number;
};

export type BoardState = {
  readonly options: MethodBoardOptions;
  readonly grant: MethodGrant;
  load: Promise<void> | undefined;
  archive: ReadonlyArray<VariantRecord>;
  shadowActivations: Readonly<Record<string, string>>;
  vocabulary: LabelVocabulary;
  ledger: ReleaseLedger | undefined;
  turnId: string | undefined;
  /** 本 turn 最近一次放权；`admitProposal` 用它做门与血缘的输入。 */
  release: MethodRelease | undefined;
  intentBeat: number | undefined;
  intentDelivery: { readonly turnId: string; readonly beat: number } | undefined;
  hook: MethodHook | undefined;
  hookBeat: number;
  pending: PendingAccount | undefined;
  /** 本 session 尚未消解的失败族；候选的族过滤读它。 */
  unresolvedFamily: FailureFamily | undefined;
  /**
   * 档读不出来时的降级原因。
   *
   * 它不是「日志字段」而是一个**开关**：设置在读档失败那一刻，`observeBeat` 一
   * 见到它就整拍不学。少了它，「fail closed 但不阻塞」里那个「closed」只是文件
   * 头的一句承诺——档案读不出来时往里写，正是 fail closed 要防的那件事（写一
   * 个看不见的档，于是既可能重复一条已有的卡，又可能把已有版本挤掉）。
   */
  unavailable: string | undefined;
};

export type MethodBoard = MethodLearningService & {
  readonly experience?: ExperienceRuntime;
  /** 只读：档里的 shadow 变体。本包没有自动入口（`OPEN-M2-1`），供审计与测试读。 */
  readonly shadowVariants: () => ReadonlyArray<ShadowVariant>;
};

export function createMethodBoard(options: MethodBoardOptions): MethodBoard {
  const state: BoardState = {
    options,
    grant: options.grant ?? DEFAULT_METHOD_GRANT,
    load: undefined,
    archive: emptyArchive(),
    shadowActivations: {},
    vocabulary: vocabularyOf([]),
    ledger: undefined,
    turnId: undefined,
    release: undefined,
    intentBeat: undefined,
    intentDelivery: undefined,
    hook: undefined,
    hookBeat: 0,
    pending: undefined,
    unresolvedFamily: undefined,
    unavailable: undefined,
  };

  // 「档读一次」就发生在这里：构造即发起，首次使用前 await。
  state.load = loadArchive(state);

  return {
    ...(options.experience === undefined ? {} : { experience: options.experience }),
    observe: (report) => observeBeat(state, report),
    intentOn: (turnId, beat) => intentOn(state, turnId, beat),
    confirmIntent: (turnId, beat) => state.intentDelivery?.turnId === turnId && state.intentDelivery.beat === beat,
    requestSlot: (request) => requestSlotFor(state, request),
    recordFielding: (notice) => recordFielding(state, notice),
    recordFeedback: async (notice) => recordFeedback(state, await options.experience?.enrich(notice) ?? notice),
    endTurn: async (turnId, signal) => {
      await closeTurn(state, turnId);
      await options.experience?.endTurn(signal);
    },
    shadowVariants: () => selectShadowVariants(state.archive, state.shadowActivations),
  };
}

async function loadArchive(state: BoardState): Promise<void> {
  const loaded = await readArchive(state.options.archive);
  if (!loaded.ok) {
    state.unavailable = loaded.reason;
    state.archive = emptyArchive();
    state.vocabulary = vocabularyOf([]);
    state.options.emit("observation", {
      degraded: true,
      component: "method_archive",
      reason: loaded.reason,
    });

    return;
  }

  state.archive = loaded.variants;
  state.shadowActivations = loaded.shadowActivations;
  state.vocabulary = vocabularyOf(loaded.variants);
}

/** 读口自己抛异常也当作「读不出来」，而不是让用户的任务跟着炸。 */
async function readArchive(port: MethodArchivePort): Promise<ArchiveLoadResult> {
  try {
    return await port.load();
  } catch {
    return { ok: false, reason: "archive_unreadable" };
  }
}


/**
 * 一拍执行事实。
 *
 * 次序是机理：记账 → 放权 → 收卡。三件事用的是同一批事实，而次序让它们看不见
 * 对方的产物——本拍刚入的档不参与本拍的记账，本拍刚放的权利不会在本拍就带上
 * 意图（意图是给下一拍的）。
 */
async function observeBeat(state: BoardState, report: MethodBeatReport): Promise<void> {
  await state.load;

  if (state.unavailable !== undefined) {
    // 档读不出来 = 这一 turn 不学，整拍退出。于是三件事一起不发生：不放权（因而
    // 不请求产出，也不装剥离器——用户看到的文本一个字符都不少）、不入档、不记账。
    // 降级原因已经在读档那一刻上报过了，这里不再报一次：同一件事说两遍会让日志
    // 看起来像两个故障。
    return;
  }

  await state.options.experience?.observeBeat?.(report);
  const ledger = ledgerFor(state, report.turnId);

  await accountPending(state, ledger, report);
  const ticked = releaseFor(ledger, factsOf(report), state.grant);

  state.ledger = ticked.ledger;
  state.unresolvedFamily = resolvedFamily(state.unresolvedFamily, report);

  if (ticked.decision.kind === "release") {
    state.ledger = withRelease(ticked.ledger, ticked.decision.release);
    state.release = ticked.decision.release;
    state.intentBeat = ticked.decision.release.beat + 1;
    state.unresolvedFamily = ticked.decision.release.reason;
    state.options.emit("observation", {
      component: "method_scheduler",
      decision: "release",
      releaseId: ticked.decision.release.releaseId,
      tool: ticked.decision.release.tool,
      code: ticked.decision.release.code,
      repeats: ticked.decision.release.repeats,
      reason: ticked.decision.release.reason,
    });
  }

  await admitProposal(state, report);
}


/**
 * 本拍附加通道抽出的 proposal → 门 → 入档。
 *
 * 先对上两件事：这一拍**确实**是放权后的那一拍（放权在拍 N，意图在拍 N+1，
 * 所以 `release.beat + 1 === report.beat`），且是同一个 turn。对不上就不看了
 * ——围栏块只能来自我们请它写的那一拍，别处来的文本不该被当成学习产出。
 *
 * 入档**不需要**验收拍（M1 的 OPEN-2 由此消失）：过门即入档，判决留在下一拍。
 * 写入是内容幂等的：同一 niche 的同一句话抽第二次，控制板以
 * `active_content_immutable` 回答，适配器把它读成「已经在档里」，于是这次入档
 * 是一次 no-op，而不是第二张同句变体。
 */
async function admitProposal(state: BoardState, report: MethodBeatReport): Promise<void> {
  const proposal = report.proposal;
  const release = state.release;
  if (proposal === undefined || release === undefined) {
    return;
  }

  if (release.turnId !== report.turnId || release.beat + 1 !== report.beat) {
    return;
  }

  const verdict = admitCard(proposal, {
    vocabulary: state.vocabulary,
    toolNames: report.toolNames,
    release,
  });
  if (verdict.kind === "refused") {
    state.options.emit("observation", {
      degraded: true,
      component: "method_gate",
      reason: verdict.code,
      releaseId: release.releaseId,
    });
    return;
  }

  await commitAdmitted(state, verdict, release, report);
}

/**
 * 账本：本 turn 一个。另一个 turn 的上报先关掉当前的，再开新的。
 *
 * 关掉时**不**为未记账的 `pending` 补一次判决：判决要由真实工具事实做出，为
 * 一拍没发生过的结算编一条，正是这个包要排除的自评。
 */
function ledgerFor(state: BoardState, turnId: string): ReleaseLedger {
  const current = state.ledger;
  if (current !== undefined && current.turnId === turnId) {
    return current;
  }

  if (current !== undefined) {
    forgetTurn(state);
  }

  state.turnId = turnId;
  const opened = createReleaseLedger(turnId);

  state.ledger = opened;

  return opened;
}

async function closeTurn(state: BoardState, turnId: string): Promise<void> {
  await state.load;

  if (state.unavailable === undefined && state.archive.length > 0 && state.options.archive.settle !== undefined) {
    const loaded = await state.options.archive.settle({ turnId, observedAt: state.options.now() });
    if (loaded.ok) {
      state.archive = loaded.variants;
      state.vocabulary = vocabularyOf(loaded.variants);
    } else {
      // A failed batch may have persisted a prefix. Stop using the stale view
      // until a new runtime can reload the authoritative log.
      state.unavailable = loaded.reason;
      state.archive = emptyArchive();
      state.vocabulary = vocabularyOf([]);
      state.options.emit("observation", { degraded: true, component: "method_settlement", reason: loaded.reason });
    }
  }

  if (state.turnId === turnId) forgetTurn(state);
}

function forgetTurn(state: BoardState): void {
  state.turnId = undefined;
  state.ledger = undefined;
  state.release = undefined;
  state.intentBeat = undefined;
  state.hook = undefined;
  state.hookBeat = 0;
  state.pending = undefined;
}
