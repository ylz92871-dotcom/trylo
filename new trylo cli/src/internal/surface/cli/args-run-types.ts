/** Canonical parsed run options. Runtime vocabulary and parsing remain with their original owners. */
import type { RunExecutionOptions } from "./args-execution-types.js";
import type { PermissionChoice } from "./permission-plan.js";
import type { ReasoningEffort } from "../../ports/provider.js";
import type { LearningSwitch } from "../../integration/user-learning/switch.js";
import type { CompactSummaryMode } from "./compact-model-summarizer.js";
import type { OutputFormat } from "./args-primitives.js";

export type RunCommandOptions = PermissionChoice & RunExecutionOptions & {
  readonly centralLearning?: import("./central-learning-options.js").CentralLearningOption;
  /** Optional total-model token ceiling for one central thought; never changes the cumulative pool. */
  readonly centralLearningThoughtMaxTokens?: number;
  readonly centralRuntimePolicy?: import("./central-runtime-control.js").CentralRuntimePolicy;
  readonly workflowVersion?: string;
  readonly workflowTask?: string;
  readonly workflowLearning?: boolean;
  readonly workflowLearningBudget?: number;
  /** Host-owned identity retained across interactive session replacements; never parsed from model/user JSON. */
  readonly workflowLearningBudgetId?: string;
  readonly workflowRefillTokens?: number;
  readonly workflowBudgetGrant?: string;
  readonly workflowCollection?: "enabled" | "disabled";
  readonly reasoningEffort?: ReasoningEffort;
  /** Opt-in JSONL user/control input; stdin stays open until this turn ends. */
  readonly permissionPromptTool?: "stdio";  /**
   * Absent when not passed, so a config layer can still supply it. Any string
   * is allowed here: a shipped id or one `providers add` declared — which id is
   * real is decided against the profile at runtime, never by this type.
   */
  readonly provider?: string;
  readonly format?: OutputFormat;
  readonly message: ReadonlyArray<string>;
  /** `-` or a piped stdin was requested: read the remaining prompt from stdin. */
  readonly readStdin: boolean;
  readonly model?: string;
  /** Provider endpoint. Lets a gateway be pointed at without editing config. */
  readonly endpoint?: string;
  readonly session?: string;
  readonly resume?: string;
  /**
   * `--last`: continue the newest non-archived session instead of naming one.
   * Presence-only, and refused together with `--session`/`--resume`: "the last
   * one" and "this specific one" cannot both decide.
   */
  readonly resumeLast?: boolean;
  /**
   * `--migrate provider,model,catalog`: explicitly accepted connection drift,
   * recorded in the session sidecar. Workspace identity never migrates.
   * Provider+model migration also moves ordinary team execution to that model;
   * frozen roles, instructions, permissions and cumulative costs remain intact.
   */
  readonly migrateModel?: boolean;
  readonly migrateProvider?: boolean;
  readonly migrateCatalog?: boolean;
  readonly outputLastMessage?: string;
  /**
   * `--output-schema <file>`: JSON Schema file the final answer must satisfy
   * (WP18.3: C74, Codex `exec --output-schema`). A path here, resolved by
   * `prepareRun`; absent means the provider decides its own shape.
   */
  readonly outputSchema?: string;
  /** `--output-style <name>` (WP24.2/L48): absent is the built-in default; present appends the style prompt after the seeds, never touching permissions/tools/budgets. */
  readonly outputStyle?: string;
  /**
   * Caller system prompt, legacy L67 quartet: `--system-prompt` /
   * `--system-prompt-file` replace the assembled seeds, `--append-system-prompt` /
   * `--append-system-prompt-file` add to them. Raw values only; mutual
   * exclusion is refused at parse time, files are read by `prepareRun`.
   */
  readonly systemPrompt?: string;
  readonly systemPromptFile?: string;
  readonly appendSystemPrompt?: string;
  readonly appendSystemPromptFile?: string;
  /**
   * `--fallback-model <model>`: the model a non-interactive run retries once
   * on after a transient provider failure (WP18.2: L05, legacy `query.ts`
   * fallback). Absent means the transient failure is the turn's failure.
   */
  readonly fallbackModel?: string;
  /**
   * Resolved carriers for `connection-switch`: the scaffold's already-resolved
   * directive/schema survive a mid-session connection change without re-reading
   * files. Parsing never sets this; only the switch does, and `prepareRun`
   * prefers it over the raw flag paths.
   */
  readonly resolvedRequest?: import("./args-request-types.js").ResolvedRequestOptions;
  readonly workspace?: string;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly contextTokenLimit?: number;
  readonly modelContextWindow?: number;
  /**
   * The dollar ceiling for this run (WP09.3/L07). A positive number of US
   * dollars: the usage the run accumulates is priced by the configured pricing
   * pair, and reaching this ceiling ends the run with an explicit
   * `budget_usd_exhausted` instead of a silently larger bill.
   */
  readonly maxBudgetUsd?: number;
  /** Exact mounted tool catalog for this run; does not grant permission. */
  readonly toolSelection?: ReadonlyArray<string>;
  /**
   * The `--learning` switch. Absent — which is every default path — means no
   * learning subsystem is constructed at all: no board, no `load()`, no
   * directory, no ledger. It is a **total** switch over a closed set
   * (`method` / `user` / `all`): one entry point, each subsystem takes its own
   * half. Anything outside the set is a usage error rather than a silently
   * different behaviour.
   */
  readonly learning?: LearningSwitch;
  readonly skillLearningAllowance?: import("../../learning/control/coordination-contract.js").CentralLearningAllowance;
  readonly checkLearning?: true;
  readonly checkLearningBudget?: number;
  readonly collaborationLearning?: import("./collaboration-options.js").CollaborationLearningOption;
  /**
   * `--permission-ledger`：让这次运行由持久 Permission 账本背书。Absent —— 每一条
   * 默认路径 —— 意味着不开文件、不建目录，运行与「从未听说过账本」逐字相同。
   *
   * 刻意**没有 settings 键**：一个能把持久授权账本打开的配置文件，正是
   * `settings/schema.ts` 的闭集要挡住的「配置文件里偷渡 autoApprove」形态；仓库里
   * 每一个权限类开关（`--allow-writes` / `--ask` / `--allow-tools` / `--deny-tools`）
   * 也都只走命令行。
   */
  readonly permissionLedger?: boolean;
  /**
   * `--subagent`：把 `delegate_subagent` 挂进这次运行的工具表。Absent —— 每一条
   * 默认路径 —— 意味着子代理运行时根本不构造，运行与「从未听说过子代理」逐字
   * 相同（R1）。与权限类开关同一族：只走命令行，刻意没有 settings 键。
   */
  readonly subagent?: boolean;
  /**
   * `--allow-web`：把 `web_fetch` 挂进这次运行的工具表。Absent —— 每一条默认
   * 路径 —— 意味着 web 工具口根本不构造，catalog 哈希逐字不变（R1）。挂载只决
   * 定「看得见」；每一次抓取仍要过审批门（`--ask always` 或 `--allow-tools`），
   * 与 `--subagent` 同族：只走命令行，刻意没有 settings 键。
   */
  readonly allowWeb?: boolean;
  /**
   * `--compact-summary`：compaction 摘要由谁写。Absent 交给 composition 的 model
   * 默认；显式 extractive 不调用作者模型。失败回退摘录，触发、落盘、读时过滤不变。
   * 与 `--ask` 同族：闭集在解析处把关，只走命令行。
   */
  readonly compactSummary?: CompactSummaryMode;
};
