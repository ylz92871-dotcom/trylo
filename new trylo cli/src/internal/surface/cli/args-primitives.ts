/**
 * The command-line vocabulary: what a parsed command *is*.
 *
 * Split out of `args.ts` (WP §4: the entry file stays under 400 lines and the
 * families split along their own seams). This module owns shapes and closed
 * sets only — no parsing of a specific family, no IO, no `process`. Token
 * reading lives in `args-tokens.ts`. The family parsers in `args-run.ts` /
 * `args-auth.ts` / `args-mcp.ts` and the dispatcher in `args.ts` all import
 * from here, so the dependency graph is a tree, never a cycle.
 */

import type { CompletionShell } from "./completion.js";
import type { RunCommandOptions } from "./args-run-types.js";

export type { RunCommandOptions } from "./args-run-types.js";

import type { FamilyWord } from "./command-vocabulary.js";

export type { ResolvedRequestOptions } from "./args-request-types.js";

import type { McpAddCommandOptions, McpTargetOptions } from "./args-mcp.js";
import type { CheckpointListOptions, CheckpointRestoreOptions } from "./args-checkpoint.js";
import type { CheckpointDiffOptions } from "./args-checkpoint.js";
import type { QueueAddOptions, QueueDropOptions, QueueListOptions } from "./args-queue.js";
import type { SessionReconcileOptions } from "./args-session.js";
import type {
  SessionArchiveOptions,
  SessionExportOptions,
  SessionForkOptions,
  SessionRenameOptions,
  SessionTargetOptions,
} from "./args-session.js";
import type {
  ProvidersAddOptions,
  ProvidersConfigOptions,
  ProvidersEditOptions,
  ProvidersListOptions,
  ProvidersModelsOptions,
  ProvidersRemoveOptions,
  ProvidersSwitchOptions,
} from "./args-providers.js";
import type { DiffCommandOptions, ReviewCommandOptions, SessionReviewOptions } from "./args-review.js";
import type { UpdateOptions } from "./args-update.js";
import type { OutputStyleListOptions, OutputStyleShowOptions } from "./args-output-style.js";
import type { MemoryDeleteOptions, MemoryImportOptions } from "./args-memory.js";
import type { WorkflowListOptions, WorkflowRunOptions, WorkflowShowOptions } from "./args-workflow.js";
import type { ContextOptions } from "./args-context.js";
import {
  isLearningSwitch,
  LEARNING_SWITCH_VALUES,
  type LearningSwitch,
} from "../../integration/user-learning/switch.js";

// Re-exported so `args.ts` stays the single public entry point for the command
// vocabulary. Both are type-only, so this adds no runtime edge back to
// `args-mcp.js` and the family parsers stay acyclic at runtime.
export type {
  CheckpointListOptions,
  CheckpointRestoreOptions,
  CheckpointDiffOptions,
  CompletionShell,
  QueueAddOptions,
  QueueListOptions,
  QueueDropOptions,
  SessionReconcileOptions,
  SessionForkOptions,
  SessionRenameOptions,
  SessionExportOptions,
  SessionArchiveOptions,
  SessionReviewOptions,
  SessionTargetOptions,
  McpAddCommandOptions,
  McpTargetOptions,
  ProvidersConfigOptions,
  ProvidersListOptions,
  ProvidersModelsOptions,
  ProvidersRemoveOptions,
  ProvidersEditOptions,
  ProvidersSwitchOptions,
  DiffCommandOptions,
  ReviewCommandOptions,
  UpdateOptions,
  OutputStyleListOptions,
  OutputStyleShowOptions,
  MemoryImportOptions,
  MemoryDeleteOptions,
  WorkflowListOptions,
  WorkflowShowOptions,
  WorkflowRunOptions,
  ContextOptions,
};

/**
 * `fixture-write` is the same offline provider with a mutating script: it writes
 * a file and then reads it back, so the demo cannot succeed unless the write
 * really landed. It is a second id rather than a second mode so that what a run
 * does is visible in the command that started it.
 *
 * `openai-responses` (WP18.2) is declarable but ships no built-in entry: it
 * names the Responses wire for a declared endpoint, and the drift guard in
 * `providers-wiring.test.ts` keeps this list and `PROVIDER_KINDS` in step.
 */
export const PROVIDER_IDS = [
  "fixture",
  "fixture-write",
  "fixture-subagent",
  "openai-compatible",
  "openai-responses",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const OUTPUT_FORMATS = ["text", "stream-json"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * `--learning` 的取值：**总开关闭集**（WP §8-1 的待拍默认）。
 *
 * 判据与枚举文本都由 `integration/user-learning/switch.ts` 给出，这里只借出来用，
 * 不复制字面量：复制一份就等于给了「拼错的值静默变成另一种行为」第二个发生的地方，
 * 而开关的全部意义是「我明确要它」。
 */
export type { LearningSwitch };

export { isLearningSwitch, LEARNING_SWITCH_VALUES };

/** Closed set for `session export --format`: the transcript as data, or as readable text. */
export const SESSION_EXPORT_FORMATS = ["json", "markdown"] as const;

export type SessionExportFormat = (typeof SESSION_EXPORT_FORMATS)[number];

export function isSessionExportFormat(value: string): value is SessionExportFormat {
  return (SESSION_EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Closed set for `run --migrate`: which fingerprint drift a resume may accept. */
export const MIGRATION_SCOPES = ["provider", "model", "catalog"] as const;

export type { MigrationScope } from "../../adapters/session-store/session-meta.js";

import type { MigrationScope } from "../../adapters/session-store/session-meta.js";

export function isMigrationScopeName(value: string): value is MigrationScope {
  return (MIGRATION_SCOPES as readonly string[]).includes(value);
}

/**
 * Providers the credential commands accept. Deliberately *not* `PROVIDER_IDS`:
 * `fixture-write` is a scripted demo, not an account a ledger can hold, so the
 * auth family validates against the port's closed set instead.
 */
import type { CredentialProviderId } from "../../ports/credentials.js";

export { CREDENTIAL_PROVIDER_IDS, isCredentialProviderId } from "../../ports/credentials.js";
export type { CredentialProviderId };

export type { AskPolicy } from "./permission-plan.js";
// The closed sets live with the semantics they belong to; re-exported here so
// the command vocabulary still has one entry point.
export { ASK_POLICIES, isAskPolicy } from "./permission-plan.js";

// `--compact-summary` 的闭集住在它的写手旁边（`compact-model-summarizer.ts`），
// 与 ask/learning 同一形态：枚举与判据只有一份，解析处借出来用。
export { COMPACT_SUMMARY_MODES, isCompactSummaryMode } from "./compact-model-summarizer.js";

import type { CompactSummaryMode } from "./compact-model-summarizer.js";

export type { CompactSummaryMode };



/** Shared shape of the credential commands that can target the project ledger. */
export type AuthScopeOptions = {
  /** Absent means the user ledger, which is the default everywhere. */
  readonly project?: boolean;
};

export type LoginCommandOptions = AuthScopeOptions & {
  readonly provider: CredentialProviderId;
  readonly account?: string;
  readonly label?: string;
  /**
   * Path to a file holding the secret. Absent means: ask on the tty, and fail
   * explicitly when there is no tty. A secret on the command line is refused.
   */
  readonly secretFile?: string;
  readonly oauth?: boolean;
  /**
   * RFC 8628 device grant (WP18.1: C69/L69): the code is shown here and
   * authorized on another device. Mutually exclusive with `oauth`.
   */
  readonly device?: boolean;
};

export type LogoutCommandOptions = AuthScopeOptions & {
  readonly provider: CredentialProviderId;
};

export type AuthSwitchOptions = AuthScopeOptions & {
  readonly provider: CredentialProviderId;
  readonly account: string;
};

/** Same shape as a switch: delete names the record to remove. Kept distinct so a future --force cannot leak across. */
export type AuthDeleteOptions = AuthSwitchOptions;

export type ParsedCommand =
  | { readonly kind: "library"; readonly options: import("./args-library.js").LibraryCommandOptions }
  | { readonly kind: "learn"; readonly options: import("./args-learn.js").LearnOptions }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly options: RunCommandOptions }
  | { readonly kind: "doctor"; readonly json: boolean; readonly learning?: LearningSwitch }
  | { readonly kind: "config_show"; readonly json: boolean }
  | { readonly kind: "session_list"; readonly json: boolean; readonly search?: string; readonly all: boolean }
  | { readonly kind: "session_reconcile"; readonly options: SessionReconcileOptions }
  | { readonly kind: "session_info"; readonly options: SessionTargetOptions }
  | { readonly kind: "session_fork"; readonly options: SessionForkOptions }
  | { readonly kind: "session_rename"; readonly options: SessionRenameOptions }
  | { readonly kind: "session_export"; readonly options: SessionExportOptions }
  | { readonly kind: "session_archive"; readonly options: SessionArchiveOptions }
  | { readonly kind: "session_remove"; readonly options: SessionTargetOptions }
  /** A family verb (`schedule` / `daemon` / `bg`): the root recognises the word, the family parses `args`. */
  | { readonly kind: "family"; readonly word: FamilyWord; readonly args: ReadonlyArray<string> }
  | { readonly kind: "repl"; readonly learning?: LearningSwitch;
      readonly learningOptions?: import("./session-learning-options.js").SessionLearningOptions }
  | { readonly kind: "completion"; readonly shell: CompletionShell }
  | { readonly kind: "update"; readonly options: UpdateOptions }
  | { readonly kind: "output_style_list"; readonly options: OutputStyleListOptions }
  | { readonly kind: "output_style_show"; readonly options: OutputStyleShowOptions }
  | { readonly kind: "memory_import"; readonly options: MemoryImportOptions }
  | { readonly kind: "memory_list"; readonly options: { readonly json: boolean } }
  | { readonly kind: "memory_compact"; readonly options: { readonly json: boolean } }
  | { readonly kind: "memory_delete"; readonly options: MemoryDeleteOptions }
  | { readonly kind: "memory_mutate"; readonly action: "correct" | "retract" }
  | { readonly kind: "workflow_list"; readonly options: WorkflowListOptions }
  | { readonly kind: "workflow_show"; readonly options: WorkflowShowOptions }
  | { readonly kind: "workflow_run"; readonly options: WorkflowRunOptions }
  | { readonly kind: "workflow_learning"; readonly args: readonly string[] }
  | { readonly kind: "context"; readonly options: ContextOptions }
  | { readonly kind: "mcp_add"; readonly options: McpAddCommandOptions }
  | { readonly kind: "mcp_list"; readonly json: boolean }
  | { readonly kind: "mcp_status"; readonly json: boolean }
  | { readonly kind: "mcp_remove"; readonly options: McpTargetOptions }
  | { readonly kind: "mcp_set_enabled"; readonly options: McpTargetOptions; readonly enabled: boolean }
  | { readonly kind: "checkpoint_list"; readonly options: CheckpointListOptions }
  | { readonly kind: "checkpoint_restore"; readonly options: CheckpointRestoreOptions }
  | { readonly kind: "checkpoint_diff"; readonly options: CheckpointDiffOptions }
  | { readonly kind: "queue_add"; readonly options: QueueAddOptions }
  | { readonly kind: "queue_list"; readonly options: QueueListOptions }
  | { readonly kind: "queue_drop"; readonly options: QueueDropOptions }
  | { readonly kind: "session_review"; readonly options: SessionReviewOptions }
  | { readonly kind: "diff"; readonly options: DiffCommandOptions }
  | { readonly kind: "review"; readonly options: ReviewCommandOptions }
  | { readonly kind: "providers_list"; readonly json: boolean }
  | { readonly kind: "providers_models"; readonly options: ProvidersModelsOptions }
  | { readonly kind: "providers_switch"; readonly options: ProvidersSwitchOptions }
  | { readonly kind: "providers_config"; readonly options: ProvidersConfigOptions }
  | { readonly kind: "providers_add"; readonly options: ProvidersAddOptions }
  | { readonly kind: "providers_remove"; readonly options: ProvidersRemoveOptions }
  | { readonly kind: "providers_edit"; readonly options: ProvidersEditOptions }
  | { readonly kind: "login"; readonly options: LoginCommandOptions }
  | { readonly kind: "logout"; readonly options: LogoutCommandOptions }
  | { readonly kind: "auth_status"; readonly json: boolean }
  | { readonly kind: "auth_list"; readonly json: boolean; readonly project: boolean }
  | { readonly kind: "auth_switch"; readonly options: AuthSwitchOptions }
  | { readonly kind: "auth_delete"; readonly options: AuthDeleteOptions }
  | { readonly kind: "family_help"; readonly options: { readonly family: string } }
  | { readonly kind: "error"; readonly message: string; readonly hint: string };
