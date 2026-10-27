import path from "node:path";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { SystemPromptDirective, ReasoningEffort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { resolveRequestOptions } from "./run-request-options.js";
import type { SessionPort } from "../../ports/session.js";
import type { CompactWindow } from "../../ports/compaction.js";
import type { SessionRecord } from "../../ports/session.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { CompactSummaryMode, LearningSwitch, OutputFormat, RunCommandOptions } from "./args.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import { createWarmRegistry, type WarmRegistry } from "../../adapters/provider/warm.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { reasoningSummaryOptions } from "./provider-build.js";
import type { CliContext } from "./context.js";
import { permissionChoice } from "./permission-for-run.js";
import { createSessionPermissions, type SessionPermissions } from "./session-permissions.js";
import type { TurnOutcome } from "./host.js";
import type { ProjectContext } from "./host.js";
import { projectContextFor } from "./project-rules.js";
import { runOneTurn } from "./run-one-turn.js";
import type { CliSink } from "./render.js";
import { fail, reportFailure, type RunFailure } from "./run-failure.js";
import { fingerprint, openSession } from "./session-open.js";
import {
  FIXTURE_FIRST_RUN_GUIDANCE,
  runCredentialFor,
} from "./provider-selection.js";
import { permissionLedgerPath, tryloHome } from "./session-paths.js";
import { webBackendsFor } from "./web-wiring.js";
import type { WebToolsConfig } from "../../adapters/tools/web/index.js";
import { catalogHash, workspaceIdentity } from "./wiring.js";
import { effectiveContextCeiling } from "./run-context-ceiling.js";
import { compatibleCatalogHashes } from "./wiring-catalog.js";
import { resolveOutputStyleAppend } from "./output-style-resolve.js";
import { createRunExecution } from "./run-execution-wiring.js";
import type { RunExecution } from "./run-execution-wiring.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { closeRunResources } from "./run-resources.js";
import { createAskUserTools, type AskUserSession } from "../../adapters/tools/ask-user/index.js";
import { restoreQuestions } from "../../adapters/tools/ask-user/recovery.js";
import { answerQuestionInput } from "./question-input.js";
import { resolvePrompt } from "./run-prompt.js";
export { resolvePrompt } from "./run-prompt.js";
import { answerStdioInput, stdioQuestions } from "./stdio-questions.js";
import type { StdioSession } from "./stdio-session.js";

export type { RunFailure } from "./run-failure.js";
export { reportFailure } from "./run-failure.js";
export { effectiveContextCeiling };

/**
 * `runOneTurn` moved to `run-one-turn.ts`; re-exported because the REPL, the TUI
 * and the provider-warm tests have always reached it through this module.
 */
export { runOneTurn } from "./run-one-turn.js";

/**
 * `trylo run` preparation and execution.
 *
 * Preparation is separated from execution because the REPL needs the same
 * scaffolding without re-parsing arguments. Neither path builds a loop: both
 * hand the prepared facts to the one run host. Session lifecycle lives in
 * `session-open.ts` and settings resolution in `run-settings.ts`.
 */

export type RunScaffold = {
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
  /** Path to the language-server file (WP12 L60); absent means no `lsp_navigate`. */
  readonly lspConfigFile?: string;
  /** The `shell` setting, unresolved (WP05 C06/C07); absent means the direct path. */
  readonly shell?: string;
  readonly fileAccess?: RunCommandOptions["fileAccess"];
  /**
   * `--permission-ledger`; absent means no durable Permission ledger is opened
   * and the run is byte-identical to one that never heard of it.
   */
  readonly permissionLedger?: { readonly path: string };
  /** `--subagent`; absent means the subagent runtime is never constructed. */
  readonly subagentEnabled?: true;
  /** `--allow-web`; absent means the web tool port is never constructed. */
  readonly allowWeb?: true;
  /**
   * 网络工具的后端（WP20）。Absent —— 与 `allowWeb` 缺席同一批 —— 意味着
   * `web_fetch` 只有出厂能力，且没有 `web_search`（R1）。
   */
  readonly web?: WebToolsConfig;
  /** `--compact-summary`; absent means the shipped extractive summary author stays. */
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

export type PrepareInput = {
  readonly options: RunCommandOptions;
  readonly sink: CliSink;
  readonly permissionMode: "interactive" | "non_interactive";
};

export function isRunFailure(value: RunScaffold | RunFailure): value is RunFailure {
  return !("workspaceRoot" in value);
}

function resolveWorkspaceRoot(ctx: CliContext, requested: string | undefined): string | RunFailure {
  const root = requested === undefined ? ctx.cwd : path.resolve(ctx.cwd, requested);
  if (!ctx.isDirectory(root)) {
    return fail(
      EXIT_CODES.USAGE,
      `workspace is not a directory: ${root}`,
      "pass --workspace <path> pointing at an existing directory",
    );
  }
  return root;
}

export async function prepareRun(
  ctx: CliContext,
  input: PrepareInput,
): Promise<RunScaffold | RunFailure> {
  const root = resolveWorkspaceRoot(ctx, input.options.workspace);
  if (typeof root !== "string") {
    return root;
  }
  const connection = resolveConnectionSettings(ctx, input.options);
  if ("exitCode" in connection) return connection;
  const { settings, provider: selection } = connection;
  if (selection.requestedBy === undefined && selection.kind.startsWith("fixture")) {
    // Not an error and not a refusal: the fixture is the documented default and
    // the development path depends on it. What is not acceptable is a fixed
    // sentence coming back labelled like a model's answer with nothing saying
    // otherwise, which is exactly what a first-run user would otherwise see.
    for (const line of FIXTURE_FIRST_RUN_GUIDANCE) {
      ctx.stderr(`${line}
`);
    }
  }
  // Asked for by family, not by id: the ledger holds one credential per
  // *account*, and a declared endpoint is not an account. A declaration that
  // names one pins it, so this endpoint cannot inherit another host's key when
  // the family's current pointer moves.
  const credential = runCredentialFor(ctx, selection.kind, selection.accountId);
  if ("exitCode" in credential) {
    return credential;
  }
  const hash = catalogHash(root, input.options.toolSelection);
  const workspaceId = workspaceIdentity(root);
  const projectContext = projectContextFor(ctx, root);
  const sessionId = input.options.session ?? input.options.resume ?? ctx.newId("eph");
  const contextTokenLimit = effectiveContextCeiling(settings.contextTokenLimit, selection.contextWindow, settings.modelContextWindow);
  // WP18.2/18.3: caller prompt, schema and fallback resolve here — files are
  // read once at preparation, and anything unusable refuses the run before a
  // session opens or a request is sent.
  const requested = resolveRequestOptions(ctx, input.options, {
    model: selection.model,
    declaredModels: selection.capabilities.models,
  });
  if ("exitCode" in requested) {
    return requested;
  }
  // WP24.2/L48: the style prompt joins the caller's own append in the
  // scaffold below. Resolution lives in `output-style-resolve.ts` (file-size
  // gate); absent means nothing was read and the request is byte-identical
  // to a run that never heard of styles.
  const style = resolveOutputStyleAppend(ctx, root, input.options.outputStyle);
  if ("exitCode" in style) {
    return style;
  }
  // Every rejecting configuration check precedes acquisition of the writer lease.
  const opened = await openSession(ctx, input.options, fingerprint({ ...settings, providerId: selection.providerId, model: selection.model }, workspaceId, hash), compatibleCatalogHashes(root, input.options.toolSelection));
  if (opened.kind === "failed") return opened.failure;
  const permissions = createSessionPermissions(permissionChoice(input.options));
  const shell = input.options.shell ?? settings.shell;
  const execution = createRunExecution(root, { homeDir: ctx.homeDir, env: ctx.env,
    ...(input.options.fileAccess === undefined ? {} : { fileAccess: input.options.fileAccess }),
    ...(input.options.shellIsolation === undefined ? {} : { shellIsolation: input.options.shellIsolation }) });
  const questions = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => ctx.newId("ask"), restored: opened.kind === "resume" ? restoreQuestions(opened.transcript) : [] });
  return {
    questions,
    ...(input.options.toolSelection === undefined ? {} : { toolSelection: input.options.toolSelection }),
    permissions,
    execution,
    // One warm layer per prepared run, so a surface that runs several turns
    // (the REPL, the TUI) reuses the provider it built and `trylo run` — which
    // builds once and exits — is untouched by the layer existing.
    warm: createWarmRegistry(),
    providerId: selection.providerId,
    providerKind: selection.kind,
    ...reasoningSummaryOptions(selection),
    model: selection.model,
    endpoint: selection.endpoint,
    format: settings.format,
    apiKey: credential.apiKey,
    ...(credential.tokenManager !== undefined ? { tokenManager: credential.tokenManager } : {}),
    ...(credential.accountId !== undefined ? { accountId: credential.accountId } : {}),
    workspaceRoot: root,
    workspaceId,
    checkpointRoot: `${tryloHome(ctx.homeDir, ctx.env)}/checkpoints`,
    sessionId,
    ...(opened.kind === "none" ? {} : { session: opened.session }),
    ...(opened.kind === "resume" ? { resumeTranscript: opened.transcript } : {}),
    ...(opened.kind !== "resume" || opened.window === undefined
      ? {}
      : { resumeView: opened.window }),
    ...(opened.kind !== "resume" ? {} : { resumeRecords: opened.records }),
    ...(settings.maxIterations === undefined ? {} : { maxIterations: settings.maxIterations }),
    ...(projectContext === undefined ? {} : { projectContext }),
    ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    ...(contextTokenLimit === undefined ? {} : { contextTokenLimit }),
    ...(settings.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: settings.maxBudgetUsd }),
    ...(settings.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: settings.inputPricePerMTok }),
    ...(settings.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: settings.outputPricePerMTok }),
    ...(settings.lspConfigFile === undefined ? {} : { lspConfigFile: settings.lspConfigFile }),
    ...(shell === undefined ? {} : { shell }),
    ...(input.options.fileAccess === undefined ? {} : { fileAccess: input.options.fileAccess }),
    ...requested,
    // The style prompt joins the caller's own append, when both are present;
    // either alone behaves exactly as it would without the other.
    ...((requested.systemPromptAppend === undefined && style.append === undefined
      ? {}
      : {
          systemPromptAppend: [requested.systemPromptAppend, style.append]
            .filter((part) => part !== undefined && part.length > 0)
            .join("\n\n"),
        })),
    ...(input.options.learning === undefined ? {} : { learning: input.options.learning }),
    ...(input.options.permissionLedger === true
      ? { permissionLedger: { path: permissionLedgerPath(ctx.homeDir, ctx.env) } }
      : {}),
    ...(input.options.subagent === true ? { subagentEnabled: true as const } : {}),
    ...(input.options.allowWeb === true
      ? {
          allowWeb: true as const,
          // The backends are resolved here, where the provider family, endpoint
          // and credential are all known, and only because the flag was typed.
          // A provider with no hosted search contributes nothing here, so
          // `web_search` is not mounted rather than mounted and failing.
          web: webBackendsFor({
            providerKind: selection.kind,
            endpoint: selection.endpoint,
            model: selection.model,
            apiKey: credential.apiKey,
            // The account's refresher, so a search request carries the same
            // credential freshness as the conversation it runs inside.
            ...(credential.tokenManager === undefined
              ? {}
              : { tokenManager: credential.tokenManager }),
          }),
        }
      : {}),
    ...(input.options.compactSummary === undefined
      ? {}
      : { compactSummary: input.options.compactSummary }),
    warnings: opened.kind === "resume" && opened.transcript.length === 0 ? ["resumed_empty_session"] : [],
    close: closeRunResources(execution, permissions, opened.kind === "none" ? undefined : opened.session, questions.close),
  };
}

export function writeLastMessage(
  ctx: CliContext,
  target: string | undefined,
  outcome: TurnOutcome,
): ReadonlyArray<string> {
  if (target === undefined) {
    return [];
  }
  const absolute = path.resolve(ctx.cwd, target);
  const ok = ctx.writeFile(absolute, outcome.result.lastMessage);
  return ok ? [] : [`output_last_message_failed:${absolute}`];
}

export async function handleRun(ctx: CliContext, options: RunCommandOptions, sink: CliSink, control?: StdioSession): Promise<ExitCode> {
  const permissionMode = ctx.stdinIsTty ? "interactive" : "non_interactive";
  const scaffold = await prepareRun(ctx, { options, sink, permissionMode });
  if (isRunFailure(scaffold)) {
    return reportFailure(ctx, scaffold);
  }
  const interrupts = observeRunCancellation(ctx);
  try {
    const prompt = await resolvePrompt(ctx, options);
    if ("exitCode" in prompt) {
      return reportFailure(ctx, prompt);
    }
    const cancel = control === undefined ? interrupts.signal : AbortSignal.any([interrupts.signal, control.signal]);
    const promptText = prompt.text.trim() === "/compact" ? "/compact" : control === undefined ? await answerQuestionInput(scaffold.questions, prompt.text, ctx.readLine)
      : await answerStdioInput(scaffold.questions, control, prompt.text, cancel);
    const outcome = await runOneTurn(
      ctx,
      control === undefined ? scaffold : { ...scaffold, bindAgentTools: control.bindAgentTools,
        ...(scaffold.questions === undefined ? {} : { questions: stdioQuestions(scaffold.questions, control) }) },
      promptText,
      sink,
      permissionMode,
      permissionChoice(options),
      cancel,
      control?.pendingInput,
    );
    if ("message" in outcome && "hint" in outcome) {
      return reportFailure(ctx, outcome);
    }
    for (const warning of [...scaffold.warnings, ...outcome.warnings]) {
      ctx.stderr(`warning: ${warning}\n`);
    }
    for (const warning of writeLastMessage(ctx, options.outputLastMessage, outcome)) {
      ctx.stderr(`warning: ${warning}\n`);
    }
    return outcome.exitCode;
  } finally {
    interrupts.close();
    await scaffold.close();
  }
}
