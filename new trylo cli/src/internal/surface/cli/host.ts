import type { LocalRuleSource } from "../../adapters/project-instructions/appendix.js";
import { bootstrapContextFor, type BootstrapContextBinding } from "./bootstrap-context.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import { openMcpRuntime, type McpRuntime } from "../../adapters/mcp-runtime/index.js";
import type { McpClientOpen } from "../../adapters/mcp-runtime/factory.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import type { SystemPromptDirective, ReasoningEffort } from "../../ports/provider.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import type { WebToolsConfig } from "../../adapters/tools/web/index.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import { runRecordedTurn, budgetOf, pricingOf } from "./turn-execution.js";
import { hostFailure } from "./host-failure.js";
import { createTurnRecorder } from "./turn-recorder.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { McpRegistryPort, McpServerEntry } from "../../ports/mcp-registry.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { ExecPolicyGuard } from "../../loop/tool-admission.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { PermissionGrantCache } from "../../loop/permission-grants.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { CompactSummaryMode, OutputFormat } from "./args.js";
import type { Message } from "../../contract/execution.js";
import type { MethodLearningHost } from "./learning-sink.js";
import { createUserLearningRuntimeFor, type UserLearningHost } from "./user-learning-config.js";
import { createToolGapRuntimeFor, type ToolLearningHost } from "./tool-learning-config.js";
import { userLearningObserver } from "../../integration/user-learning/index.js";
import { createTurnRenderer, type CliSink } from "./render.js";
import { localRulesFor } from "./project-rules.js";
import { memoryForTurnInput } from "./memory-wiring.js";
import { memoryCommandWiring } from "./memory-command-provider.js";
import { fileCommandWiring } from "./file-command-provider.js";
import { reportProjectNotices } from "./turn-project-notices.js";
import { createSubagentJournalSink, finishSubagentEvents } from "./subagent-sink.js";
import type { SubagentRole } from "../../subagent/role.js";
import type { LspServerConfig } from "../../adapters/language-server/registry.js";
import type { ShellModeResult } from "../../adapters/sandbox/shell-mode.js";
import type { FileAccessMode } from "../../ports/filesystem.js";
import { finishTurn, wiringFailure, type TurnOutcome } from "./turn-finish.js";
import { turnStartRefusal } from "./turn-start-checks.js";
import { wirePorts, type Wiring } from "./wiring.js";
import { turnWiringInput } from "./turn-wiring-input.js";
import { executeCompaction } from "./compact-maintenance.js";
import type { RunFailure } from "./run-failure.js";
import type { RunExecution } from "./run-execution-wiring.js";
import type { AskUserSession } from "../../adapters/tools/ask-user/index.js";

// `TurnOutcome` moved to `turn-finish.ts`, which is the file that produces it.
// Every caller has always named it here, so the name stays reachable here.
export type { TurnOutcome } from "./turn-finish.js";

/**
 * The CLI run host.
 *
 * Both `trylo run` and the REPL call this: neither owns a loop of its own. The
 * host is the only place where ports, the durable session and the projection
 * meet, so a fix here applies to every surface at once.
 */

export type TurnHostInput = {
  readonly bindAgentTools?: (tools: Wiring["ports"]["tools"] | undefined) => void;
  readonly bootstrap?: BootstrapContextBinding;
  readonly userSourceAvailable?: false;
  readonly toolSelection?: readonly string[];
  readonly questions?: AskUserSession;
  readonly execution?: RunExecution;
  readonly toolCatalogHash?: string;
  readonly text: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly correlationId: string;
  readonly workspaceRoot: string;
  /** Storage for workspace snapshots, outside the workspace itself. */
  readonly checkpointRoot: string;
  readonly workspaceId: string;
  /** The selected id: a shipped one, or one declared in `providers.json`. */
  readonly providerId: string;
  /**
   * The adapter family, when it is not the id: a declared provider's id is
   * whatever the person called it, and the family is what builds it.
   */
  readonly providerKind?: ProviderKind;
  /** Passed unchanged to the Responses adapter; absent preserves its wire body. */
  readonly reasoningSummary?: "auto";
  readonly reasoningEffort?: ReasoningEffort;
  readonly model: string;
  readonly endpoint: string;
  /**
   * The credential the composition root resolved through `CredentialPort`.
   * Undefined means nothing resolved; the provider adapter turns that into the
   * usual auth refusal before any request is sent.
   */
  readonly apiKey: string | undefined;
  readonly tokenManager?: TokenManagerLike | undefined;
  readonly accountId?: string | undefined;
  readonly permission: PermissionPort;
  readonly execPolicy?: ExecPolicyGuard;
  readonly grants?: PermissionGrantCache;
  readonly onRunEnvelope?: (envelope: Envelope) => void;
  readonly format: OutputFormat;
  readonly sink: CliSink;
  /**
   * A cancellation the surface can raise while this turn is in flight (WP
   * `2026-09-16-WP-传统CLI-交付面收尾波` D3). Undefined means the turn cannot be
   * stopped from outside — every caller that has no interrupt source to listen
   * to. Aborting it ends the turn `cancelled`; it is never an exception.
   */
  readonly cancelSignal?: AbortSignal;
  /**
   * What the person typed while this turn was running (WP08). A lender, not a
   * queue: calling it takes what it returns. The contract is written out in
   * `domain/input-queue.ts`, which is the one place both ends of it are said.
   */
  readonly pendingInput?: (turnId: string) => ReadonlyArray<AddressedUserInput>;
  /** Milliseconds since the epoch. Injected so runs are reproducible in tests. */
  readonly now: () => number;
  readonly session?: SessionPort;
  readonly resumeTranscript?: Transcript;
  /** The window a resumed journal projects under; absent means the whole past. */
  readonly resumeView?: CompactWindow;
  /** The journal a resume was loaded from, so a compaction projects over it. */
  readonly resumeRecords?: ReadonlyArray<SessionRecord>;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  /** The dollar ceiling and the pricing pair that makes it enforceable (WP09.3/L07). */
  readonly maxBudgetUsd?: number;
  readonly inputPricePerMTok?: number;
  readonly outputPricePerMTok?: number;
  /**
   * A caller-supplied system prompt (`--system-prompt` replace or
   * `--append-system-prompt` append, WP18.3). Absent — every caller that never
   * passed the flags — means the seeds are exactly the ones the un-wired path
   * assembles.
   */
  readonly systemPrompt?: SystemPromptDirective;
  /**
   * Text appended as a system message after the seeds. Applied after
   * `systemPrompt`, so the two flags compose in legacy order.
   */
  readonly systemPromptAppend?: string;
  /**
   * JSON Schema the final answer must satisfy (`--output-schema`, WP18.3).
   * Absent means the provider decides its own shape.
   */
  readonly responseSchema?: JsonObject;
  /**
   * The context ceiling. Successful reductions rearm compaction in the
   * iteration gap; absent means the transcript is sent whole, exactly as it was
   * before compaction existed. There is no second, defaulting ceiling.
   */
  readonly contextTokenLimit?: number;
  /**
   * The context a run opens its MCP servers from. Absent — which is every
   * caller that has no registry to read — means the run offers no external
   * tools, exactly as it did before this package existed. Present means the
   * enabled servers are opened once, here, and closed again when the turn ends.
   */
  readonly mcp?: McpRuntimeContext;
  /**
   * The warm layer, when the surface runs more than one turn. Absent — `trylo
   * run`, every single-turn caller — means the provider is built for the turn
   * and dropped with it, exactly as it always was.
   */
  readonly warm?: WarmRegistry;
  /**
   * The `--learning` switch. Absent — every default path — means no board, no
   * `load()`, no directory, no event log (I1). Present, it is lent a clock and
   * somewhere to report "learning could not be written" without failing a turn.
   */
  readonly learning?: MethodLearningHost;
  /**
   * The user-learning half of the same switch. Absent — every default path, and
   * also `--learning=method` — means no ledger is read or written and no policy
   * segment exists (I1). Present, the run builds one runtime, lends it to the
   * composition root as the second half of the learning slot, and lends the
   * *same* object to the journal observer — that is what makes "the evidence
   * this turn produced" and "the policy this turn was given" the same run.
   */
  readonly userLearning?: UserLearningHost;
  /**
   * The tool-learning half of the same switch. Absent — every default path —
   * means no ledger is read or written and no self-report fence exists. The
   * host carries facts (`homeDir` + `env`), never paths: `tool-learning-config.ts`
   * resolves the root through the one home formula.
   */
  readonly toolGap?: ToolLearningHost;
  /**
   * 本次运行要求背书的持久 Permission 账本。Absent —— 每一条默认路径 —— 意味着
   * 不开文件、不建目录、不读一个字节（R1）。Present 时，组合根构造账本，本文件在
   * 开跑前证明它读得出来：读不出来就以失败码拒绝启动，绝不静默降级成「没有账本」。
   */
  readonly permissionLedger?: { readonly path: string };
  /**
   * `--subagent`：把子代理运行时挂进这次运行。Absent —— 每一条默认路径 ——
   * 意味着 `wiring.ts` 收到的开关是关的，运行时根本不构造（R1）。
   */
  readonly subagentEnabled?: true;
  /** Roles discovered for this turn (C44/L27). Absent means none offered. */
  readonly subagentRoles?: ReadonlyArray<SubagentRole>;
  readonly subagentTeam?: import("../../subagent/team.js").SubagentTeam;
  /** Validated language servers (WP12 L60). Absent means no `lsp_navigate`. */
  readonly lspServers?: ReadonlyArray<LspServerConfig>;
  /** The run's shell mode (WP05 C06/C07). Absent is the direct path. */
  readonly shellMode?: ShellModeResult;
  readonly fileAccess?: FileAccessMode;
  /** `--allow-web`：只决定挂载网络工具；每一次调用仍由审批门把关。 */
  readonly allowWeb?: boolean;
  /**
   * 网络工具的后端（WP20）。Absent —— 每一条默认路径 —— 意味着 `web_fetch`
   * 无缓存、无 prompt 提取，且没有 `web_search`（R1）。
   */
  readonly web?: WebToolsConfig;
  /**
   * `--compact-summary`：谁给 compaction 写摘要。Absent 与 `extractive` 逐字
   * 相同 ——`wiring.ts` 继续用出厂的 extractive 写手，一个多余请求都不发（R1）。
   */
  readonly compactSummary?: CompactSummaryMode;
  /**
   * 本次运行要背书的项目上下文（WP-CLI-B1 §3.2）：项目自己的工程规则与真实
   * 平台。Absent —— 每一条默认路径与每个既有调用方 —— 意味着这一轮的消息与
   * 字段存在之前逐字相同：种子消息为空，规则装配根本不被构造（R1）。
   *
   * 这里传的是**已经装配好的** caller messages 与来源清单，不是路径：文件读取
   * 只在 `project-instructions` 适配器里发生，组合根不直接读盘。
   *
   * 它同时是 `read_file` 局部规则附段的唯一依据：`localRulesFor` 用同一份来源
   * 清单跳过已经进过请求的根规则，所以「模型已经知道的规则」与「每次读取重复
   * 粘贴的规则」不可能是两个答案（WP §3.1）。
   */
  readonly projectContext?: ProjectContext;
  /**
   * WP14：按轮冻结的已安装技能目录。Absent —— 工作区与用户层都没有发现技能
   * —— 工具表与从前逐字相同（R1）。每轮由 `run-one-turn` 重建，卸载的技能
   * 从下一轮起不再被构造，也不再有可注入的内容。
   */
  readonly skills?: SkillCatalogPort;
};

/**
 * What a run adopted from the project it is running in.
 *
 * `messages` are canonical `Message`s headed for the request's seed position.
 * `sources` is the audit trail: relative path, scope and content hash for each
 * rule actually adopted, so a run can be asked "which rules did you use" and
 * answer with facts. `problems` names files that exist but were not usable.
 */
export type ProjectContext = {
  readonly messages: ReadonlyArray<Message>;
  readonly sources: ReadonlyArray<ProjectInstructionSource>;
  readonly problems: ReadonlyArray<string>;
};

/** The one fact a session record needs about a rule: which file, which hash. */
export type ProjectInstructionSource = LocalRuleSource;

/**
 * What the host needs to open the MCP servers a run may use.
 *
 * It carries the registry *port*, not the two file paths: where a registry
 * lives is the management plane's decision (`mcp-wiring.ts`), and a run that
 * spelled the paths out again could disagree with `trylo mcp add` about which
 * file it was reading.
 *
 * The client seam exists for tests, which need a server without a child
 * process. Production passes nothing.
 */
export type McpRuntimeContext = {
  readonly registry: McpRegistryPort;
  readonly cwd: string;
  readonly clientFor?: (entry: McpServerEntry, cwd: string) => McpClientOpen;
};


export type TurnFailure = RunFailure;

// Re-exported: these are pure, live in `host-status.ts` now, and the host is
// still the one public place consumers read them from.
export { exitCodeForResult, terminalStatusOf, usageToCli, isTurnFailure } from "./host-status.js";

/**
 * One turn, with the MCP servers this run was configured to use opened for its
 * duration and closed after it.
 *
 * Opening lives here rather than in `wirePorts` for one reason: it is async and
 * may take a real handshake, and a composition root that could block on a child
 * process is a CLI that can hang before it prints anything. Closing in a
 * `finally` is what keeps a failed turn from leaving child processes behind.
 */
export async function executeTurn(input: TurnHostInput): Promise<TurnOutcome | TurnFailure> {
  const mcp = input.mcp === undefined ? undefined : await openMcpRuntime(input.mcp);
  try {
    return await runTurnWithPorts(input, mcp);
  } catch (error) {
    return await hostFailure(error, input.session);
  } finally {
    await mcp?.close();
  }
}

/** The turn itself, with the MCP table already opened — or deliberately absent. */
async function runTurnWithPorts(
  input: TurnHostInput,
  mcp: McpRuntime | undefined,
): Promise<TurnOutcome | TurnFailure> {
  const userLearning = input.userLearning === undefined ? undefined : createUserLearningRuntimeFor(input.userLearning);
  // The explicit-memory endpoint and the read source are built together: they
  // must agree about which facts exist, and the write half exists only when the
  // switch does. See `memory-wiring.ts` for why they cannot be built apart.
  const memory = memoryForTurnInput(input);
  const toolGap = input.toolGap === undefined ? undefined : createToolGapRuntimeFor(input.toolGap);
  // The observer shares this turn's learning runtime across all envelopes.
  const observe = userLearning === undefined ? undefined : userLearningObserver(userLearning);

  const recorder = createTurnRecorder(input);
  const recordedInput = recorder === undefined ? input : { ...input, session: recorder.session };
  const subagentSink = createSubagentJournalSink(recordedInput);
  const wiring = fileCommandWiring(memoryCommandWiring(wirePorts(
    turnWiringInput(
      input,
      mcp,
      userLearning,
      toolGap,
      subagentSink.onEvent,
      // Per turn, by construction: `wirePorts` runs once per turn, so this
      // lookup's freeze lasts exactly this turn and the next turn re-reads the
      // current rule files. Nothing wider than a turn is constructed here.
      localRulesFor(input.workspaceRoot, input.projectContext, problem => input.sink.stderr(`${problem}\n`), input.resumeRecords),
      // Memory shares this turn's learning switch and project rules. Without
      // either, no memory port is constructed (WP20.3 / R1).
      memory.read,
      memory.write,
    ),
  ), input), input);
  if ("code" in wiring) {
    return wiringFailure(wiring.detail);
  }
  try {
    const refusal = await turnStartRefusal(wiring.ports.tools, input.toolSelection, wiring.permissionLedger, input.permissionLedger);
    if (refusal !== undefined) {
      return refusal;
    }
    if (input.text.trim() === "/compact") return await executeCompaction(input, wiring);

    const startedAt = input.now();
    const bootstrapContext = bootstrapContextFor(input);
    await recorder?.start({ startedAt, toolCatalogHash: wiring.toolCatalogHash,
      ...(input.bootstrap?.state !== "import_pending" || bootstrapContext === undefined ? {} : { bootstrapContext }),
      ...(input.userSourceAvailable === undefined ? {} : { userSourceAvailable: input.userSourceAvailable }),
      ...(wiring.ports.provider.continuation === undefined ? {} : { continuation: wiring.ports.provider.continuation }),
      ...(input.projectContext === undefined ? {} : { sources: input.projectContext.sources }),
    });
    const budget = budgetOf(input);
    // The renderer is opened before the turn, not after it. Every envelope the
    // turn emits is translated and rendered as it happens, so the person watching
    // reads the answer while it is being written rather than once it is over
    // (WP D1/D2). It is the same translator the end-of-run projection uses, so a
    // scripted consumer sees the same sequence — only earlier.
    reportProjectNotices(input);

    const renderer = createTurnRenderer(input.format, input.sink, {
      ...(input.contextTokenLimit === undefined ? {} : { contextWindow: input.contextTokenLimit }),
      sessionId: input.sessionId,
      turnId: input.turnId,
      providerId: wiring.providerId,
      model: wiring.model,
    });
    subagentSink.setRenderer(renderer);
    if (wiring.subagentRuntime !== undefined) input.bindAgentTools?.(wiring.ports.tools);

    const result = await runRecordedTurn(
      recorder === undefined ? wiring.ports : { ...wiring.ports, progress: recorder.progress },
      input, budget,
      pricingOf(input),
      observe === undefined && input.onRunEnvelope === undefined
        ? renderer.onEnvelope
        : envelope => {
            renderer.onEnvelope(envelope);
            observe?.(envelope);
            input.onRunEnvelope?.(envelope);
          },
    );

    await finishSubagentEvents(wiring.subagentRuntime, subagentSink);
    return await finishTurn({
      result,
      renderer,
      input: { ...recordedInput, toolCatalogHash: wiring.toolCatalogHash },
      ...(recorder === undefined ? {} : { recorder }),
      startedAt,
      providerId: wiring.providerId,
      model: wiring.model,
      extraWarnings: mcp?.warnings ?? [],
    });
  } finally {
    input.bindAgentTools?.(undefined);
    await wiring.close();
  }
}
