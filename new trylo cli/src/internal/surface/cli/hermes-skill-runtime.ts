import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createHermesSkillSubsystem, createSkillReviewProcess, createSkillCoordination, createSkillPersonalAgentFocus, skillTaskReport,
  skillFailureCode,
  type HermesSkillGrant, type HermesSkillHost } from "../../learning/agent/subsystems/skill/index.js";
import { hermesProfileRegistry, hermesProfileClientFor, createJournalSkillOpportunity, hermesReviewBackend, createHermesNativeContext,
  bindHermesNormalContext, withSkillCentralFunding, withSkillReviewDeadline, createHermesManagedSkillRuntime,
  readSkillReviewContinuation, hermesReviewExecution, type SkillReviewContinuationInput, type HermesShadowRequest } from "../../learning/agent/subsystems/skill/host/index.js";
import { skillDailyBoard } from "./skill-daily-board.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import { listSessions, sessionsDir, tryloHome } from "./session-paths.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { skillDailyConnection, type SkillDailyConnection } from "./skill-daily-provider.js";
import { createSkillDailyBudget } from "./skill-daily-budget.js";
import { permissionFor } from "./permission-for-run.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { createHermesShadowSession } from "./hermes-shadow-session.js";
import { executeTurn, isTurnFailure } from "./host.js";
import { PROVIDER_ERROR_CLASSES, type ProviderPort } from "../../ports/provider.js";
import { redactText } from "../../credentials/redact.js";
import { createCliHermesClient, hermesCapabilitiesDirectory } from "./hermes-skill-client.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralLearningAllowance } from "../../learning/control/coordination-contract.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";
import { hermesSkillLifecycle } from "./hermes-skill-lifecycle.js";
import { readCentralSkillResearchOpportunity } from "../../learning/agent/subsystems/skill/control/central-research-board.js";
import { createSkillPendingReview } from "../../learning/agent/subsystems/skill/host/pending-review.js";
import type { SkillProposalReceipt, SkillReviewExecution } from "../../learning/agent/subsystems/skill/review-process.js";

/** CLI composition only: source, provider, Permission and Board remain runtime-owned. */
export function createHermesSkillRuntime(ctx: CliContext, scaffold?: RunScaffold, runtime: {
  readonly provider?: ProviderPort; readonly opportunity?: HermesSkillHost["opportunity"];
  /** Managed learning shares the host's canonical Board root, never a new wallet. */
  readonly boardRoot?: string; readonly enabled?: () => boolean;
  readonly contextForIssue?: CentralLearningContextReader;
  /** Scope-owned managed transport metadata; legacy daily learning keeps its normal resolver. */
  readonly connection?: SkillDailyConnection;
  /** Host-verified original checkpoint; successor funds remain separately owned by Board. */
  readonly continuation?: SkillReviewContinuationInput;
  /** The host's selected single-response generation allowance, not total funding. */
  readonly generationMaxOutputTokens?: number;
} = {}) {
  const workspaceRoot = scaffold?.workspaceRoot ?? ctx.cwd, workspaceId = workspaceIdentity(workspaceRoot);
  const home = tryloHome(ctx.homeDir, ctx.env);
  const boardRoot = runtime.boardRoot ?? path.join(home, "learning", "board");
  const lifecycle = hermesSkillLifecycle(boardRoot, runtime.enabled ?? (() => true));
  const client = createCliHermesClient(ctx);
  const pendingReview = scaffold === undefined ? undefined : createSkillPendingReview({ board: skillDailyBoard(boardRoot), scope: workspaceRoot,
    native: (method, params, signal) => client.compatibility(method, params, { signal }) });
  const review = withSkillReviewDeadline(createSkillReviewProcess(hermesReviewBackend(client)));
  const coordination = createSkillCoordination({ board: skillDailyBoard(boardRoot), scope: workspaceRoot,
    ownerId: ctx.newId("skill-worker"), now: () => new Date(ctx.now()).toISOString(),
    ...(runtime.enabled === undefined ? {} : { enabled: runtime.enabled }) });
  const sessions = () => listSessions(ctx, sessionsDir(ctx.homeDir, ctx.env));
  const opportunity = runtime.opportunity ?? createJournalSkillOpportunity({ workspaceRoot, workspaceId,
    sessions, accept: async (source, signal) => await client.review("seen", { opportunity: source }, signal) === false });
  const warn = (code: string) => ctx.stderr(`warning: ${code}\n`);
  let native: ReturnType<typeof createHermesNativeContext> | undefined;
  const nativeFor = (profile: Awaited<ReturnType<typeof client.profile>>) => native ??= createHermesNativeContext({
    pythonBinary: profile.command, capabilitiesDir: hermesCapabilitiesDirectory,
    hermesHome: profile.env.HERMES_HOME!, env: ctx.env, warn });
  let managedConnection: SkillDailyConnection | undefined;
  const connectionForManagedReview = () => managedConnection ??= runtime.connection ?? skillDailyConnection(ctx, scaffold);
  const normalBinding = async (signal?: AbortSignal) => {
    try {
      const profile = await client.profile("normal", signal);
      return bindHermesNormalContext(profile, nativeFor(profile), warn);
    } catch {
      if (!signal?.aborted) warn("hermes_normal_context_unavailable");
      return undefined;
    }
  };
  const runReview = async (source: Parameters<typeof review>[0], input: Parameters<typeof runHermesShadow>[3], reviewOrigin?: "central_research") => {
    return review(source, async (prompt, signal) => {
      const profile = await client.profile("learning", signal, source.trigger, reviewOrigin);
      const connection = connectionForManagedReview();
      return runHermesShadow(ctx, { prompt, profile }, connection, { ...input, signal });
    }, input.signal);
  };

  const learn = (grant: HermesSkillGrant, signal = new AbortController().signal) => {
    const funding = createSkillDailyBudget(ctx, { boardRoot: path.join(home, "learning", "board"), workspaceId });
    const subsystem = createHermesSkillSubsystem({ collection: () => "enabled", opportunity,

      async run(observed, allowance, runSignal) {
        let legacyReply: unknown;
        let closeReason: "completed" | "cancelled" | "failed" = "failed";

        try {
          legacyReply = await review(observed, async (prompt, shadowSignal) => {
            await funding.open({ maxCalls: allowance.maxCalls, maxTokens: allowance.maxOutputTokens });
            const usage = await funding.usage();
            if (!usage.reported || usage.status !== "open") throw new Error("learning_grant_unsettled");

            const connection = skillDailyConnection(ctx, scaffold);
            const profile = await client.profile("learning", shadowSignal, observed.trigger);

            return runHermesShadow(ctx, { prompt, profile }, connection, {
              calls: Math.max(0, allowance.maxCalls - usage.calls), tokens: Math.max(0, allowance.maxOutputTokens - usage.outputTokens),
              root: path.join(home, "learning", "skill", "runs", ctx.newId("hermes-shadow")),
              guard: provider => funding.guard(runtime.provider ?? provider), signal: shadowSignal,
            });
          }, runSignal);
          const usage = await funding.usage();
          const status = nativeStatus(legacyReply);

          closeReason = runSignal.aborted || status === "cancelled" ? "cancelled"
            : status === "failed" || status === "ambiguous_proposals" ? "failed" : "completed";

          return { status: status === "skipped" ? "waiting" : closeReason, legacyReply,
            usage: { calls: usage.calls, usageStatus: usage.reported ? "reported" : "missing",
              ...(usage.reported ? { outputTokens: usage.outputTokens, totalTokens: usage.tokens } : {}) } };
        } catch (error) {
          closeReason = runSignal.aborted ? "cancelled" : "failed";
          const usage = await funding.usage();
          return { status: closeReason, error: { code: skillFailureCode(error, "hermes_runtime_unavailable") },
            usage: { calls: usage.calls, usageStatus: usage.reported ? "reported" : "missing",
              ...(usage.reported ? { outputTokens: usage.outputTokens, totalTokens: usage.tokens } : {}) } };
        } finally {
          try { await funding.close(closeReason); }
          catch { ctx.stderr("warning: hermes_learning_grant_close_failed; native result and persisted usage are retained\n"); }
        }
      },
    });

    return subsystem.learn(grant, signal);
  };
  const managed = createHermesManagedSkillRuntime({ scope: workspaceRoot, coordination,
    ...(runtime.continuation === undefined ? {} : { continuation: { issueId: runtime.continuation.issueId,
      read: () => readSkillReviewContinuation({ board: skillDailyBoard(boardRoot), scope: workspaceRoot, input: runtime.continuation! }) } }),
    readResearch: (requestRef, signal) => readCentralSkillResearchOpportunity({ board: skillDailyBoard(boardRoot),
      scope: workspaceRoot, workspaceRoot }, requestRef, signal),
    ...(runtime.contextForIssue === undefined ? {} : { contextForIssue: runtime.contextForIssue }),

    reviewModel() {
      const connection = connectionForManagedReview();
      return { providerId: connection.providerId, providerKind: connection.providerKind, model: connection.model,
        ...(connection.reasoningEffort === undefined ? {} : { reasoningEffort: connection.reasoningEffort }) };
    },

    read: (source, signal) => (runtime.opportunity ?? createJournalSkillOpportunity({ workspaceRoot, workspaceId, sessions, source }))(signal),
    seen: (observed, signal) => client.review("seen", { opportunity: observed }, signal),
    review: (observed, work, checkpoint, reviewOrigin) => runReview(observed, {
      calls: work.remaining.calls, tokens: work.remaining.tokens,
      ...(checkpoint === undefined ? {} : { resumeTranscript: checkpoint.transcript }),
      root: path.join(home, "learning", "skill", "runs", ctx.newId("hermes-focused")), signal: work.signal,
      guard: provider => withSkillCentralFunding(runtime.provider ?? provider, { funding: work.funding, newId: () => ctx.newId("skill-central-call"),
        ...(runtime.generationMaxOutputTokens === undefined ? {} : { maxOutputTokens: runtime.generationMaxOutputTokens }) }),
    }, reviewOrigin),
  });
  const centralWorker = managed.worker;

  return {
    learn, compatibility: client.compatibility, profile: client.profile, close: client.close, coordination, normalBinding,
    ...(pendingReview === undefined ? {} : { pendingReview }),
    prepareManaged: managed.prepareManaged, runManaged: managed.runManaged,
    ...(managed.recoverManaged === undefined ? {} : { recoverManaged: managed.recoverManaged }),

    personalAgent(allowance: CentralLearningAllowance | undefined, invocationId: string) {
      return createSkillPersonalAgentFocus({ coordination,
        grantId: `personal-agent-skill:${contentHashOf([workspaceRoot, invocationId]).slice(0, 32)}`,
        ...(allowance === undefined ? {} : { allowance }),
        runFocused: (issueId, signal) => coordination.run({ issueId, signal, worker: centralWorker }),
        dispatchFunded: signal => coordination.dispatchFunded({ signal, worker: centralWorker }),
      });
    },

    async normalContext(signal?: AbortSignal) {
      const binding = await normalBinding(signal);
      return binding === undefined ? undefined : { profile: binding.profile, observer: binding.observer,
        prompt: await binding.promptForTools(undefined, signal) };
    },

    async reportTask(input: { readonly sessionId: string; readonly turnId: string }) {
      let report: ReturnType<typeof skillTaskReport>;
      let observedReads: Parameters<typeof lifecycle.recordTaskLoads>[0] | undefined;
      const source = createJournalSkillOpportunity({ workspaceRoot, workspaceId, sessions, source: input,

        observe({ transcript, records, priorLoadedSkills, priorProvidedSkills, sourceContext }) {
          observedReads = { scope: workspaceRoot, ...input, transcript, records };
          report = skillTaskReport({ ...input, transcript, historyLoadedSkills: priorLoadedSkills, historyProvidedSkills: priorProvidedSkills,
            userAttribution: sourceContext.currentUserAttribution });
        } });

      try { await source(new AbortController().signal); }
      catch {
        warn("hermes_skill_source_report_unavailable");
        return;
      }

      if (observedReads !== undefined) {
        try { await lifecycle.recordTaskLoads(observedReads); }
        catch { warn("hermes_skill_lifecycle_observation_unavailable"); }
      }

      if (report === undefined) return;

      const result = await coordination.report(report);
      if (!result.ok) warn("hermes_skill_opportunity_report_failed");
    },

    runFocused: (issueId: string, signal: AbortSignal) => coordination.run({ issueId, signal, worker: centralWorker }),
    dispatchFunded: (signal: AbortSignal) => coordination.dispatchFunded({ signal, worker: centralWorker }),
  };
}

async function runHermesShadow(ctx: CliContext, request: HermesShadowRequest, connection: ReturnType<typeof skillDailyConnection>, input: {
  readonly calls: number; readonly tokens: number; readonly root: string; readonly guard: Parameters<typeof executeTurn>[0]["providerGuard"]; readonly signal: AbortSignal;
  readonly resumeTranscript?: Parameters<typeof executeTurn>[0]["resumeTranscript"];
}) {
  if (input.calls < 1 || input.tokens < 1 || input.signal.aborted) throw new Error("learning_allowance_exhausted");

  await mkdir(input.root, { recursive: true });
  const execution = createRunExecution(input.root, { homeDir: ctx.homeDir, env: ctx.env, shellIsolation: "host" });
  const sessionId = ctx.newId("hermes-session"), turnId = ctx.newId("hermes-turn");
  const journalPath = path.join(input.root, "review.ndjson");
  const session = createHermesShadowSession({ path: journalPath, sessionId, turnId,
    createdAt: new Date(ctx.now()).toISOString(), providerId: connection.providerId, model: connection.model,
    workspaceId: workspaceIdentity(input.root), workspaceRoot: input.root });

  ctx.stderr(`info: hermes_shadow_journal=${journalPath}; session=${sessionId}; turn=${turnId}\n`);
  const observed: SkillProposalReceipt[] = [];
  const partial = (): SkillReviewExecution => ({ answer: "", status: input.signal.aborted ? "cancelled" : "failed", proposals: [...observed] });
  let reply: SkillReviewExecution = partial();

  try {
    const outcome = await executeTurn({ text: redactText(request.prompt, [connection.apiKey ?? ""]), sessionId, turnId, session, correlationId: ctx.newId("hermes-run"),
      ...(input.resumeTranscript === undefined ? {} : { resumeTranscript: input.resumeTranscript }),
      workspaceRoot: input.root, workspaceId: workspaceIdentity(input.root), checkpointRoot: path.join(input.root, "checkpoints"),
      providerId: connection.providerId, providerKind: connection.providerKind, model: connection.model, endpoint: connection.endpoint, apiKey: connection.apiKey,
      ...(connection.tokenManager === undefined ? {} : { tokenManager: connection.tokenManager }),
      ...(connection.accountId === undefined ? {} : { accountId: connection.accountId }),
      ...(connection.reasoningEffort === undefined ? {} : { reasoningEffort: connection.reasoningEffort }),
      permission: permissionFor("non_interactive", ctx, { allowTools: request.profile.allowedTools }, input.root),
      format: "stream-json", sink: { stdout: () => {}, stderr: () => {} }, now: ctx.now, cancelSignal: input.signal,

      onRunEnvelope(envelope) {
        if (envelope.kind !== "terminal" || envelope.payload.reason === "completed") return;
        const message = typeof envelope.payload.message === "string" ? envelope.payload.message : "";
        const providerClass = PROVIDER_ERROR_CLASSES.find(value => value === envelope.payload.errorClass);
        const detail = providerClass === undefined ? skillFailureCode(new Error(message), "hermes_shadow_execution_failed")
          : `provider_${providerClass}: ${redactText(message, [connection.apiKey ?? ""]).slice(0, 1024)}`;
        ctx.stderr(`warning: ${detail}; native shadow terminal retained\n`);
      },

      systemPrompt: { mode: "replace", text: "You are the Trylo skill learning agent. Follow the official Hermes learning prompt, inspect existing skills and use only the mounted Hermes tools. Proposals remain pending approval."
        + (input.resumeTranscript === undefined ? "" : " These are historical accepted observations. Native read-before-revise marks are process-local: load the current target in this review before any new revision. Respect actual refusal results and verified condition changes; do not mechanically replay rejected work, unknown effects or completed staging, approvals, business and feedback. Decide only genuinely unfinished work; honest no_learning is valid.") },
      mcp: { registry: hermesProfileRegistry(request.profile), clientFor: hermesProfileClientFor(request.profile, undefined, {
        viewed: async () => {}, warn: code => ctx.stderr(`warning: ${code}\n`),
        staged: async receipt => {
          if (!observed.some(item => item.pendingId === receipt.pendingId && item.name === receipt.name && item.action === receipt.action)) observed.push(receipt);
        },
      }), cwd: input.root }, toolSelection: request.profile.allowedTools,
      ...(input.guard === undefined ? {} : { providerGuard: input.guard }), requestAttemptPolicy: "single_request",
      execution, maxIterations: input.calls, maxTokens: input.tokens });
    if (isTurnFailure(outcome)) {
      ctx.stderr("warning: hermes_shadow_execution_failed; observed native staging replies retained\n");
      reply = partial();
    } else reply = hermesReviewExecution(outcome.transcript,
      outcome.result.status === "completed" ? "completed" : outcome.result.status === "cancelled" ? "cancelled" : "failed",
      input.resumeTranscript);
  } catch (error) {
    ctx.stderr(`warning: ${skillFailureCode(error, "hermes_shadow_execution_failed")}; observed native staging replies retained\n`);
    reply = partial();
  } finally {
    try { await session.release(); }
    catch {
      ctx.stderr("warning: hermes_shadow_session_release_failed; original journal retained\n");
      reply = { ...reply, status: input.signal.aborted ? "cancelled" : "failed" };
    }
    try { await execution.close(); }
    catch {
      ctx.stderr("warning: hermes_shadow_execution_close_failed; native staging replies retained\n");
      reply = { ...reply, status: input.signal.aborted ? "cancelled" : "failed" };
    }
  }

  return reply;
}

function nativeStatus(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "status" in value && typeof value.status === "string" ? value.status : undefined;
}
