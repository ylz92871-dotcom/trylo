import { switchEnablesUser } from "../../integration/user-learning/index.js";
import { refineOverlayFor, toolGapHostFor } from "./tool-learning-config.js";
import { permissionFor } from "./permission-for-run.js";
import type { PermissionChoice } from "./permission-plan.js";
import { isTurnFailure, executeTurn, type TurnHostInput, type TurnOutcome } from "./host.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import { createCliMcpRegistry } from "./mcp-wiring.js";
import type { RunFailure, RunScaffold } from "./run-command.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { projectContextFor } from "./project-rules.js";
import { rolesFor } from "./roles-wiring.js";
import { teamProfileFor } from "./team-profile-wiring.js";
import { fail } from "./run-failure.js";
import { loadLspServersFile } from "./lsp-config.js";
import { shellModeFor } from "./shell-mode-wiring.js";
import type { ShellEnvironment } from "../../adapters/sandbox/shell-detect.js";
import path from "node:path";
import { skillsPortFor } from "./skills-wiring.js";
import type { AddressedUserInput } from "../../domain/input-queue.js";
import { createFallbackStream } from "./fallback-stream.js";
import { BootstrapContextError, bootstrapContextFailure, bootstrapForFallback } from "./bootstrap-context.js";

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
export async function runOneTurn(
  ctx: CliContext,
  scaffold: RunScaffold,
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
  // Freeze at the turn boundary; REPL/TUI scaffolds can outlive changes on disk.
  const projectContext = projectContextFor(ctx, scaffold.workspaceRoot);
  // WP14：技能与项目规则同一批冻结——发现的快照只活这一轮，卸载即失效。
  const skills = skillsPortFor(ctx.homeDir, ctx.env, scaffold.workspaceRoot);
  // C44/L27: roles freeze at the same boundary and for the same reason —
  // deleting a role file takes it out of the next run with nothing to clear.
  const roles = rolesFor(ctx.homeDir, ctx.env, scaffold.workspaceRoot);
  const team = teamProfileFor({ workspaceRoot: scaffold.workspaceRoot, readFile: ctx.readFile,
    ...(skills.catalog === undefined ? {} : { skills: skills.catalog }),
    ...(scaffold.systemPromptAppend === undefined ? {} : { systemPrompt: scaffold.systemPromptAppend }) });
  if (!team.ok) return fail(EXIT_CODES.CONFIG, team.message, "Open the team composer and start again with a valid frozen profile.");
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
  const base: TurnHostInput = {
    ...(scaffold.bindAgentTools === undefined ? {} : { bindAgentTools: scaffold.bindAgentTools }),
    ...(ctx.bootstrapContext === undefined ? {} : { bootstrap: { state: "import_pending" as const, context: ctx.bootstrapContext } }),
    ...(ctx.userSourceAvailable === undefined ? {} : { userSourceAvailable: ctx.userSourceAvailable }),
    ...(scaffold.toolSelection === undefined ? {} : { toolSelection: scaffold.toolSelection }),
    ...(scaffold.questions === undefined ? {} : { questions: scaffold.questions }),
    ...(scaffold.execution === undefined ? {} : { execution: scaffold.execution }),
    text,
    sessionId: scaffold.sessionId,
    turnId: ctx.newId("turn"),
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
    permission: permissionFor(permissionMode, ctx, scaffold.permissions?.choice(choice) ?? choice, scaffold.workspaceRoot),
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
    ...(scaffold.systemPromptAppend === undefined ? {} : { systemPromptAppend: team.protocol === undefined
      ? scaffold.systemPromptAppend : `${scaffold.systemPromptAppend}\n${team.protocol}` }),
    ...(scaffold.responseSchema === undefined ? {} : { responseSchema: scaffold.responseSchema }),
    ...(scaffold.contextTokenLimit === undefined
      ? {}
      : { contextTokenLimit: scaffold.contextTokenLimit }),
    ...(scaffold.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: scaffold.maxBudgetUsd }),
    ...(scaffold.inputPricePerMTok === undefined ? {} : { inputPricePerMTok: scaffold.inputPricePerMTok }),
    ...(scaffold.outputPricePerMTok === undefined ? {} : { outputPricePerMTok: scaffold.outputPricePerMTok }),
    // The switch reaches the host as a value plus the two things the home
    // formula needs; the host never reads an environment variable itself.
    ...(scaffold.learning === undefined
      ? {}
      : { learning: { switch: scaffold.learning, homeDir: ctx.homeDir, env: ctx.env } }),
    // 账本的路径在准备阶段就算好了（`permissionLedgerPath`），这里只传值：一个
    // 已经解析过的路径不会再随环境变化，所以「开关打开的是哪本账」只有一个答案。
    ...(scaffold.permissionLedger === undefined
      ? {}
      : { permissionLedger: scaffold.permissionLedger }),
    ...(scaffold.subagentEnabled === undefined ? {} : { subagentEnabled: true as const }),
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
    ...toolGapHostFor(scaffold.learning, {
      homeDir: ctx.homeDir, env: ctx.env, now: ctx.now, stderr: (text) => ctx.stderr(text),
    }),
    // The registry the run opens its MCP servers from (WP §7-MR-D: `run` and
    // the REPL get external tools through the composition root, not through a
    // new branch in `commands.ts`). Built here rather than in the host because
    // only the command layer knows where this process keeps its profile — the
    // host deliberately reads no `process` fact of its own.
    mcp: {
      registry: createCliMcpRegistry(ctx),
      cwd: ctx.cwd,
      // A 描述精炼的覆盖层（P05 §6）：同一个开关，不点亮时这里什么都不加，
      // 于是挂载处拿到的描述就是服务端自己那一份。
      ...refineOverlayFor(scaffold.learning, {
        homeDir: ctx.homeDir, env: ctx.env, now: ctx.now, stderr: (text) => ctx.stderr(text),
      }),
    },
  };
  const outcome = await executeTurn(base);
  if (isTurnFailure(outcome)) {
    fallbackStream?.finish();
    return outcome;
  }
  const finished = await maybeFallbackTurn(ctx, scaffold, base, outcome, permissionMode);
  fallbackStream?.finish();
  return finished;
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
  const { bootstrap: _initialImport, ...retryBase } = base;
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
