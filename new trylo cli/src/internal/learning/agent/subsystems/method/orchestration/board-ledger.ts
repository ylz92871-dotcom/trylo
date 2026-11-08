import { shortId } from "../../../../domains/shared/hash.js";
import {
  isFailureFamily,
  type FailureFamily,
  type MethodCard,
  type ObservedFact,
  type VariantRecord,
} from "../domain/contracts.js";
import { withAccount } from "../assets/archive.js";
import type { MethodBeatReport } from "../port.js";
import { reasonFor, type ReleaseLedger } from "../domain/release.js";
import type { BoardState } from "./board.js";

/**
 * 板上的**纯**那一半：从一拍事实算出该记什么账。
 *
 * 与 `board.ts` 分开，是因为这里的每个函数都不碰 I/O、也不改状态：
 * `factsOf` 把上报缩成可比的三元组，`accountPending` 决定上一张卡这一拍记支持
 * 还是记反例，`recurs` 判断同族是不是又来了，`familiesOf` 说出一张卡属于哪些
 * 族，`hookLabelsFor` 回答上一拍写下的钩子这一拍还作不作数。全是纯函数，所以
 * 「记错了」可以被用例直接摆布，而不必把整块板跑起来。
 *
 * 写状态与发命令留在 `board.ts`：一次入档要按序走控制板的几条命令，那是一件
 * 有时序的事，混进这一半会让「纯」这个性质消失。
 */

export function factsOf(report: MethodBeatReport): {
  readonly turnId: string;
  readonly beat: number;
  readonly failures: ReadonlyArray<ObservedFact>;
  readonly succeededTools: ReadonlyArray<string>;
} {
  return {
    turnId: report.turnId,
    beat: report.beat,
    failures: report.failures,
    succeededTools: report.succeededTools,
  };
}

/**
 * 记账：上一拍入档的卡，由这一拍的事实判决（`§7.5`）。
 *
 *   - 同类失败（同族）复现      → `counterexamples += 1`
 *   - 同类失败没有复现          → `supports += 1`
 *   - 这一拍一个工具都没 settle → **不记账**，留到下一拍
 *
 * 「不记账」而不是「记为支持」，因为沉默不是成功；也不是反例，因为什么都没发生
 * 不构成反驳。所以那个 `pending` 会留着，直到有一拍真的说了话。
 *
 * 判决之后 `pending` 就没了：一张卡被「下一拍」判决一次。一张卡在别的 turn 再
 * 被上场不该再记一次——「使用次数」的口径是 `OPEN-M2-2`，而记账（支持/反例）
 * 在本包是**入档那一拍之后的第一拍**的一次性事实。
 */
export async function accountPending(
  state: BoardState,
  ledger: ReleaseLedger,
  report: MethodBeatReport,
): Promise<void> {
  const pending = state.pending;
  if (pending === undefined || report.beat <= pending.admittedBeat) {
    return;
  }

  if (report.failures.length + report.succeededTools.length === 0) {
    return;
  }

  state.pending = undefined;
  const prior = Object.values(ledger.records).map((record) => record.fact);
  const outcome = recurs(report.failures, pending.families, prior) ? "counterexamples" : "supports";
  const stamp = [report.turnId, String(report.beat), pending.versionId, outcome];
  const written = await state.options.archive.recordAccount({
    writeId: shortId("method_account", stamp),
    evidenceId: shortId("method_account_evidence", stamp),
    proposalId: pending.proposalId,
    outcome,
    samples: report.failures.map((fact) => `${fact.tool}:${fact.code}`).slice(0, 3),
    observedAt: state.options.now(),
  });
  if (!written.ok) {
    state.options.emit("observation", {
      degraded: true,
      component: "method_archive",
      reason: written.reason,
      versionId: pending.versionId,
    });
    return;
  }

  state.archive = written.variants ?? withAccount(state.archive, pending.versionId, outcome);
  state.options.emit("observation", {
    component: "method_account",
    versionId: pending.versionId,
    outcome,
    supports: ledgerOf(state, pending.versionId)?.supports ?? 0,
    counterexamples: ledgerOf(state, pending.versionId)?.counterexamples ?? 0,
  });
}

export function ledgerOf(state: BoardState, versionId: string): VariantRecord["ledger"] | undefined {
  return state.archive.find((variant) => variant.versionId === versionId)?.ledger;
}

/**
 * 同类失败是否复现。
 *
 * 「同类」用的是这一拍失败的**释放理由**是否落在卡的族集合里——卡声明的
 * `family`、`appliesWhen.failureFamily`，以及它标签里那些本身就是失败族的
 * （词表种子就是这六个数，所以每个 niche 都至少能表达族）。
 *
 * 族集合为空的卡（没声明族、标签也没用族词）**无法被反例化**：它没做出任何族
 * 的断言，所以本包只给它记支持。这是宽的一侧，登记在 `OPEN-M2-2`。
 *
 * `prior` 是本 turn 更早的拍记下的事实，不含正在折的这一拍——判别用的是历史，
 * 判别的对象才是这一拍。
 */
export function recurs(
  failures: ReadonlyArray<ObservedFact>,
  families: ReadonlySet<string>,
  prior: ReadonlyArray<ObservedFact>,
): boolean {
  return failures.some((fact) => {
    const family = reasonFor(fact, prior);
    return family !== undefined && families.has(family);
  });
}

export function familiesOf(card: MethodCard): ReadonlySet<string> {
  const families = new Set<string>();

  if (card.family !== undefined) {
    families.add(card.family);
  }

  if (card.appliesWhen.failureFamily !== undefined) {
    families.add(card.appliesWhen.failureFamily);
  }

  for (const label of card.labels) {
    if (isFailureFamily(label)) {
      families.add(label);
    }
  }

  return families;
}

/**
 * 「未消解」的读法。
 *
 * 一拍干净地结算了（有成功、没有失败）就算这一族消解了；这一拍还在失败、或者
 * 根本没 settle，都不改判——沉默既不是消解，也不是复现。
 */
export function resolvedFamily(
  current: FailureFamily | undefined,
  report: MethodBeatReport,
): FailureFamily | undefined {
  if (report.failures.length > 0) {
    return current;
  }
  return report.succeededTools.length > 0 ? undefined : current;
}

/** 钩子只活一拍：它跟着**它之后**的那次请求出去。 */
export function hookLabelsFor(state: BoardState, beat: number): ReadonlyArray<string> | undefined {
  return state.hook !== undefined && state.hookBeat < beat ? state.hook.labels : undefined;
}
