import { switchEnablesUser } from "../../integration/user-learning/index.js";
import { switchEnablesSkill, switchEnablesTool } from "../../integration/user-learning/switch.js";
import { toolPersonalAgentLearning } from "./tool-personal-agent-wiring.js";
import { methodBoardRoot } from "./learning-sink.js";
import { refineOverlayFor, toolGapHostFor } from "./tool-learning-config.js";
import { afterTurnToolCycle } from "./tool-cycle-wiring.js";
import { permissionFor } from "./permission-for-run.js";
import type { PermissionChoice } from "./permission-plan.js";
import { isTurnFailure, executeTurn, type TurnHostInput, type TurnOutcome } from "./host.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import { createCliMcpRegistry } from "./mcp-wiring.js";
import { tryloHome } from "./session-paths.js";
import type { RunFailure, RunScaffold } from "./run-command.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { projectContextFor } from "./project-rules.js";
import { rolesFor } from "./roles-wiring.js";
import { teamProfileForTurn } from "./team-profile-for-turn.js";
import { fail } from "./run-failure.js";
import { loadLspServersFile } from "./lsp-config.js";
import { shellModeFor } from "./shell-mode-wiring.js";
import type { ShellEnvironment } from "../../adapters/sandbox/shell-detect.js";
import path from "node:path";
import { skillsPortFor } from "./skills-wiring.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import { createFallbackStream } from "./fallback-stream.js";
import { BootstrapContextError, bootstrapContextFailure, bootstrapForFallback } from "./bootstrap-context.js";
import { productionToolsForTurn } from "./tool-production-wiring.js";
import { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import { hermesProfileRegistry } from "../../learning/agent/subsystems/skill/host/mcp-profile.js";
import { hermesProfileClientFor } from "../../learning/agent/subsystems/skill/host/mcp-client-for.js";
import { withRuntimeRegistry } from "../../adapters/mcp-registry/runtime-overlay.js";
import { openWorkflowForTurn } from "./workflow-turn-wiring.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { centralLearningTurnFactory } from "./central-learning-turn.js";
import { openCentralRuntimeForTurn, type CentralRuntimeTurnScaffold } from "./central-runtime-turn.js";
import { centralLearningProviderConnectionRef } from "./central-learning-model.js";
import { identity } from "../../validation/json-shape.js";

/**
 * One turn of a prepared run.
 *
 * Its own module because it is one job with no decisions of its own: translate
 * the scaffold the preparation phase produced into the host input, run it, and
 * translate a failure back into the failure shape the surfaces already handle.
 * Every optional field the scaffold may or may not carry appears here exactly
 * once, which is what makes "absent means the switch was off" checkable — a
 * field that reached the host as `false` instead of missing would construct
 * something on every run.
 */
async function runPreparedTurn(
  ctx: CliContext,
  scaffold: CentralRuntimeTurnScaffold,
  text: string,
  sink: CliSink,
  permissionMode: "interactive" | "non_interactive",
  choice: PermissionChoice,
  /**
   * The caller's cancellation for the turn about to start (WP 交付面收尾波 D3).
   * Optional and last on purpose: `trylo run` and the line REPL pass nothing,
   * so their turns are byte for byte the turns they were.
   */
  cancelSignal?: AbortSignal,
  /**
   * Mid-run input, lent by the surface that keeps reading while this turn runs
   * (WP08: C03/C82/L42). `trylo run` and the line REPL pass nothing, so their
   * turns are byte for byte the turns they were.
   */
  pendingInput?: (turnId: string) => ReadonlyArray<AddressedUserInput>,
): Promise<TurnOutcome | RunFailure> {
  const executionRoot = scaffold.execution?.workspaceRoot ?? scaffold.workspaceRoot;
  // Freeze at the turn boundary; REPL/TUI scaffolds can outlive changes on disk.
  const projectContext = projectContextFor({ ...ctx, cwd: executionRoot }, executionRoot);
  // WP14：技能与项目规则同一批冻结——发现的快照只活这一轮，卸载即失效。
  const skills = skillsPortFor(ctx.homeDir, ctx.env, executionRoot);
  // C44/L27: roles freeze at the same boundary and for the same reason —
  // deleting a role file takes it out of the next run with nothing to clear.
  const roles = rolesFor(ctx.homeDir, ctx.env, executionRoot);
  const team = await teamProfileForTurn(ctx, scaffold, skills.catalog, cancelSignal);
  if (!team.ok) {
    return fail(cancelSignal?.aborted ? EXIT_CODES.CANCELLED : EXIT_CODES.CONFIG, team.message,
      "Open the team composer and start again with a valid frozen profile.");
  }

  for (const problem of skills.problems) {
    ctx.stderr(`warning: ${problem}\n`);
  }

  for (const problem of roles.problems) {
    ctx.stderr(`warning: ${problem}\n`);
  }

  // WP12 L60: the settings key names a file; the file becomes servers here,
  // once per turn like roles. A broken file warns and continues without
  // servers — the roles precedent — because a broken auxiliary file must not
  // kill an unrelated coding turn, but it must never silently become a
  // different set of programs either.
  const lspConfigPath =
    scaffold.lspConfigFile === undefined
      ? undefined
      : path.isAbsolute(scaffold.lspConfigFile)
        ? scaffold.lspConfigFile
        : path.join(ctx.cwd, scaffold.lspConfigFile);
  const lspServers = lspConfigPath === undefined ? undefined : loadLspServersFile(ctx.readFile, lspConfigPath);
  if (lspServers !== undefined && !lspServers.ok) {
    ctx.stderr(`warning: ${lspServers.message}; continuing without language servers\n`);
  }

  // WP05 C06/C07: resolved once per turn, frozen like roles. A missing
  // platform only happens in hand-built test contexts — production root
  // always injects it — so that combination warns rather than guessing.
  let shellMode: ReturnType<typeof shellModeFor> | undefined;

  if (scaffold.shell !== undefined) {
    if (ctx.platform === undefined) {
      ctx.stderr("warning: shell requested but the platform is unknown; continuing without a shell\n");
    } else {
      const surface: ShellEnvironment = {
        platform: ctx.platform as NodeJS.Platform,
        env: ctx.env,
        fileExists: (absolutePath) => ctx.readFile(absolutePath) !== undefined,
      };

      shellMode = shellModeFor(scaffold.shell, surface);

      if (!shellMode.ok) {
        ctx.stderr(`warning: ${shellMode.message}; run_shell calls will fail until it names an installed shell\n`);
      }
    }
  }

  const fallbackStream = scaffold.format === "stream-json" && scaffold.fallbackModel !== undefined && permissionMode === "non_interactive"
    ? createFallbackStream(sink) : undefined;
  const learningSwitch = scaffold.centralLearning === undefined ? scaffold.learning ?? (scaffold.checkLearning === true ? "check" : undefined)
    : switchEnablesUser(scaffold.learning) ? "all" : "agent";
  const production = await productionToolsForTurn(ctx, learningSwitch === undefined ? scaffold : { ...scaffold, learning: learningSwitch }, text.slice(0, 1000));
  const hermes = switchEnablesSkill(learningSwitch) ? createHermesSkillRuntime(ctx, scaffold,
    scaffold.centralLearningContextForIssue === undefined ? {} : { contextForIssue: scaffold.centralLearningContextForIssue }) : undefined;
  const skillPending = scaffold.centralLearningOnlyIssueId === undefined ? hermes?.pendingReview : undefined;
  const toolLearningRun = { message: [], readStdin: false, provider: scaffold.providerId, model: scaffold.model, endpoint: scaffold.endpoint,
    ...(scaffold.reasoningEffort === undefined ? {} : { reasoningEffort: scaffold.reasoningEffort }),
    ...(scaffold.permissions?.choice(choice) ?? choice) };
  const additionalTools = production?.tools ?? scaffold.additionalTools;
  const turnId = scaffold.goal?.turnId ?? ctx.newId("turn");
  const observedWait = scaffold.centralProviderWait;
  const providerWaitObservation = observedWait !== undefined && scaffold.session !== undefined && identity(scaffold.accountId)
    && observedWait.connectionRef === centralLearningProviderConnectionRef(scaffold)
    ? { schemaVersion: 1 as const, ...observedWait, sessionId: scaffold.sessionId, turnId, model: scaffold.model } : undefined;
  // Freeze this turn's resolved services and options before entering the host.
  const base: TurnHostInput = {
    ...(providerWaitObservation === undefined ? {} : { providerWaitObservation }),
    ...(scaffold.centralLearning === undefined ? {} : { centralLearning: centralLearningTurnFactory({ ctx, scaffold, turnId,
      ...(scaffold.centralRuntime === undefined ? {} : { runtime: scaffold.centralRuntime }),
      ...(scaffold.centralLearningOnlyIssueId === undefined ? { independent: true as const } : {}),
      permissionChoice: scaffold.permissions?.choice(choice) ?? choice,
      ...(cancelSignal === undefined ? {} : { signal: cancelSignal }),
      ...(hermes === undefined ? {} : { hermes }) }) }),
    ...(scaffold.onCommittedEnvelope === undefined ? {} : { onCommittedEnvelope: scaffold.onCommittedEnvelope }),
    ...(scaffold.onCommittedEffect === undefined ? {} : { onCommittedEffect: scaffold.onCommittedEffect }),
    ...(scaffold.goal === undefined ? {} : { goal: scaffold.goal }),
    ...(additionalTools === undefined ? {} : { additionalTools }),
    ...(skillPending === undefined ? {} : { skillPending }),
    ...(scaffold.bindAgentTools === undefined ? {} : { bindAgentTools: scaffold.bindAgentTools }),
    ...(team.onChildRequestDispatched === undefined ? {} : { onChildRequestDispatched: team.onChildRequestDispatched }),
    ...(ctx.bootstrapContext === undefined ? {} : { bootstrap: { state: "import_pending" as const, context: ctx.bootstrapContext } }),
    ...(scaffold.centralRuntimePolicy === "pause" ? { userSourceAvailable: false as const }
      : ctx.userSourceAvailable === undefined ? {} : { userSourceAvailable: ctx.userSourceAvailable }),
    ...(scaffold.toolSelection === undefined ? {} : { toolSelection: scaffold.toolSelection }),
    ...(scaffold.configuredToolSelection === undefined ? {} : { configuredToolSelection: scaffold.configuredToolSelection }),
    ...(scaffold.toolSelectionCeiling === undefined ? {} : { toolSelectionCeiling: scaffold.toolSelectionCeiling }),
    ...(scaffold.questions === undefined ? {} : { questions: scaffold.questions }),
    ...(scaffold.execution === undefined ? {} : { execution: scaffold.execution }),

    text,
    sessionId: scaffold.sessionId,
    turnId,
    correlationId: ctx.newId("cor"),
    workspaceRoot: scaffold.workspaceRoot,
    ...(scaffold.fileAccess === undefined ? {} : { fileAccess: scaffold.fileAccess }),
    workspaceId: scaffold.workspaceId,
    checkpointRoot: scaffold.checkpointRoot,

    providerId: scaffold.providerId,
    providerKind: scaffold.providerKind,
    ...(scaffold.reasoningSummary === undefined ? {} : { reasoningSummary: scaffold.reasoningSummary }),
    ...(scaffold.reasoningEffort === undefined ? {} : { reasoningEffort: scaffold.reasoningEffort }),
    model: scaffold.model,
    endpoint: scaffold.endpoint,
    apiKey: scaffold.apiKey,
    ...(scaffold.tokenManager !== undefined ? { tokenManager: scaffold.tokenManager } : {}),
    ...(scaffold.accountId !== undefined ? { accountId: scaffold.accountId } : {}),
    ...(scaffold.warm === undefined ? {} : { warm: scaffold.warm }),

    permission: permissionFor(permissionMode, ctx, scaffold.permissions?.choice(choice) ?? choice, executionRoot),
    ...(scaffold.permissions === undefined ? {} : { grants: scaffold.permissions.grants }),

    format: scaffold.format,
    sink: fallbackStream?.sink ?? sink,
    ...(cancelSignal === undefined ? {} : { cancelSignal }),
    ...(pendingInput === undefined ? {} : { pendingInput }),
    now: ctx.now,
    ...(ctx.onRunEnvelope === undefined ? {} : { onRunEnvelope: ctx.onRunEnvelope }),

    ...(scaffold.session === undefined ? {} : { session: scaffold.session }),
    ...(scaffold.resumeTranscript === undefined ? {} : { resumeTranscript: scaffold.resumeTranscript }),
    ...(scaffold.resumeView === undefined ? {} : { resumeView: scaffold.resumeView }),
    ...(scaffold.resumeRecords === undefined ? {} : { resumeRecords: scaffold.resumeRecords }),

    ...(scaffold.maxIterations === undefined ? {} : { maxIterations: scaffold.maxIterations }),
    ...(scaffold.maxTokens === undefined ? {} : { maxTokens: scaffold.maxTokens }),
    ...(scaffold.systemPrompt === undefined ? {} : { systemPrompt: scaffold.systemPrompt }),
    ...(scaffold.systemPromptAppend === undefined && team.protocol === undefined ? {} : { systemPromptAppend:
      [scaffold.systemPromptAppend, team.protocol].filter(item => item !== undefined).join("\n") }),
    ...(scaffold.responseSchema === undefined ? {} : { responseSchema: scaffold.responseSchema }),
    ...(scaffold.contextTokenLimit === undefined
      ? {}
      : { contextTokenLimit: scaffold.contextTokenLimit }),
    ...(scaffold.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: scaffold.maxBudgetUsd }),
    ...(scaffold.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: scaffold.inputPricePerMTok }),
    ...(scaffold.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: scaffold.outputPricePerMTok }),

    // The switch reaches the host as a value plus the two things the home
    // formula needs; the host never reads an environment variable itself.
    ...(learningSwitch === undefined
      ? {}
      : { learning: { switch: learningSwitch, homeDir: ctx.homeDir, env: ctx.env } }),
    ...(scaffold.checkLearning === true ? { checkLearning: { collection: "enabled" as const,
      allowance: { modelCalls: 1, executions: 0, tokens: scaffold.checkLearningBudget ?? 32768 } } } : {}),
    collaborationLearning: { choice: scaffold.collaborationLearning, homeDir: ctx.homeDir, env: ctx.env,
      legacyMethodScope: workspaceIdentity(scaffold.workspaceRoot),
      focusedLearning: {
        ...(hermes === undefined ? {} : { skill: hermes.personalAgent(scaffold.skillLearningAllowance, ctx.newId("skill-invocation")) }),
        ...(switchEnablesTool(learningSwitch) ? { tool: toolPersonalAgentLearning(ctx, {
          boardRoot: methodBoardRoot(ctx.homeDir, ctx.env), scope: scaffold.workspaceId, centralScope: scaffold.workspaceRoot,
          run: toolLearningRun, enabled: true }) } : {}),
        ...(scaffold.workflowFocusedLearning === undefined ? {} : { workflow: scaffold.workflowFocusedLearning }),
      } },
    // 账本的路径在准备阶段就算好了（`permissionLedgerPath`），这里只传值：一个
    // 已经解析过的路径不会再随环境变化，所以「开关打开的是哪本账」只有一个答案。
    ...(scaffold.permissionLedger === undefined
      ? {}
      : { permissionLedger: scaffold.permissionLedger }),
    ...(scaffold.subagentEnabled === undefined ? {} : { subagentEnabled: true as const }),
    ...(scaffold.subagentModelMigration === undefined ? {} : { subagentModelMigration: scaffold.subagentModelMigration }),
    ...(roles.roles.length === 0 ? {} : { subagentRoles: roles.roles }),
    ...(team.team === undefined ? {} : { subagentTeam: team.team }),
    ...(lspServers === undefined || !lspServers.ok || lspServers.servers.length === 0
      ? {}
      : { lspServers: lspServers.servers }),
    ...(shellMode === undefined ? {} : { shellMode }),
    ...(scaffold.allowWeb === undefined ? {} : { allowWeb: true }),
    ...(scaffold.web === undefined ? {} : { web: scaffold.web }),
    ...(scaffold.compactSummary === undefined ? {} : { compactSummary: scaffold.compactSummary }),
    ...(projectContext === undefined ? {} : { projectContext }),
    ...(skills.catalog === undefined ? {} : { skills: skills.catalog }),
    // The user half of the same switch (UE-4). Built only when the switch names
    // it (`user` / `all`): `--learning=method` must not read a ledger, must not
    // create a directory and must not compile a policy segment, and the cheapest
    // way to promise that is to never construct the thing that could.
    //
    // The host gets the facts, never the paths: `homeDir` + `env` go over and
    // `user-learning-config.ts` resolves the root through the one home formula,
    // so the day `TRYLO_HOME` moves, everything moves with it.
    ...(scaffold.learning === undefined || !switchEnablesUser(scaffold.learning)
      ? {}
      : {
          userLearning: {
            homeDir: ctx.homeDir,
            env: ctx.env,
            workspaceId: scaffold.workspaceId,
            now: ctx.now,
            warn: (message: string) => ctx.stderr(`warning: ${message}\n`),
          },
        }),
    // Tool learning rides the same switch (`all` only); the judgement lives with
    // the closure, so "which value lights it up" has one answer in the repo.
    ...toolGapHostFor(learningSwitch, {
      sessionId: scaffold.sessionId,
      homeDir: ctx.homeDir, env: ctx.env, now: ctx.now, stderr: (text) => ctx.stderr(text),
      workspaceId: scaffold.workspaceId,
      afterEnqueue: scaffold.centralLearning !== undefined ? async () => {}
        : afterTurnToolCycle({ ...ctx, cwd: scaffold.workspaceRoot }, { workspaceId: scaffold.workspaceId,
          run: toolLearningRun, ...(cancelSignal === undefined ? {} : { signal: cancelSignal }) }),
    }),
    // The registry the run opens its MCP servers from (WP §7-MR-D: `run` and
    // the REPL get external tools through the composition root, not through a
    // new branch in `commands.ts`). Built here rather than in the host because
    // only the command layer knows where this process keeps its profile — the
    // host deliberately reads no `process` fact of its own.
    mcp: {
      registry: createCliMcpRegistry(ctx),
      cwd: executionRoot,
      // Eager mode remains for explicit tool ceilings and hermetic fixture
      // contracts. Ordinary conversations discover configured MCP tools.
      ...(!scaffold.providerId.startsWith("fixture") && scaffold.toolSelection === undefined && scaffold.configuredToolSelection === undefined
        && ctx.env.TRYLO_MCP_DISCOVERY !== "off" ? { progressive: {
          root: `${tryloHome(ctx.homeDir, ctx.env)}/runtime/mcp-brokers`, scope: scaffold.sessionId,
          policy: JSON.stringify(choice),
        } } : {}),
      // A 描述精炼的覆盖层（P05 §6）：同一个开关，不点亮时这里什么都不加，
      // 于是挂载处拿到的描述就是服务端自己那一份。
      ...refineOverlayFor(learningSwitch, {
        homeDir: ctx.homeDir, env: ctx.env, now: ctx.now, stderr: (text) => ctx.stderr(text),
      }),
    },
  };

  try {
    const context = await hermes?.normalBinding(cancelSignal);
    const profile = context?.profile;
    const turn: TurnHostInput = profile === undefined || base.mcp === undefined ? base : {
      ...base,
      ...(context === undefined ? {} : { toolPromptContext: ({ mountedTools, signal }) => context.promptForTools(mountedTools, signal) }),
      mcp: { ...base.mcp,
        registry: withRuntimeRegistry(base.mcp.registry, hermesProfileRegistry(profile), "overlay"),
        clientFor: hermesProfileClientFor(profile, base.mcp.clientFor, context?.observer) },
    };
    const outcome = await executeTurn(turn);
    if (isTurnFailure(outcome)) return outcome;

    const finished = await maybeFallbackTurn(ctx, scaffold, turn, outcome, permissionMode);
    if (hermes !== undefined && scaffold.centralLearning === undefined && !isTurnFailure(finished)) {
      await hermes.reportTask({ sessionId: finished.result.sessionId,
        turnId: finished.result.attemptTurnId ?? finished.result.turnId });
      if (scaffold.centralLearning === undefined && !cancelSignal?.aborted) {
        const dispatched = await hermes.dispatchFunded(cancelSignal ?? new AbortController().signal);
        if (!dispatched.ok) ctx.stderr("warning: hermes_funded_skill_dispatch_failed\n");
        else if (dispatched.status === "failed") ctx.stderr("warning: hermes_funded_skill_review_failed; details remain in the central learning job\n");
      }
    }

    return finished;
  } finally {
    hermes?.close();
    fallbackStream?.finish();
    await production?.close();
  }
}

/** Each surface borrows a workflow runtime for this turn; one-shot callers may already own one. */
export async function runOneTurn(ctx: CliContext, scaffold: RunScaffold, text: string, sink: CliSink,
  permissionMode: "interactive" | "non_interactive", choice: PermissionChoice, cancelSignal?: AbortSignal,
  pendingInput?: (turnId: string) => ReadonlyArray<AddressedUserInput>): Promise<TurnOutcome | RunFailure> {
  if (scaffold.workspaceIdentity !== undefined) ctx = { ...ctx, workspaceIdentity: scaffold.workspaceIdentity };

  const runtime = await openCentralRuntimeForTurn(ctx, scaffold, cancelSignal);
  const { centralLearningThoughtMaxTokens: _thought, ...ownerScaffold } = scaffold;
  const effective = runtime === undefined ? scaffold : { ...ownerScaffold, centralLearning: runtime.allowance, centralRuntime: runtime.client,
    ...(runtime.providerWait === undefined ? {} : { centralProviderWait: runtime.providerWait }),
    ...(runtime.thoughtMaxTokens === undefined ? {} : { centralLearningThoughtMaxTokens: runtime.thoughtMaxTokens }) };
  const workflow = openWorkflowForTurn(ctx, effective);

  try {
    const outcome = await runPreparedTurn(ctx, { ...workflow?.scaffold ?? effective,
      ...(runtime === undefined ? {} : { centralRuntime: runtime.client }) }, text, sink, permissionMode, choice, cancelSignal, pendingInput);
    if (runtime !== undefined && !isTurnFailure(outcome)) await runtime.afterTask(outcome.result.sessionId,
      outcome.result.attemptTurnId ?? outcome.result.turnId);
    return outcome;
  } finally { try { await workflow?.close(); } finally { runtime?.close(); } }
}

/**
 * One bounded model fallback (WP18.2: L05, legacy `query.ts:911`).
 *
 * Only when the primary attempt ended `TEMPORARY` — the exit the host assigns
 * to `rate_limit`/`server`/`network`/`timeout` provider errors — and only in
 * non-interactive mode, mirroring legacy ("only works with --print"): an
 * interactive run reports the transient failure to the person driving it
 * instead of silently switching the model under them. The retry carries the
 * failed attempt's transcript, runs under a fresh turn id, and says so in the
 * warnings; a fallback that fails too is the turn's failure, never a third
 * attempt.
 */
async function maybeFallbackTurn(
  ctx: CliContext,
  scaffold: RunScaffold,
  base: TurnHostInput,
  outcome: TurnOutcome,
  permissionMode: "interactive" | "non_interactive",
): Promise<TurnOutcome | RunFailure> {
  const fallback = scaffold.fallbackModel;
  if (
    fallback === undefined ||
    permissionMode !== "non_interactive" ||
    outcome.exitCode !== EXIT_CODES.TEMPORARY ||
    outcome.providerErrorClass === "quota" ||
    fallback === scaffold.model
  ) {
    return outcome;
  }

  const { bootstrap: _initialImport, providerWaitObservation: _initialWait, ...retryBase } = base;
  let bootstrap: Awaited<ReturnType<typeof bootstrapForFallback>>;

  try { bootstrap = await bootstrapForFallback(base); }
  catch (error) {
    if (!(error instanceof BootstrapContextError)) throw error;
    await base.session?.release();
    return { ...bootstrapContextFailure(error), ...(base.session === undefined ? {} : { continuation: "session_closed" as const }) };
  }

  const retried = await executeTurn({
    ...retryBase,
    ...bootstrap,
    turnId: ctx.newId("turn"),
    correlationId: ctx.newId("cor"),
    model: fallback,
    resumeTranscript: outcome.transcript,
    ...(outcome.view === undefined ? {} : { resumeView: outcome.view }),
  });
  if (isTurnFailure(retried)) {
    return retried;
  }

  // Both attempts' debts are handed back, oldest first: what the first turn was
  // given belongs to a turn that is over, and the retry has an id of its own, so
  // neither is anyone's to drop (WP08.3).
  const unconsumed = [...(outcome.unconsumedInput ?? []), ...(retried.unconsumedInput ?? [])];

  return {
    ...retried,
    warnings: [
      ...outcome.warnings,
      `model_fallback: primary model ${scaffold.model} failed transiently; retried once on ${fallback}`,
      ...retried.warnings,
    ],
    ...(unconsumed.length === 0 ? {} : { unconsumedInput: unconsumed }),
  };
}
