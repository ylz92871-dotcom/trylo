import type { BootstrapContextBinding } from "./bootstrap-context.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import type { ProviderPort, SystemPromptDirective, ReasoningEffort } from "../../ports/provider.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import type { WebToolsConfig } from "../../adapters/tools/web/index.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { PermissionPort } from "../../ports/permission.js";
import type { ExecPolicyGuard } from "../../loop/tool-admission.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import type { PermissionGrantCache } from "../../loop/permission-grants.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { CompactSummaryMode, OutputFormat } from "./args.js";
import type { MethodLearningHost } from "./learning-sink.js";
import type { UserLearningHost } from "./user-learning-config.js";
import type { ToolLearningHost } from "./tool-learning-config.js";
import type { CliSink } from "./render.js";
import type { SubagentRole } from "../../subagent/role.js";
import type { LspServerConfig } from "../../adapters/language-server/registry.js";
import type { ShellModeResult } from "../../adapters/sandbox/shell-mode.js";
import type { FileAccessMode } from "../../ports/filesystem.js";
import type { CheckLearningHost } from "./check-learning-wiring.js";
import type { Wiring } from "./wiring.js";
import type { RunExecution } from "./run-execution-wiring.js";
import type { AskUserSession } from "../../adapters/tools/ask-user/index.js";
import type { TopicLearningConfiguration } from "../../integration/learning-topics/system.js";
import type { ReadTopicPoolConfiguration } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import type { TopicSemanticEvidenceProjector } from "../../integration/learning-topics/evidence.js";
import type { TopicExperimentBindingSource } from "../../integration/learning-topics/experiment-binding.js";
import type { ToolPromptContext } from "./turn-tool-context.js";
import type { Message } from "../../contract/execution.js";
import type { LocalRuleSource } from "../../adapters/project-instructions/appendix.js";
import type { McpClientOpen } from "../../adapters/mcp-runtime/factory.js";
import type { McpRegistryPort, McpServerEntry } from "../../ports/mcp-registry.js";

/** Adopted canonical project messages and their original source audit trail. */
export type ProjectContext = {
  readonly messages: ReadonlyArray<Message>;
  readonly sources: ReadonlyArray<ProjectInstructionSource>;
  readonly problems: ReadonlyArray<string>;
};

export type ProjectInstructionSource = LocalRuleSource;

/** MCP startup inputs retain the existing registry and client port owners. */
export type McpRuntimeContext = {
  readonly progressive?: { readonly root: string; readonly scope: string; readonly policy: string };
  readonly registry: McpRegistryPort;
  readonly cwd: string;
  readonly clientFor?: (entry: McpServerEntry, cwd: string) => McpClientOpen;
};

/** Shared run/REPL/stdio host: execution ports, durable session and projection
 * meet here; surfaces do not own separate loops. */

export type TurnHostInput = {
  /** Captured once at normal parent entry; never inferred from a later successful request. */
  readonly providerWaitObservation?: import("../../learning/central/runtime/provider-positive.js").ProviderWaitObservation;
  readonly centralLearning?: import("./central-learning-turn.js").CentralLearningTurnFactory;
  /** Explicit host experiment/model bindings; absence uses the existing bounded read configuration. */
  readonly topicLearning?: TopicLearningConfiguration;
  /** Central configuration for the default tool experiment; preserves its real offer/bind wiring. No migration is implicit. */
  readonly readTopicPool?: ReadTopicPoolConfiguration;
  /** Already collection-admitted, redacted user/checker facts, bound to their actual envelope by the runtime. */
  readonly topicEvidence?: TopicSemanticEvidenceProjector;
  /** Existing local semantic resolutions; supplying these preserves the default read experiment wiring. */
  readonly topicBindings?: TopicExperimentBindingSource;
  readonly subagentRouting?: import("../../ports/subagent-routing.js").SubagentRoutingPort;
  readonly checkLearning?: CheckLearningHost;
  readonly collaborationLearning?: { readonly choice?: import("./collaboration-options.js").CollaborationLearningOption | undefined;
    readonly legacyMethodScope?: string;
    readonly skillLearning?: NonNullable<import("./collaboration-personal-agent-wiring.js").PersonalAgentWiringInput["skillLearning"]>;
    readonly focusedLearning?: NonNullable<import("./collaboration-personal-agent-wiring.js").PersonalAgentWiringInput["focusedLearning"]>;
    readonly homeDir: string; readonly env: Readonly<Record<string, string | undefined>> };
  readonly goal?: import("../../ports/goal.js").GoalExecutionPort;
  readonly additionalTools?: Wiring["ports"]["tools"];
  /** Original pending proposals are offered only to the normal parent PA. */
  readonly skillPending?: ReturnType<typeof import("../../learning/agent/subsystems/skill/host/pending-review.js").createSkillPendingReview>;
  readonly bindAgentTools?: (tools: Wiring["ports"]["tools"] | undefined) => void;
  /** Mounted-tool context only; cannot alter the table, permissions or execution policy. */
  readonly toolPromptContext?: ToolPromptContext;
  readonly bootstrap?: BootstrapContextBinding;
  readonly userSourceAvailable?: false;
  readonly toolSelection?: readonly string[];
  readonly configuredToolSelection?: readonly string[];
  readonly toolSelectionCeiling?: readonly string[];
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
  readonly onCommittedEnvelope?: (envelope: Envelope) => void;
  readonly onCommittedEffect?: (key: string, outcome: "succeeded" | "failed" | "unknown" | "cancelled") => void;
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
  /** Runtime-owned metering around the resolved provider; never a permission grant. */
  readonly providerGuard?: (provider: ProviderPort) => ProviderPort;
  /** An explicitly funded/experimental stream may forbid internal HTTP retries. */
  readonly requestAttemptPolicy?: "single_request";
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
  readonly subagentModelMigration?: string;
  /** Roles discovered for this turn (C44/L27). Absent means none offered. */
  readonly subagentRoles?: ReadonlyArray<SubagentRole>;
  readonly subagentTeam?: import("../../subagent/team.js").SubagentTeam;
  /** Trusted host observes actual acknowledged child requests; only its safe payloads are journaled. */
  readonly onChildRequestDispatched?: import("../../subagent/request-dispatched.js").ChildRequestObservation;
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
   * `--compact-summary`：谁给 compaction 写摘要。Absent 由 wiring.ts 选择 model；
   * 显式 extractive 保留纯摘录，模型失败回退摘录。
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
