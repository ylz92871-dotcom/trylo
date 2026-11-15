import { resolveWorkspaceRoot } from "./run-workspace.js";
import type { RunScaffold } from "./run-scaffold.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { ToolPort } from "../../ports/tools.js";
import { resolveRequestOptions } from "./run-request-options.js";
import type { RunCommandOptions } from "./args.js";
import { createWarmRegistry } from "../../adapters/provider/warm.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { reasoningSummaryOptions } from "./provider-build.js";
import type { CliContext } from "./context.js";
import { bindWorkflowImprovement } from "./workflow-turn-wiring.js";
import { permissionChoice } from "./permission-for-run.js";
import { createSessionPermissions } from "./session-permissions.js";
import { writeLastMessage } from "./run-output.js";

export { writeLastMessage } from "./run-output.js";

import { projectContextFor } from "./project-rules.js";
import { runOneTurn } from "./run-one-turn.js";
import type { CliSink } from "./render.js";
import { fail, reportFailure, type RunFailure } from "./run-failure.js";
import { fingerprint, openSession } from "./session-open.js";
import {
  FIXTURE_FIRST_RUN_GUIDANCE,
  runCredentialFor,
} from "./provider-selection.js";
import { isValidSessionId, permissionLedgerPath, tryloHome } from "./session-paths.js";
import { webBackendsFor } from "./web-wiring.js";
import { catalogHash } from "./wiring.js";
import { effectiveContextCeiling } from "./run-context-ceiling.js";
import { compatibleCatalogHashes } from "./wiring-catalog.js";
import { resolveOutputStyleAppend } from "./output-style-resolve.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { observeRunCancellation } from "./run-interrupt.js";
import { closeRunResources } from "./run-resources.js";
import { createAskUserTools } from "../../adapters/tools/ask-user/index.js";
import { mediaToolsFor } from "./media-wiring.js";
import { restoreQuestions } from "../../adapters/tools/ask-user/recovery.js";
import { answerQuestionInput } from "./question-input.js";
import { resolvePrompt } from "./run-prompt.js";

export { resolvePrompt } from "./run-prompt.js";

import { answerStdioInput, stdioQuestions } from "./stdio-questions.js";
import type { StdioSession } from "./stdio-session.js";
import { prepareGoalRun } from "./goal-run.js";
import { openWorkflowRun } from "./workflow-run-wiring.js";
import { composeAdditionalTools } from "./additional-tools.js";
import { emitWorkflowSnapshot } from "./workflow-stream.js";
import { createContentIssueContextReader } from "../../integration/learning-content/index.js";
import { methodBoardRoot } from "./learning-sink.js";
import { projectCentralDomainFeedback } from "./central-learning-sources.js";
import { restoreCentralRuntimeRunOptions } from "./central-runtime-settings.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";

export type { RunFailure } from "./run-failure.js";
export { reportFailure } from "./run-failure.js";
export { effectiveContextCeiling };

/** Compatibility entry for REPL, TUI and provider-warm callers. */
export { runOneTurn } from "./run-one-turn.js";

/** Run and REPL share preparation. The host owns execution; session-open and
 * run-settings keep their existing lifecycle and configuration ownership. */

export type { RunScaffold } from "./run-scaffold.js";

export type PrepareInput = {
  readonly options: RunCommandOptions;
  readonly sink: CliSink;
  readonly permissionMode: "interactive" | "non_interactive";
};

export function isRunFailure(value: RunScaffold | RunFailure): value is RunFailure {
  return !("workspaceRoot" in value);
}

export async function prepareRun(
  ctx: CliContext,
  input: PrepareInput,
): Promise<RunScaffold | RunFailure> {
  const requestedRoot = resolveWorkspaceRoot(ctx, input.options.workspace);
  if (typeof requestedRoot !== "string") {
    return requestedRoot;
  }

  input = { ...input, options: await restoreCentralRuntimeRunOptions(ctx, input.options, requestedRoot) };
  const identity = await resolveCentralRuntimeWorkspaceIdentity(ctx, requestedRoot,
    { allowBudgetLookup: input.options.centralLearning !== undefined,
      ...(input.options.resume !== undefined && isValidSessionId(input.options.resume) ? { resumeSessionId: input.options.resume } : {}) });
  if (!identity.ok) return fail(EXIT_CODES.CONFIG, identity.reason,
    "inspect the original workspace path, runtime intent and budget; an ambiguous identity cannot open another authorization");

  const nativeIdentity = identity.value;
  const root = nativeIdentity.resumedSession?.workspaceRoot ?? nativeIdentity.workspaceRoot;

  ctx = { ...ctx, workspaceIdentity: nativeIdentity };

  if (input.options.centralLearning !== undefined && input.options.session === undefined
    && input.options.resume === undefined && input.options.resumeLast !== true) {
    input = { ...input, options: { ...input.options, session: ctx.newId("central-learning-session") } };
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

  const toolSelection = input.options.toolSelection ?? settings.toolSelection;
  const hash = catalogHash(root, toolSelection);
  const workspaceId = nativeIdentity.resumedSession?.workspaceId ?? nativeIdentity.workspaceId;
  const projectContext = projectContextFor({ ...ctx, cwd: nativeIdentity.physicalRoot }, nativeIdentity.physicalRoot);
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
  const opened = await openSession(ctx, input.options, fingerprint({ ...settings, providerId: selection.providerId, model: selection.model }, workspaceId, hash, root), compatibleCatalogHashes(root, toolSelection));
  if (opened.kind === "failed") return opened.failure;

  const permissions = createSessionPermissions(permissionChoice(input.options));
  const shell = input.options.shell ?? settings.shell;
  const execution = createRunExecution(nativeIdentity.physicalRoot, { homeDir: ctx.homeDir, env: ctx.env,
    ...(input.options.fileAccess === undefined ? {} : { fileAccess: input.options.fileAccess }),
    ...(input.options.shellIsolation === undefined ? {} : { shellIsolation: input.options.shellIsolation }) });
  const questions = createAskUserTools({ surfaceAnswersOnly: true, nextRequestId: () => ctx.newId("ask"), restored: opened.kind === "resume" ? restoreQuestions(opened.transcript) : [] });
  const appendedPrompt = [requested.systemPromptAppend, style.append]
    .filter(part => part !== undefined && part.length > 0).join("\n\n");

  return {
    questions,
    ...(input.options.toolSelection === undefined ? {} : { toolSelection: input.options.toolSelection }),
    ...(settings.toolSelection === undefined ? {} : { configuredToolSelection: settings.toolSelection }),
    ...(input.options.toolSelection === undefined ? {} : { toolSelectionCeiling: input.options.toolSelection }),
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
    workspaceIdentity: nativeIdentity,
    checkpointRoot: `${tryloHome(ctx.homeDir, ctx.env)}/checkpoints`,
    sessionId,
    ...(opened.kind === "none" ? {} : { session: opened.session }),
    ...(opened.kind === "resume" ? { resumeTranscript: opened.transcript } : {}),
    ...(opened.kind !== "resume" || opened.window === undefined
      ? {}
      : { resumeView: opened.window }),
    ...(opened.kind !== "resume" ? {} : { resumeRecords: opened.records }),
    ...(opened.kind !== "resume" || opened.continuationNotice === undefined ? {} : { effectContinuation: opened.continuationNotice }),
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
    ...(appendedPrompt.length === 0 ? {} : { systemPromptAppend: appendedPrompt }),
    ...(input.options.centralRuntimePolicy === undefined ? {} : { centralRuntimePolicy: input.options.centralRuntimePolicy }),
    ...(input.options.centralLearningThoughtMaxTokens === undefined ? {} : { centralLearningThoughtMaxTokens: input.options.centralLearningThoughtMaxTokens }),
    ...(input.options.centralLearning === undefined ? {} : { centralLearning: input.options.centralLearning,
      centralLearningContextForIssue: createContentIssueContextReader({ boardRoot: methodBoardRoot(ctx.homeDir, ctx.env),
        scope: root, maximumChars: Math.min(65536, input.options.centralLearning.maxPromptChars), enabled: () => true,
        domainFeedback: (board, issueId) => projectCentralDomainFeedback(board, { scope: root, workspaceId, issueId }),
        secrets: credential.apiKey === undefined ? [] : [credential.apiKey] }) }),
    ...(input.options.learning === undefined ? {} : { learning: input.options.learning }),
    ...(input.options.skillLearningAllowance === undefined ? {} : { skillLearningAllowance: input.options.skillLearningAllowance }),
    ...(input.options.workflowLearning === undefined ? {} : { workflowLearning: input.options.workflowLearning }),
    ...(input.options.workflowLearningBudget === undefined ? {} : { workflowLearningBudget: input.options.workflowLearningBudget }),
    ...(input.options.workflowLearning !== true ? {} : {
      workflowLearningBudgetId: input.options.workflowLearningBudgetId ?? ctx.newId("workflow-learning-budget"),
    }),
    ...(input.options.checkLearning === true ? { checkLearning: true as const, checkLearningBudget: input.options.checkLearningBudget ?? 32768 } : {}),
    ...(input.options.collaborationLearning === undefined ? {} : { collaborationLearning: input.options.collaborationLearning }),
    ...(input.options.permissionLedger === true
      ? { permissionLedger: { path: permissionLedgerPath(ctx.homeDir, ctx.env) } }
      : {}),
    ...(input.options.subagent === true ? { subagentEnabled: true as const } : {}),
    ...(opened.kind === "resume" && input.options.migrateProvider === true && input.options.migrateModel === true
      ? { subagentModelMigration: selection.model } : {}),
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

export async function handleRun(ctx: CliContext, options: RunCommandOptions, sink: CliSink, control?: StdioSession,
  extension?: { open(scaffold: RunScaffold): Promise<ToolPort>; close(): Promise<void> }): Promise<ExitCode> {
  if ((options.workflowVersion !== undefined || options.workflowLearning === true) && options.session === undefined && options.resume === undefined) {
    options = { ...options, session: ctx.newId("workflow-run") };
  }

  const permissionMode = ctx.stdinIsTty ? "interactive" : "non_interactive";
  const scaffold = await prepareRun(ctx, { options, sink, permissionMode });
  if (isRunFailure(scaffold)) {
    return reportFailure(ctx, scaffold);
  }

  const interrupts = observeRunCancellation(ctx);
  let workflow: Exclude<Awaited<ReturnType<typeof openWorkflowRun>>, RunFailure> = undefined;
  let automatic: import("./workflow-auto-wiring.js").AutomaticWorkflow | undefined;
  let improvement: ReturnType<typeof import("./workflow-improvement-wiring.js").openWorkflowImprovement> = undefined;

  try {
    const extensionTools = await extension?.open(scaffold);
    const goalRun = await prepareGoalRun(scaffold, control, sink, ctx);
    if (goalRun.kind === "updated") return EXIT_CODES.OK;

    const prompt = await resolvePrompt(ctx, options);
    if ("exitCode" in prompt) {
      return reportFailure(ctx, prompt);
    }

    const cancel = control === undefined ? interrupts.signal : AbortSignal.any([interrupts.signal, control.signal]);

    if (options.workflowLearning === true && options.centralLearning === undefined && options.workflowCollection !== "disabled") {
      automatic = await (await import("./workflow-auto-wiring.js")).openAutomaticWorkflow(ctx, options, scaffold, prompt.text, cancel, "normal_improvement");
      improvement = (await import("./workflow-improvement-wiring.js")).openWorkflowImprovement(ctx, scaffold,
        automatic.learningAllowanceRemaining ?? options.workflowLearningBudget ?? 16000, automatic.legacyContext);
    }

    const workflowResult = await openWorkflowRun(ctx, options, goalRun.scaffold, automatic?.nomination,
      trace => emitWorkflowSnapshot(ctx, { ...options, format: scaffold.format }, trace));
    if (workflowResult !== undefined && "message" in workflowResult) return reportFailure(ctx, workflowResult);

    workflow = workflowResult;
    const effective = workflow?.scaffold ?? goalRun.scaffold;
    const extensionBase = extensionTools ?? effective.additionalTools;
    const legacyTools = extensionBase === undefined ? workflow?.tools : workflow === undefined ? extensionBase : composeAdditionalTools(extensionBase, workflow.tools);
    const mediaSetup = mediaToolsFor(ctx.env, effective.execution?.workspaceRoot ?? effective.workspaceRoot);
    if (mediaSetup.warning !== undefined) ctx.stderr(`warning: ${mediaSetup.warning}\n`);
    const media = mediaSetup.tools;
    const additional = media === undefined ? legacyTools : legacyTools === undefined ? media : composeAdditionalTools(legacyTools, media);
    const preparedBase = { ...effective, ...(additional === undefined ? {} : { additionalTools: additional }),
      ...(mediaSetup.warning === undefined ? {} : { systemPromptAppend:
        [effective.systemPromptAppend, mediaSetup.warning].filter(Boolean).join("\n\n") }) };
    const prepared = improvement === undefined ? preparedBase : bindWorkflowImprovement(preparedBase, improvement);
    const observed = workflow === undefined ? ctx : { ...ctx, onRunEnvelope: (envelope: import("../../protocol/envelope.js").Envelope) => {
      workflow?.observe(envelope);
      ctx.onRunEnvelope?.(envelope);
    } };
    const promptText = prompt.text.trim() === "/compact" ? "/compact" : control === undefined ? await answerQuestionInput(scaffold.questions, prompt.text, ctx.readLine)
      : await answerStdioInput(scaffold.questions, control, prompt.text, cancel);
    const outcome = await runOneTurn(
      observed,
      control === undefined ? prepared : { ...prepared, bindAgentTools: control.bindAgentTools,
        ...(scaffold.questions === undefined ? {} : { questions: stdioQuestions(scaffold.questions, control) }) },
      promptText,
      goalRun.sink,
      permissionMode,
      permissionChoice(options),
      cancel,
      control?.pendingInput,
    );

    await goalRun.finish(outcome);

    if ("message" in outcome && "hint" in outcome) {
      return reportFailure(ctx, outcome);
    }

    for (const warning of [...scaffold.warnings, ...outcome.warnings]) {
      ctx.stderr(`warning: ${warning}\n`);
    }

    for (const warning of writeLastMessage(ctx, options.outputLastMessage, outcome)) {
      ctx.stderr(`warning: ${warning}\n`);
    }

    return workflow?.codeFor(outcome.exitCode) ?? outcome.exitCode;
  } finally {
    interrupts.close();
    try { await workflow?.finish(); } finally {
      try {
        await improvement?.close();
        await automatic?.close?.();
      } finally {
        try { await extension?.close(); } finally { await scaffold.close(); }
      }
    }
  }
}
