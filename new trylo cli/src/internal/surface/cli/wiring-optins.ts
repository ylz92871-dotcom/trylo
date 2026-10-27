import type { LocalRuleLookup } from "../../adapters/project-instructions/appendix.js";
import type { WebToolsConfig } from "../../adapters/tools/web/index.js";
import type { MemoryReadPort } from "../../ports/memory.js";
import type { ToolGapRuntime } from "../../integration/tool-learning/index.js";
import type { UserLearningRuntime, UserMemoryService } from "../../integration/user-learning/index.js";
import type { MethodEventSink } from "../../learning/method/port.js";
import type {
  SubagentEventSink,
  SubagentGovernanceTracker,
} from "../../subagent/index.js";
import type { SubagentRole } from "../../subagent/role.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import type { CompactSummaryMode } from "./args.js";
import type { PermissionLedgerInput } from "./permission-ledger-wiring.js";
import type { LspServerConfig } from "../../adapters/language-server/registry.js";
import type { ShellModeResult } from "../../adapters/sandbox/shell-mode.js";
import type { RunExecution } from "./run-execution-wiring.js";
import type { FileAccessMode } from "../../ports/tools.js";
import type { AskUserSession } from "../../adapters/tools/ask-user/index.js";

/**
 * Everything a run can be lent, none of it on by default.
 *
 * One type in one file because "what did this run switch on" is a single fact
 * with a single answer. Left scattered through `wiring.ts`, the same question
 * could be asked twice and the second answer would be the one that forgot a
 * field — which is exactly how a run ends up sending a project's root rules in
 * its seed messages while `read_file` re-sends them on every read.
 *
 * The one opt-in that is *not* here is `mcp`, and that is architecture rather
 * than taste: `wiring.ts` is the composition root that builds the tool table, so
 * the shape of that table belongs to it. Naming MCP from a module that never
 * composes one would be a second place to answer "what tools does this run
 * have", and the architecture gate (#12) holds that answer to one file.
 *
 * The discipline every field below obeys: **absent means off**. An absent field
 * constructs nothing, opens no file and reads no byte, so a default run is
 * byte-identical to one that predates the subsystem (R1).
 */

export type MethodLearningInput = {
  /**
   * The switch's value. Anything but the single accepted word is off; the
   * vocabulary lives in the integration helper, not here, so there is no second
   * place to disagree with it.
   */
  readonly switch?: string;
  /** The home directory `tryloHome` resolves against. */
  readonly homeDir: string;
  /** The environment `tryloHome` reads `TRYLO_HOME` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Where the board's decisions go. Required, because a board with no sink is
   * an unobservable board — `§7.1` wants its decisions visible, and "invisible"
   * is not a state a wired subsystem is allowed to be in.
   */
  readonly emit: MethodEventSink;
};

export type SubagentWiringInput = {
  readonly team?: import("../../subagent/team.js").SubagentTeam;
  readonly enabled?: boolean;
  readonly onEvent?: SubagentEventSink;
  readonly governance?: SubagentGovernanceTracker;
  readonly idGenerator?: (name: string) => string;
  /**
   * Roles discovered for this turn (C44/L27). Absent means the run offers no
   * `agent_type` at all, which is byte-identical to a run that never heard of
   * roles — the tool text falls back to the plain one.
   */
  readonly roles?: ReadonlyArray<SubagentRole>;
};

export type WiringOptIns = {
  readonly questions?: AskUserSession;
  /** Lent by the prepared session: background commands must survive turn boundaries. */
  readonly execution?: RunExecution;
  /**
   * Opt-in for the method subsystem. Absent — which is every default path —
   * means no board is built, nothing is read and `LoopPorts.method` stays
   * undefined.
   */
  readonly learning?: MethodLearningInput;
  /**
   * Opt-in for user learning (UE-2/UE-3). Absent — every default path — means
   * the user half is not built at all: no ledger read, no ledger write, no
   * policy segment. Present, it is composed *with* the method slot into the
   * one port the loop knows (`LoopPorts.method`), so the two subsystems share
   * a single ceiling instead of racing for two.
   *
   * The runtime arrives fully built rather than as a description, because the
   * same object has to be lent to the journal observer in `host.ts`: a wiring
   * that built its own copy would observe a turn the port never saw.
   */
  readonly userLearning?: UserLearningRuntime;
  /**
   * Opt-in for tool learning (P05 tool learning §2). Absent — every default
   * path, including `--learning=method` and `--learning=user` — means the
   * awareness layer is never built: no ledger read, no fence requested, no
   * text held back, and the run is byte-identical to one that never heard of
   * it. Present, the runtime's port is lent to the loop as a *separate*
   * optional field rather than folded into the method slot: the two fences
   * are independent machines (spec §2), and so are their ports.
   */
  readonly toolGap?: ToolGapRuntime;
  /**
   * Subagent infrastructure options (SA-S-2). Absent — every default path —
   * means no SubagentRuntime or delegate_subagent tool is mounted, preserving
   * byte-identical tool catalog hashes and behavior (WP §5 item 8).
   */
  readonly subagent?: SubagentWiringInput;
  /**
   * 持久 Permission 账本。Absent —— 每一条默认路径 —— 就是与从前逐字相同的行为：
   * 不开文件、不建目录、不读一个字节，所以没有这个开关的运行与「从未听说过账本」
   * 的运行 byte-identical（R1）。
   *
   * 消费方（工具链准入门）尚未接线，所以本波接通的是账本的构造与它的开关面，
   * 不是「谁在记账」——见 `permission-ledger-wiring.ts` 的模块头。
   */
  readonly permissionLedger?: PermissionLedgerInput | undefined;
  /**
   * `--compact-summary`：compaction 摘要的写手。Absent —— 每一条默认路径 ——
   * 意味着 `compactionWiring` 继续携带出厂的 extractive 写手，与从前逐字相同
   * （R1）。Present 且为 `model` 时，写手换成一次无工具的 provider 调用，失败
   * 落回 extractive ——见 `compact-model-summarizer.ts` 的模块头。
   */
  readonly compactSummary?: CompactSummaryMode;
  /**
   * `--allow-web`：true 才把网络工具挂进工作区工具表。Absent 时端口不
   * 构造、catalog 哈希逐字不变（R1）；授权仍走审批门，这里只管挂载。
   */
  readonly allowWeb?: boolean;
  /**
   * 网络工具的后端（WP20）。Absent —— 每一条默认路径 —— 意味着 `web_fetch`
   * 只有出厂能力：无缓存、无 prompt 提取、无 `web_search`。
   *
   * 与 `allowWeb` 分开是因为它们回答的不是同一个问题：开关说「这次运行被允许
   * 联网」，这里说「有什么能真的联网做事」。合成一个布尔就会造出第三种状态 ——
   * 「允许联网但没有搜索后端」——而那正是 `web_search` 挂不挂的关键。
   */
  readonly web?: WebToolsConfig;
  /**
   * 本次运行可检索的记忆端口（WP20.3: C60/L51）。Absent —— 每一条默认路径 ——
   * 意味着目录里没有 `memory_search`/`memory_read`，catalog 哈希逐字不变。
   *
   * 传端口而不是传 board/路径：读什么由已经拥有那些记录的调用方回答。组合根
   * 若自己去开 board，就会在学习控制面旁边放第二个读者。
   */
  readonly memory?: MemoryReadPort;
  /**
   * 正式用户记忆的写入口（WP-CL / B）。Absent —— 未开启用户学习的每一条路径 ——
   * 目录里没有 `memory_remember`/`memory_forget`。
   */
  readonly memoryWrite?: UserMemoryService;
  /**
   * `read_file` 的局部规则附段接点（WP-CLI-B1 §3.1）。Absent —— 每一条默认路径 ——
   * 工具结果与从前逐字相同。构造在 `host.ts`，每轮一次：本轮的冻结就是这一轮的
   * 生命周期，下一轮重新读当前文件。
   */
  readonly localRules?: LocalRuleLookup;
  /**
   * 运行中输入的供给者（WP08: C03/C82/L42）。Absent —— 每一条默认路径，包括
   * `trylo run` 与管线里的 REPL —— 意味着 `LoopPorts.pendingInput` 不存在，
   * turn 与「从未听说过运行中追加」逐字相同（R1）。
   *
   * 传的是「问一次交一次」的闭包而不是队列本身：谁持有那些话由拥有终端的交互
   * 面回答，组合根若自己也留一份，就会有两个读者争同一句话。
   *
   * 调用方带上本轮 turnId —— 只有 loop 知道「现在问的是哪一轮」，于是给一个
   * 已经结束的轮次写的字可以由持有者直接回答「没有你的份」（WP08.1）。
   */
  readonly pendingInput?: (turnId: string) => ReadonlyArray<AddressedUserInput>;
  /**
   * Validated language servers (WP12 L60, pool built in lsp-wiring.ts).
   * Absent means no pool, no tool, no process, byte-identical catalog.
   */
  readonly languageServers?: ReadonlyArray<LspServerConfig>;
  /**
   * The run's shell mode (WP05 C06/C07, resolved in shell-mode-wiring.ts).
   * Absent is the direct path; a resolved failure fails each call by name.
   */
  readonly shellMode?: ShellModeResult;
  readonly fileAccess?: FileAccessMode;
};
