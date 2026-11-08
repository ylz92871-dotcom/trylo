import path from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createCentralLearningHost, reply } from "../../integration/central-learning/host.js";
import { createCentralMethodExecutor } from "../../integration/central-learning/method-executor.js";
import { createCentralToolExecutor } from "../../integration/central-learning/tool-executor.js";
import { createCentralSkillExecution } from "../../integration/central-learning/skill-adapter.js";
import { createCentralCollaborationExecution } from "../../integration/central-learning/collaboration.js";
import { createNormalTaskContentRuntime, createStagedContentSession, contentAdmissionForIssue,
  type ContentIssueAdmission } from "../../integration/learning-content/index.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import type { CentralLearningAgentDomain } from "../../learning/control/coordination-contract.js";
import type { CentralLearningExecutionPort } from "../../integration/central-learning/contracts.js";
import type { CentralLearningRunResult } from "../../integration/central-learning/host.js";
import type { FocusedLearningDecision, FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { MethodBoard } from "../../learning/agent/subsystems/method/index.js";
import type { MethodLearningInput } from "./wiring-optins.js";
import type { PersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolPort } from "../../ports/tools.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import type { createHermesSkillRuntime } from "./hermes-skill-runtime.js";
import { methodBoardRoot } from "./learning-sink.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { CENTRAL_ADVISORY_ID_PREFIX, CENTRAL_ADVISORY_PUBLICATION_PREFIX } from "../../integration/central-learning/central-advisory-contracts.js";
import { runToolCycle } from "./tool-cycle-wiring.js";
import { centralLearningTools } from "./central-learning-tools.js";
import { centralLearningModelRef } from "./central-learning-model.js";
import type { PermissionChoice } from "./permission-plan.js";
import { runtimeScopePaths, type CentralRuntimeClient } from "../../adapters/central-learning-runtime/index.js";
import { tryloHome } from "./session-paths.js";
import { wakeCentralFromPersonalAgent } from "./central-runtime-pa.js";
import { toolResearchServices } from "./tool-research-wiring.js";
import { CENTRAL_LEARNING_INSTRUCTION, INDEPENDENT_CENTRAL_LEARNING_INSTRUCTION } from "./central-learning-instruction.js";
import { readCentralRuntimeOverviewFor } from "./central-runtime-overview.js";
import { centralLearningSessionLookup, centralLearningTaskSessions, projectCentralDomainFeedback,
  CENTRAL_LEARNING_CONTROL_TOOLS } from "./central-learning-sources.js";

export type CentralLearningTurnRuntime = {
  readonly personalAgentInstruction?: string;
  readonly tools: ToolPort;
  wrapControlTools(port: ToolPort): ToolPort;
  focus(input: FocusedLearningDecision, signal: AbortSignal): Promise<FocusedLearningDispatch>;
  resume(signal: AbortSignal): Promise<FocusedLearningDispatch>;
  beforeInspect(): Promise<void>;
  beforeTask(provider: ProviderPort, signal: AbortSignal): Promise<ProviderPort>;
  afterTask(signal: AbortSignal): Promise<void>;
  command(args: JsonObject, signal: AbortSignal, toolCallId?: string): Promise<unknown>;
  close(): Promise<void>;
};

export type CentralLearningTurnFactory = (dependencies: {
  readonly provider: ProviderPort; readonly collaboration: PersonalAgentRuntime;
  readonly method?: MethodBoard; readonly learning?: MethodLearningInput;
}) => CentralLearningTurnRuntime;

/** Built by the normal command host, completed only after raw funded transport,
 * method source and the existing PA collaboration control actually exist. */
export function centralLearningTurnFactory(options: { readonly ctx: CliContext; readonly scaffold: RunScaffold;
  readonly turnId: string; readonly permissionChoice: PermissionChoice;
  readonly signal?: AbortSignal;
  readonly runtime?: CentralRuntimeClient;
  readonly independent?: true;
  readonly hermes?: ReturnType<typeof createHermesSkillRuntime> }): CentralLearningTurnFactory {
  return dependencies => {
    const { ctx, scaffold, turnId, hermes } = options, allowance = scaffold.centralLearning;
    if (allowance === undefined) throw new Error("central_learning_explicit_allowance_required");

    const modelRef = centralLearningModelRef(scaffold);
    const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), scope = scaffold.workspaceRoot;
    let open = true;
    const enabled = () => open && options.signal?.aborted !== true;
    const independent = options.independent === true;
    const wake = (reason: string, signal: AbortSignal, issueId?: string) => wakeCentralFromPersonalAgent(options.runtime,
      { reason, sourceRefs: issueId === undefined ? [] : [issueId] }, signal);
    const domainFeedback = (board: Parameters<typeof projectCentralDomainFeedback>[0], issueId: string) =>
      projectCentralDomainFeedback(board, { scope, workspaceId: scaffold.workspaceId, issueId });
    const admissions = new Map<string, ContentIssueAdmission>();
    const lookupSessionsForTask = centralLearningTaskSessions(ctx, scaffold.workspaceId);
    // Register domain executors against the same turn authorization and source context.
    const ports: CentralLearningExecutionPort[] = [];
    const context = scaffold.centralLearningContextForIssue === undefined ? {} : { contextForIssue: scaffold.centralLearningContextForIssue };

    if (dependencies.learning !== undefined) ports.push(createCentralMethodExecutor({ boardRoot, scope,
      workspaceId: scaffold.workspaceId, turnId, provider: dependencies.provider, model: scaffold.model, modelRef,
      now: () => new Date(ctx.now()).toISOString(), emit: dependencies.learning.emit, authorized: enabled, ...context,
      ...(dependencies.method?.experience?.claimReview === undefined ? {} : { claimReview: () => dependencies.method!.experience!.claimReview!() }) }));

    const run = { message: [], readStdin: false, provider: scaffold.providerId, model: scaffold.model, endpoint: scaffold.endpoint,
      ...(scaffold.reasoningEffort === undefined ? {} : { reasoningEffort: scaffold.reasoningEffort }),
      ...options.permissionChoice };

    ports.push(createCentralToolExecutor({ boardRoot, scope: scaffold.workspaceId, centralScope: scope,
      now: ctx.now, authorized: enabled, modelRef, mode: "after_turn",
      ...context, contextServices: toolResearchServices(ctx, { boardRoot, scope: scaffold.workspaceId, run }),
      run: (jobId, managedBinding, signal) => runToolCycle({ ...ctx, cwd: scope }, { boardRoot, scope: scaffold.workspaceId,
        centralScope: scope, run, mode: "after_turn", jobIds: [jobId], maxJobs: 1, managedBinding, signal,
        frozenModel: { provider: dependencies.provider.fork?.([]) ?? dependencies.provider, model: scaffold.model } }) }));

    if (scaffold.workflowCentralExecution !== undefined) ports.push(scaffold.workflowCentralExecution);

    if (scaffold.collaborationLearning !== "off") ports.push(createCentralCollaborationExecution({ boardRoot, scope,
      enabled, control: dependencies.collaboration.control, admitSource: dependencies.collaboration.admitLearningSource,
      modelRef,
      sourceCondition: dependencies.collaboration.sourceCondition, ...context }));

    if (hermes !== undefined) ports.push(createCentralSkillExecution({ board: createBoardReader(boardRoot), boardRoot, scope, runtime: hermes }));

    // Admission binds source material before the controller can dispatch funded work.
    const controller = createCentralLearningHost({ boardRoot, scope, allowance, ports, enabled,
      ...(scaffold.centralLearningOnlyIssueId === undefined ? {} : { onlyIssueId: scaffold.centralLearningOnlyIssueId }),
      authorizationRef: `central-run-authorization:${contentHashOf({ scope, allowance })}`,

      async admit(issueId, signal) {
        const admission = await contentAdmissionForIssue({ boardRoot, scope, issueId, enabled, domainFeedback, signal,
          ...(scaffold.session === undefined ? {} : { sessionSource: { session: scaffold.session, sessionId: scaffold.sessionId,
            secrets: scaffold.apiKey === undefined ? [] : [scaffold.apiKey] } }) });
        if (admission.status === "ready") return { status: "ready" };
        admissions.set(issueId, admission);
        return { status: "blocked", reason: admission.reason, sourceRefs: admission.sourceRefs };
      },

      now: () => new Date(ctx.now()).toISOString(), control: dependencies.collaboration.control });
    const nominateAtExplicitBoundary = async (signal: AbortSignal) => {
      signal.throwIfAborted();

      // The independent owner's source snapshot already nominates all domains.
      // Normal PA inspection reads its committed prefix instead of repeating that
      // work before each business request. Selected-issue mode retains its host.
      if (independent && scaffold.centralLearningOnlyIssueId === undefined) return;

      try { await controller.nominate(signal); }
      catch (error) {
        signal.throwIfAborted();
        throw error;
      }

      signal.throwIfAborted();
    };
    const runController = async (signal: AbortSignal, issueId?: string): Promise<CentralLearningRunResult> => {
      admissions.clear();
      const result = await controller.run(signal, issueId);
      const next = [...admissions.values()].find(row => row.status === "needs_content");
      const contentRequests = next === undefined || signal.aborted ? [] : [await begin(next.issueId, signal)];
      const detailed: CentralLearningRunResult = admissions.size === 0 ? result : result.status === "dispatched"
        ? { ...result, contentRequests } : { status: "waiting_content", decisionResult: result,
          contentRequests, admissions: [...admissions.values()] };

      scaffold.onCentralLearningResult?.(detailed);

      return detailed;
    };
    const content = new Map<CentralLearningAgentDomain, ReturnType<typeof createNormalTaskContentRuntime>>();
    const staged = new Map<CentralLearningAgentDomain, ReturnType<typeof createStagedContentSession>>();
    const sourceFor = (domain: CentralLearningAgentDomain) => {
      let source = content.get(domain);
      if (source === undefined) {
        if (scaffold.session === undefined) throw new Error("central_learning_requires_durable_session");

        source = createNormalTaskContentRuntime({ boardRoot, scope, domain, session: scaffold.session,
          sessionId: scaffold.sessionId, turnId, enabled, now: ctx.now,
          lookupSession: centralLearningSessionLookup(ctx),
          lookupSessionsForTask,
          domainFeedback,
          secrets: scaffold.apiKey === undefined ? [] : [scaffold.apiKey], excludeToolNames: CENTRAL_LEARNING_CONTROL_TOOLS });
        content.set(domain, source);
      }

      return source;
    };
    const stagesFor = (domain: CentralLearningAgentDomain) => {
      let session = staged.get(domain);
      if (session === undefined) {
        session = createStagedContentSession({ runtime: sourceFor(domain), enabled,
          secrets: scaffold.apiKey === undefined ? [] : [scaffold.apiKey] });
        staged.set(domain, session);
      }

      return session;
    };
    const refreshAdvisoryFeedback = async (signal: AbortSignal) => {
      const feedback = await sourceFor("collaboration").refreshAdvisoryFeedback(signal);
      if (independent && feedback.sourceRefs.length > 0) {
        await wakeCentralFromPersonalAgent(options.runtime, { reason: "personal_agent_advisory_feedback",
          sourceRefs: [...new Set([...feedback.sourceRefs, ...(feedback.status === "saved" ? feedback.intentRefs : [])])].slice(0, 32) }, signal);
      }
      return feedback;
    };
    const domainOf = async (issueId: string) => {
      if (scaffold.centralLearningOnlyIssueId !== undefined && issueId !== scaffold.centralLearningOnlyIssueId) {
        throw new Error("central_learning_source_issue_mismatch");
      }

      const loaded = await createBoardReader(boardRoot).load();
      if (!loaded.ok) throw new Error(loaded.reason);

      const issue = loaded.state.learningIssues?.find(row => row.issueId === issueId && row.scope === scope);
      if (issue === undefined) throw new Error("learning_issue_not_found");

      const owner = learningIssueOwner(issue), domain = owner === "method" ? "prompt" : owner;
      if (domain === "ambiguous" || !ports.some(port => port.domain === domain)) throw new Error("central_learning_domain_unavailable");

      return domain;
    };
    const begin = async (issueId: string, signal: AbortSignal) => {
      const domain = await domainOf(issueId);
      return { domain, ...await stagesFor(domain).begin({ issueId, maximumPromptChars: allowance.maxPromptChars }, signal) };
    };
    const runtime: Omit<CentralLearningTurnRuntime, "tools" | "wrapControlTools"> = {
      personalAgentInstruction: independent ? INDEPENDENT_CENTRAL_LEARNING_INSTRUCTION : CENTRAL_LEARNING_INSTRUCTION,

      async focus(input, signal) {
        if (independent) {
          if (options.runtime === undefined) return { ok: false, reason: "runtime_unavailable" };

          const status = await options.runtime.status(signal);
          if (!status.ok) return status;

          const primaryRoot = (scaffold.workspaceIdentity ?? ctx.workspaceIdentity)?.workspaceRoot ?? scope;
          const expectedScopeKey = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), primaryRoot).scopeKey;
          if (status.snapshot.scopeKey !== expectedScopeKey) return { ok: false, reason: "runtime_scope_mismatch" };

          if (status.snapshot.state === "stopping" || status.snapshot.state === "stopped") return { ok: false, reason: "runtime_stopping" };

          if (status.snapshot.state === "failed") return { ok: false, reason: status.snapshot.reason ?? "runtime_failed" };
        }

        await domainOf(input.issueId);

        if (!independent) {
          const budget = await controller.inspect();
          if (!budget.ok) return { ok: false, reason: budget.reason };
        }

        const focused = await controller.focusIssue(input, signal);
        if (!focused.ok) return focused;

        if (independent) return wake("personal_agent_focus", signal, input.issueId);

        const central = await begin(input.issueId, signal);

        return { ok: true, status: "idle", issueId: input.issueId, central };
      },

      resume: async signal => independent ? wake("personal_agent_resume", signal) : reply(await runController(signal)),
      async beforeInspect() { await nominateAtExplicitBoundary(options.signal ?? new AbortController().signal); },

      async beforeTask(provider, signal) {
        await refreshAdvisoryFeedback(signal);

        if (!independent) {
          const budget = await controller.inspect();
          if (!budget.ok) throw new Error(budget.reason);
          await controller.refresh(signal);
        }

        await nominateAtExplicitBoundary(signal);

        // The normal loop journals its current human input after turn_start.
        // Resolve references at the original provider send boundary, where that
        // input is durable; retain the producer's normal delivery receipt.
        return sourceFor("collaboration").withAutomaticReferences(provider, allowance.maxPromptChars);
      },

      async afterTask(signal) {
        if (signal.aborted) return;
        await refreshAdvisoryFeedback(signal);
        if (scaffold.centralLearningOnlyIssueId === undefined) await hermes?.reportTask({ sessionId: scaffold.sessionId, turnId });
        await nominateAtExplicitBoundary(signal);
      },

      async command(args, signal, toolCallId) {
        if (args.operation === "inspect") {
          if (!independent) return controller.inspect();
          const owner = await options.runtime?.status(signal) ?? { ok: false, reason: "central_runtime_unavailable" };
          const ownerObservedAt = new Date(ctx.now()).toISOString();
          const learning = await readCentralRuntimeOverviewFor(ctx, scaffold.workspaceIdentity?.workspaceRoot ?? scope,
            { signal, secrets: scaffold.apiKey === undefined ? [] : [scaffold.apiKey] });
          return { ...owner, ownerObservedAt, learning, consistency: "owner_then_checkpoint_separate_observations" };
        }

        if (args.operation === "resume") return independent ? wake("personal_agent_resume", signal) : runController(signal);

        if (args.operation === "read_advisory" && typeof args.ref === "string" && typeof args.version === "string") {
          return sourceFor("collaboration").readAdvisory({ ref: args.ref, version: args.version,
            ...(typeof args.start === "number" ? { start: args.start } : {}),
            ...(typeof args.maximumChars === "number" ? { maximumChars: args.maximumChars } : {}) }, signal);
        }

        // Advisory addresses retain their own frozen source and real read
        // evidence even through the legacy generic material-read operation.
        if (args.operation === "read_material" && typeof args.evidenceRef === "string"
          && (args.evidenceRef.startsWith(CENTRAL_ADVISORY_ID_PREFIX) || args.evidenceRef.startsWith(CENTRAL_ADVISORY_PUBLICATION_PREFIX))) {
          return sourceFor("collaboration").readAdvisory({ ref: args.evidenceRef,
            ...(typeof args.version === "string" ? { version: args.version } : {}),
            ...(typeof args.start === "number" ? { start: args.start } : {}),
            ...(typeof args.maximumChars === "number" ? { maximumChars: args.maximumChars } : {}) }, signal);
        }

        if (args.operation === "report_advisory_use" && typeof args.ref === "string" && typeof args.version === "string"
          && typeof args.change === "string" && typeof args.reason === "string" && toolCallId !== undefined) {
          const reported = await sourceFor("collaboration").reportAdvisory({ toolCallId, ref: args.ref, version: args.version,
            change: args.change, reason: args.reason }, signal);
          return reported.status !== "recorded" ? reported : { ...reported, feedback: await refreshAdvisoryFeedback(signal) };
        }

        if (args.operation === "begin_content" && typeof args.issueId === "string") return begin(args.issueId, signal);

        const domain = args.domain;
        if (domain !== "prompt" && domain !== "tool" && domain !== "workflow" && domain !== "collaboration" && domain !== "skill") {
          return { status: "rejected", reason: "central_content_domain_required" };
        }

        const stage = stagesFor(domain);

        if (typeof args.stageRef !== "string") return { status: "rejected", reason: "central_content_stage_required" };

        if (args.operation === "read_material" && typeof args.evidenceRef === "string") return stage.readMaterial({
          stageRef: args.stageRef, evidenceRef: args.evidenceRef,
          ...(typeof args.start !== "number" ? {} : { start: args.start }),
          ...(typeof args.maximumChars !== "number" ? {} : { maximumChars: args.maximumChars }) }, signal);

        if (typeof args.inputHash !== "string") return { status: "rejected", reason: "central_content_input_hash_required" };

        if (args.operation === "apply_known" && typeof args.applicationJson === "string") return { domain,
          ...await stage.applyKnown({ stageRef: args.stageRef, inputHash: args.inputHash, applicationJson: args.applicationJson }, signal) };

        if (args.operation === "residual_review" && typeof args.reviewJson === "string") {
          const published = await stage.review({ stageRef: args.stageRef, inputHash: args.inputHash, reviewJson: args.reviewJson }, signal);
          if (published.status === "published" && published.issueId !== undefined
            && published.recommendation.kind !== "end" && (published.remaining.length > 0 || published.recommendation.kind === "continue")) {
            return { content: published, central: independent ? await wake("personal_agent_content_published", signal, published.issueId)
              : await runController(signal, published.issueId) };
          }

          return { content: published };
        }

        return { status: "rejected", reason: "central_learning_arguments_invalid" };
      },

      async close() { open = false; },
    };

    return { ...runtime, ...centralLearningTools(runtime, { independent }) };
  };
}
