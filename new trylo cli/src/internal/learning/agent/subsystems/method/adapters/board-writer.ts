import { createBoardReader, withBoardWriter, type LogAppender } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { ReduceErr, ReduceOk } from "../../../../control/result.js";
import type { BoardStore, StoreLoadErr } from "../../../../control/store-port.js";
import type { BoardState } from "../../../../control/state.js";
import {
  accountingEventOf,
  isMethodCardContent,
  variantOf,
  withVariant,
  type AccountingEvent,
} from "../assets/archive.js";
import type { VariantRecord } from "../domain/contracts.js";
import type {
  ArchiveLoadResult,
  ArchiveWriteResult,
  FeedbackInput,
  MethodArchivePort,
  UseInput,
} from "../port.js";
import { accountCommand, commitCommands, METHOD_ASSET_KIND, METHOD_DOMAIN } from "./method-commit.js";
import { feedbackCommandOf, useCommandOf, withUsesProjected } from "./method-fielding.js";
import { settlementFor } from "../assets/settlement.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { observationForFeedback } from "./experience-feedback.js";

/** 重新导出：身份常量住在 `method-commit.ts`，但写口是它们的公开面。 */
export { METHOD_ASSET_KIND, METHOD_DOMAIN };

/**
 * 方法卡 → 控制板命令的**唯一**适配器。
 *
 * 为什么只有这一个：`TRYLO-LEARNING-AGENT-顶层架构与目标.md` §5.4 规定控制板是
 * 学习侧唯一 writer，`AGENTS.md` 规定一个概念只有一个生命周期所有者。变体档案
 * 属于控制板，所以方法子系统**不得**自建第二本变体账——它只能说「把这四个命令
 * 按这个次序发出去」，然后从板上读回来。这个文件就是那句「说」。
 *
 * 它在本子系统的 `adapters/`，而不是 `domain/` 或 `assets/`：文件存储是适配器
 * 的知识。这里复用共享 Board writer；方法域只依赖 `MethodArchivePort`，不反向
 * 导入存储实现。
 *
 * ## 入档落点：停最远合法状态
 *
 * 规格 §7.2 的命令序列里有第五步 `enter_shadow`。本包**不发它**，因为
 * `control/apply-asset.ts::applyEnterShadow` 要求 `hasIndependentPass`——一条
 * 携带权威收据的独立证据——而 M2 没有独立验证器（`OPEN-M2-6`）。
 *
 * 于是只有两条路：伪造一条收据去换 shadow 指针，或者停在 `commit_asset`。本包
 * 取后者。理由不是「做不到」，而是**伪造收据会让档说一件没发生过的事**，而档的
 * 全部价值就在于它说的是发生过的事。停在 `commit_asset` 之后：
 *
 *  - 卡已经在 `state.assets` 里，也就是控制板的变体档案里——`§7.1` 要求的东西
 *    一样不少；
 *  - 没有任何 `activation` 被写，所以「档里任何指针都不许到 active」是**构造
 *    事实**，不是一条要记得遵守的纪律（I2）；
 *  - 若将来有别的写入者（或守卫放开之后）真的写了 shadow 激活，`load` 会如实
 *    把它带出来，但本包不因为读到它就改判什么。
 *
 * 实测次序见 `M-RUN.md` §入档落点。**不改 reducer 守卫**（规格 §7.2 明令）。
 */

/**
 * 写口失败词汇。这些是写口自己产生的码（reducer 产生的码由 `applyCommands` 原样
 * 带出，不在此列）：`recordUse` 的两道锁外快速失败，以及多命令序列的中途落盘失败。
 */
const BOARD_UNAVAILABLE = "board_unavailable";
const ASSET_NOT_FOUND = "asset_not_found";
/** 多命令序列中途落盘失败（E0M1 P2-3）：前若干条已写，调用方据此判断能否补齐。 */
const ARCHIVE_WRITE_FAILED = "archive_write_failed";

export type MethodBoardWriterOptions = {
  /** Original durable-boundary guard; pending new writes obey collection withdrawal. */
  readonly commandGuard?: (command: BoardCommand) => boolean;
  /**
   * 板日志追加的注入缝，缺省即真 `appendFileSync`（实现住在适配器那一侧）。
   *
   * 只服务故障注入测试（E0M1 P2-3）：让序列里第 N 条命令的落盘失败，从而证明部分写
   * 之后调用方拿得到类型化失败、且同 `writeId` 重试能幂等补齐而不重复事件。生产路径
   * 不传它，行为与从前逐字节一致。写口自己**一行 IO 都没有**，只把这个不透明选项转发
   * 给 `withBoardWriter`——名字也不带任何裸 fs 动词（`board.test.ts` T17 的结构守卫）。
   */
  readonly logAppender?: LogAppender;
};

/**
 * 建一个读写档的口。
 *
 * `rootDir` 由组合根给出，且**必须**是 `tryloHome(homeDir, env) + "/learning/board"`
 * ——`tryloHome` 是唯一公式（`surface/cli/session-paths.ts`），复制一份出来就会
 * 出现第二个家，`TRYLO_HOME` 生效时两个家只搬一个（反方表 #19）。
 */
export function createMethodBoardWriter(
  rootDir: string,
  options: MethodBoardWriterOptions = {},
): MethodArchivePort {
  return {
    load: () => loadArchive(rootDir),
    commitCard: (input) => applyCommands(rootDir, commitCommands(input), options),
    recordAccount: (input) => applyCommands(rootDir, [accountCommand(input)], options),
    recordUse: (input) => recordUseCommand(rootDir, input, options),
    recordFeedback: (input) => recordFeedbackCommand(rootDir, input, options),
    settle: (input) => settleArchive(rootDir, input, options),
  };
}

/**
 * 读档。
 *
 * 文件不存在**不是错误**：关闭控制器时那里本来就没有文件，空档是正确答案
 * （`§7.3`）。读不出来（损坏、校验和不符、锁不可用）才是错误，由调用方
 * fail closed 地上报一条 degraded 观察后按空档跑。
 */
async function loadArchive(rootDir: string): Promise<ArchiveLoadResult> {
  const loaded = await createBoardReader(rootDir).load();
  if (!loaded.ok) {
    return { ok: false, reason: `${loaded.reason}:${loaded.detail}` };
  }

  return {
    ok: true,
    variants: variantsOf(loaded.state),
    shadowActivations: shadowActivationsOf(loaded.state),
  };
}

/**
 * 从板上折出变体档。
 *
 * 记账**不在本地存第二份**：`supports` / `counterexamples` 由证据里的
 * `provenance` 折出来（`method:account:supports` / `:counterexamples`）。板是唯一
 * 真相，读进来的每一次记账都是板上的一个事实的投影。
 *
 * `uses` 由 M1 上场记录折出来（D-M1：同 turn 同 version 去重计数，
 * `requestId` 明细保留在 `fieldings` 里用于排障）。旧档（M1 前）没有上场
 * 事件，`uses` 为 0 并如实保持——缺失上场历史是 unknown/0，不是伪造的活跃。
 *
 * 读不懂的 `content` 一律**跳过**：一张读不懂的卡进不了提示词，而「半信半疑地
 * 用它」比丢掉它危险得多。
 */
export function variantsOf(state: BoardState): ReadonlyArray<VariantRecord> {
  const accounting = accountingByVersion(state);
  let archive: ReadonlyArray<VariantRecord> = [];

  for (const asset of state.assets) {
    const proposalId = asset.createdFromProposalId;
    if (proposalId === undefined || !isMethodCardContent(asset.content)) {
      continue;
    }

    archive = withVariant(archive, variantOf({
      versionId: asset.versionId,
      proposalId,
      card: asset.content,
      accounting: accounting.get(asset.versionId) ?? [],
    }));
  }

  return withUsesProjected(archive, state);
}

function accountingByVersion(
  state: BoardState,
): ReadonlyMap<string, ReadonlyArray<AccountingEvent["outcome"]>> {
  const versionOfProposal = new Map<string, string>();

  for (const asset of state.assets) {
    if (asset.createdFromProposalId !== undefined) {
      versionOfProposal.set(asset.createdFromProposalId, asset.versionId);
    }
  }

  const byVersion = new Map<string, AccountingEvent["outcome"][]>();

  for (const bundle of state.evidence) {
    const outcome = accountingEventOf(bundle.provenance);
    const versionId = versionOfProposal.get(bundle.proposalId);
    if (outcome === undefined || versionId === undefined) {
      continue;
    }

    const bucket = byVersion.get(versionId) ?? [];

    bucket.push(outcome);
    byVersion.set(versionId, bucket);
  }

  return byVersion;
}

/**
 * 板上的 shadow 激活，`versionId -> activationId`。
 *
 * 只认 `pointer === "shadow"`：`active` 是方法卡不存在的世界（I2），把它的
 * 收据带进档只会让读的人以为方法卡能到那儿。
 */
function shadowActivationsOf(state: BoardState): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};

  for (const activation of state.activations) {
    if (activation.pointer === "shadow") {
      found[activation.versionId] = activation.activationId;
    }
  }

  return found;
}

/**
 * 发一串命令。
 *
 * 一次入档是四个命令，而它们必须**一起**成立：半个生命周期（提了案没入隔离区、
 * 或入了隔离区没提交版本）在板上是一条谁也读不懂的记录。所以它们在一个
 * `withBoardWriter` 里按序发，任何一条被 reducer 拒掉就立刻停手并把拒绝码原样
 * 带出来——**不重试、不绕过、不改成另一条命令**。
 *
 * 幂等由 `commandId` 承担：`commandId` 从 `writeId` 派生，`writeId` 从卡的内容
 * 派生。同一张卡重放一次（进程在中途被杀、上游重试）会得到同一串 `commandId`，
 * reducer 把它们当作已应用的重放，于是 `duplicate` 为真而板上不多出第二条生命
 * 周期。这是「重复不是错误，是模型重复了自己」的兑现处。
 */
async function applyCommands(
  rootDir: string,
  commands: ReadonlyArray<BoardCommand>,
  options: MethodBoardWriterOptions = {},
): Promise<ArchiveWriteResult> {
  const result = await withBoardWriter(
    rootDir,
    (store) => applyCommandSequence(store, commands),
    options,
  );
  return "events" in result
    ? result
    : { ok: false, reason: result.reason, detail: result.detail };
}

/**
 * 在一把锁内按序发命令，把任何失败都归一化成 `ArchiveWriteResult`。
 *
 * 逐条 append 不是原子的：磁盘在第 k 条中途失败时，前 k-1 条已经落盘——这是一次
 * **真实的部分写**。它不能变成抛出去的异常，否则调用方拿不到状态、无从判断「写到
 * 哪了、能不能补」。所以这里把 append 失败收成类型化的 `archive_write_failed`，已写
 * 的那部分留在账上；幂等由 `commandId` 承担，同 `writeId` 重试时前 k-1 条按重放跳过、
 * 只补未写的那条，最终状态完整且事件不重复（E0M1 P2-3）。
 */
export async function applyCommandSequence(
  store: BoardStore,
  commands: ReadonlyArray<BoardCommand>,
): Promise<ArchiveWriteResult> {
  let events = 0;
  let duplicate = false;
  let variants: ReadonlyArray<VariantRecord> | undefined;

  for (const command of commands) {
    let applied: ReduceOk | ReduceErr | StoreLoadErr;

    try {
      applied = await store.apply(command);
    } catch (error) {
      // 终局分支：归一化成类型化失败，不吞、不伪造成功（已写的部分仍在账上）。
      return {
        ok: false,
        reason: ARCHIVE_WRITE_FAILED,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (!applied.ok) {
      return { ok: false, reason: applied.reason, detail: applied.detail };
    }

    events += applied.events.length;
    duplicate = duplicate || applied.idempotent;
    variants = variantsOf(applied.state);
  }

  return { ok: true, events, duplicate, ...(variants === undefined ? {} : { variants }) };
}

async function settleArchive(
  rootDir: string,
  input: { readonly turnId: string; readonly observedAt: string },
  options: MethodBoardWriterOptions,
): Promise<ArchiveLoadResult> {
  const result = await withBoardWriter(rootDir, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return loaded;

    const commands: BoardCommand[] = settlementFor(variantsOf(loaded.state), input.observedAt).map(record => ({
      type: "set_method_retention", commandId: shortId("method-retention", [record.versionId, record.layer, record.retention]),
      issuedAt: input.observedAt, record,
    }));
    const written = await applyCommandSequence(store, commands);
    if (!written.ok) return written;

    return { ok: true as const, variants: written.variants ?? variantsOf(loaded.state),
      shadowActivations: shadowActivationsOf(loaded.state) };
  }, options);
  return result.ok && "variants" in result
    ? result : { ok: false, reason: result.ok ? BOARD_UNAVAILABLE : result.reason };
}

/**
 * 上场记录（M1，D-M1）。
 *
 * 只接受已入档的版本：未知 `versionId` 直接拒绝，不记一条指向不存在卡的
 * 上场（「只接受该轮实际展示过的版本」的写口侧一半；展示集合检查留给 M2
 * 的发送边界，本包保证不断言 phantom 版本）。
 */
async function recordUseCommand(
  rootDir: string,
  input: UseInput,
  options: MethodBoardWriterOptions,
): Promise<ArchiveWriteResult> {
  const loaded = await loadArchive(rootDir);
  if (!loaded.ok) {
    return { ok: false, reason: BOARD_UNAVAILABLE, detail: loaded.reason };
  }

  if (!loaded.variants.some((variant) => variant.versionId === input.versionId)) {
    return { ok: false, reason: ASSET_NOT_FOUND, detail: input.versionId };
  }

  return applyCommands(rootDir, [useCommandOf(input)], options);
}

/**
 * 帮助反馈（M1，E0M1 P1-2；外审 P1-3 收紧）。
 *
 * 归因与唯一性**不在这里预检**：从前这一步在 `withBoardWriter` 锁外读档、归因、
 * 再发命令，于是（a）读到写下之间可被并发写穿越（TOCTOU），（b）直接命令与日志
 * 重放完全绕过它。P1-3 把这两道关系守卫下沉到 canonical reducer
 * （`learning/control/apply-method-ledger.ts::applyRecordMethodFeedback`），它总在
 * 写锁内运行、且是每条入口唯一的收敛点。写口因此只剩「把命令交给锁内的那一个
 * 权威去判」：孤儿 → `feedback_unattributable`，多候选无 exposureId → `feedback_ambiguous`，
 * 同一 exposure 已有判决 → `feedback_conflict`，全部由 reducer 原样带出，拒绝写入、
 * 保持 unknown，绝不当成 false（F03/F05）。
 */
async function recordFeedbackCommand(
  rootDir: string,
  input: FeedbackInput,
  options: MethodBoardWriterOptions,
): Promise<ArchiveWriteResult> {
  const result = await withBoardWriter(rootDir, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return loaded;
    const observation = input.observation ?? observationForFeedback(loaded.state, input);
    return applyCommandSequence(store, [feedbackCommandOf({ ...input,
      ...(observation === undefined ? {} : { observation }) })]);
  }, options);
  return "events" in result ? result : { ok: false, reason: result.reason, detail: result.detail };
}

