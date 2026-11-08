import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { SystemPromptDirective, ReasoningEffort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolPort } from "../../ports/tools.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { CompactSummaryMode, LearningSwitch, OutputFormat, RunCommandOptions } from "./args.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import type { SessionPermissions } from "./session-permissions.js";
import type { ProjectContext } from "./host.js";
import type { RunExecution } from "./run-execution-wiring.js";
import type { AskUserSession } from "../../adapters/tools/ask-user/index.js";
import type { WebToolsConfig } from "../../adapters/tools/web/index.js";

/** Shared run preparation contract. Execution and session lifecycle remain with their original owners. */
export type RunScaffold = {
  /** An explicit source-specific UI request cannot redirect its work to another saved focus. */
  readonly centralLearningOnlyIssueId?: string;
  readonly onCentralLearningResult?: (result: import("../../integration/central-learning/host.js").CentralLearningRunResult) => void;
  readonly centralLearningContextForIssue?: import("../../learning/control/source-context.js").CentralLearningContextReader;
  readonly centralLearning?: import("./central-learning-options.js").CentralLearningOption;
  readonly centralLearningThoughtMaxTokens?: number;
  readonly centralRuntimePolicy?: import("./central-runtime-control.js").CentralRuntimePolicy;
  readonly onCommittedEnvelope?: (envelope: import("../../protocol/envelope.js").Envelope) => void;
  readonly onCommittedEffect?: (key: string, outcome: "succeeded" | "failed" | "unknown" | "cancelled") => void;
  readonly collaborationLearning?: import("./collaboration-options.js").CollaborationLearningOption;
  readonly workflowFocusedLearning?: import("../../learning/control/focused-learning-port.js").FocusedLearningPort;
  readonly workflowCentralExecution?: import("../../integration/central-learning/contracts.js").CentralLearningExecutionPort;
  readonly workflowLearning?: boolean;
  readonly workflowLearningBudget?: number;
  readonly workflowLearningBudgetId?: string;
  readonly goal?: import("../../ports/goal.js").GoalExecutionPort & { readonly turnId: string };
  readonly additionalTools?: ToolPort;
  readonly bindAgentTools?: (tools: import("../../ports/tools.js").ToolPort | undefined) => void;
  readonly questions?: AskUserSession;
  readonly execution?: RunExecution;
  /** Shared across turns; UI changes policy through this application controller. */
  readonly permissions?: SessionPermissions;

  /** The selected id: a shipped one, or one declared in `providers.json`. */
  readonly providerId: string;
  /** The adapter family. It is what the provider is actually built from. */
  readonly providerKind: ProviderKind;
  /** Responses summary opt-in derived from the selected provider's declaration. */
  readonly reasoningSummary?: "auto";
  readonly reasoningEffort?: ReasoningEffort;
  readonly model: string;
  readonly endpoint: string;
  readonly format: OutputFormat;
  /** The credential `CredentialPort` resolved, when one did. Never logged. */
  readonly apiKey: string | undefined;
  readonly tokenManager?: TokenManagerLike | undefined;
  readonly accountId?: string | undefined;

  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly workspaceIdentity?: import("./central-runtime-workspace-identity.js").CentralRuntimeWorkspaceIdentity;
  /** Where undo lives: outside the workspace, so a snapshot never holds itself. */
  readonly checkpointRoot: string;

  readonly sessionId: string;
  readonly session?: SessionPort;
  readonly resumeTranscript?: Transcript;
  /** The window a resumed journal projects under, so the model sees the short past. */
  readonly resumeView?: CompactWindow;
  /** The journal a resume was loaded from, so a compaction projects over it. */
  readonly resumeRecords?: ReadonlyArray<SessionRecord>;

  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly toolSelection?: readonly string[];
  readonly configuredToolSelection?: readonly string[];
  /** Explicit argv ceiling; a persisted selection can never expand it in this invocation. */
  readonly toolSelectionCeiling?: readonly string[];

  /**
   * Caller system prompt for every request this run builds (WP18.3: legacy
   * L67 replace/append). Absent — every run that never passed the flags —
   * means the seeds are exactly the ones the un-wired path assembles.
   */
  readonly systemPrompt?: SystemPromptDirective;
  /** Text appended as a system message after the seeds; applied after `systemPrompt`. */
  readonly systemPromptAppend?: string;
  /**
   * JSON Schema the final answer must satisfy (WP18.3: C74). Sent as the
   * wire's own `response_format`; absent means the provider decides.
   */
  readonly responseSchema?: JsonObject;
  /**
   * Model a non-interactive run retries once on after a transient provider
   * failure (WP18.2: L05). Absent means the transient failure is the turn's
   * failure. Validated to differ from the primary model.
   */
  readonly fallbackModel?: string;
  /** The context ceiling, carried through to the run's budget and compaction. */
  readonly contextTokenLimit?: number;
  /** The dollar ceiling and the pricing pair that makes it enforceable (L07). */
  readonly maxBudgetUsd?: number;
  readonly inputPricePerMTok?: number;
  readonly outputPricePerMTok?: number;

  /** `--learning`; absent means the method subsystem is never constructed. */
  readonly learning?: LearningSwitch;
  readonly skillLearningAllowance?: import("../../learning/control/coordination-contract.js").CentralLearningAllowance;
  readonly checkLearning?: true;
  readonly checkLearningBudget?: number;
  /** Path to the language-server file (WP12 L60); absent means no `lsp_navigate`. */
  readonly lspConfigFile?: string;
  /** The `shell` setting, unresolved (WP05 C06/C07); absent means the direct path. */
  readonly shell?: string;
  readonly fileAccess?: RunCommandOptions["fileAccess"];
  readonly shellIsolation?: RunCommandOptions["shellIsolation"];
  /**
   * `--permission-ledger`; absent means no durable Permission ledger is opened
   * and the run is byte-identical to one that never heard of it.
   */
  readonly permissionLedger?: { readonly path: string };
  /** `--subagent`; absent means the subagent runtime is never constructed. */
  readonly subagentEnabled?: true;
  /** Explicit provider+model resume migration; ordinary member execution uses this model. */
  readonly subagentModelMigration?: string;
  /** `--allow-web`; absent means the web tool port is never constructed. */
  readonly allowWeb?: true;
  /**
   * 网络工具的后端（WP20）。Absent —— 与 `allowWeb` 缺席同一批 —— 意味着
   * `web_fetch` 只有出厂能力，且没有 `web_search`（R1）。
   */
  readonly web?: WebToolsConfig;
  /** `--compact-summary`; omission preserves the composition-owned model default. */
  readonly compactSummary?: CompactSummaryMode;
  /** Releases the session lock. Safe to call more than once. */
  readonly close: () => Promise<void>;
  /**
   * Initial context; runOneTurn reloads it at the turn boundary.
   *
   * Resolved through the same adapter so `trylo run`, the REPL and the TUI all
   * answer "which rules is this run using" identically (WP-CLI-B1 §3.3). Absent
   * only when the project has no rule file at all, in which case there is nothing
   * to carry and the field stays absent rather than becoming an empty list.
   */
  readonly projectContext?: ProjectContext;
  /**
   * The warm layer, when the surface runs more than one turn. Absent on
   * `trylo run`, which has nothing to reuse; present on the REPL and the TUI,
   * where it is what makes the second turn warm instead of cold.
   */
  readonly warm?: WarmRegistry;
  readonly warnings: ReadonlyArray<string>;
};
