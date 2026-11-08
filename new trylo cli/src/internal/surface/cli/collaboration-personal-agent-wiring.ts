import { randomUUID } from "node:crypto";
import { createFileCollaborationBoard, createCollaborationObjectiveObservations, createCollaborationResearchRecovery, createCollaborationMemberReporter } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { createCollaborationControl, collaborationTimingFor, collaborationSourceAdmission, collaborationSourceCondition,
  type CollaborationConditionHost, type CollaborationCentralWorker } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { collaborationTrialHistory, experienceResponsibilities, createCollaborationExperienceStore, createExpertExperiencePort, type PrepareExperienceInput, type PublishExperienceInput } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import { isCollaborationExperienceContent } from "../../learning/agent/subsystems/collaboration/experience/schema.js";
import { createCollaborationRuntimeReceiptWriter } from "../../learning/agent/subsystems/collaboration/runtime/receipts/index.js";
import { createCollaborationWorker } from "../../learning/agent/subsystems/collaboration/orchestration/index.js";
import { createCollaborationDecisionModel } from "../../learning/agent/subsystems/collaboration/runtime/decision-model.js";
import { createPersonalAgentCollaboration } from "../../learning/agent/subsystems/collaboration/personal-agent/service.js";
import { collaborationFollowUp, collaborationPlanProjection, projectIssueResources, learningIssueOwner,
  learningIssueFocusRequired } from "../../learning/agent/subsystems/collaboration/personal-agent/index.js";
import type { PersonalAgentInspectionInput, PersonalAgentSkillLearning, PersonalAgentCollaborationOptions } from "../../learning/agent/subsystems/collaboration/personal-agent/service.js";
import { createPersonalAgentTools } from "../../learning/agent/subsystems/collaboration/runtime/personal-agent-tools.js";
import { isCollaborationRuntimeReceipt } from "../../learning/control/collaboration-runtime-parse.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralLearningAllowance } from "../../learning/control/coordination-contract.js";
import { parseExpertCommand, type ExpertIdentity } from "../../subagent/experts/index.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { SubagentTeam } from "../../subagent/team.js";
import type { CollaborationCapabilitiesOptions } from "./collaboration-capabilities.js";
import { createCollaborationCapabilities } from "./collaboration-capabilities.js";
import { collaborationResources } from "./collaboration-learning-resources.js";
import { collaborationDependencies } from "./collaboration-dependencies.js";
import { createCollaborationExecution } from "./collaboration-execution.js";
import { temporaryExpertIdentityForScope } from "./collaboration-expert-owners.js";
import { createPersonalAgentProvider, type PersonalAgentProviderOptions } from "./collaboration-parent-context.js";
import { collaborationLearningContext } from "./collaboration-learning-context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { CENTRAL_LEARNING_INSTRUCTION } from "./central-learning-instruction.js";
import { tryloHome } from "./session-paths.js";
import { DEFAULT_COLLABORATION_TOKENS, type CollaborationLearningOption } from "./collaboration-options.js";

export type PersonalAgentWiringInput = { readonly choice?: CollaborationLearningOption | undefined;
  /** Explicit generation allocation from the actual learning host; omission adds no fixed ceiling. */
  readonly learningMaxOutputTokens?: number;
  readonly homeDir: string; readonly env: Readonly<Record<string, string | undefined>>; readonly scope: string;
  readonly legacyMethodScope?: string;
  readonly team?: SubagentTeam; readonly turnId: string; readonly now: () => number;
  readonly taskId?: string;
  readonly taskGoal?: string;
  readonly sourceIssueId?: string;
  readonly sourceAddress?: string;
  readonly skillLearning?: PersonalAgentSkillLearning;
  readonly focusedLearning?: PersonalAgentCollaborationOptions["focusedLearning"];
  readonly centralLearning?: PersonalAgentCollaborationOptions["centralLearning"];
  readonly readCentralLearningInstruction?: () => string | undefined;
  readonly beforeCentralInspect?: () => Promise<void>;
  readonly readSkillPending?: PersonalAgentProviderOptions["readSkillPending"];
  readonly readUserClarification?: () => ReturnType<typeof import("./user-learning-config.js").readUserLearningClarificationFor>;
  readonly signal?: AbortSignal; readonly warn: (reason: string) => void; readonly newOwnerId?: () => string };

type RuntimeOptions = PersonalAgentWiringInput & Omit<CollaborationCapabilitiesOptions,
  "homeRoot" | "boardRoot" | "scope" | "taskId" | "team" | "experience" | "now">;

/** The normal main agent is PA. Central focus is the only route from reports to paid collaboration learning. */
export function createPersonalAgentRuntime(options: RuntimeOptions) {
  let open = true;
  const enabled = () => open && (options.centralLearning !== undefined || options.choice !== "off");
  const taskId = options.taskId ?? options.team?.runId ?? options.turnId;
  const conditionTeam = options.team === undefined ? undefined : { members: options.team.members.map(member => ({ baseRole: member.baseRole,
    ...(member.expert === undefined ? {} : { expert: {} }), role: {
      ...(member.role.allowedTools === undefined ? {} : { allowedTools: [...member.role.allowedTools] }),
      ...(member.role.disallowedTools === undefined ? {} : { disallowedTools: [...member.role.disallowedTools] }) } })) };
  const sourceConditionHost: CollaborationConditionHost = { sourceRef: `collaboration-frozen-host:${contentHashOf({
    scope: options.scope, turnId: options.turnId, teamRunId: options.team?.runId ?? null,
    surface: options.team?.surface ?? "code", sourceMembers: options.team?.members ?? null, structure: conditionTeam ?? null })}`,
    surface: options.team?.surface ?? "code", ...(conditionTeam === undefined ? {} : { team: conditionTeam }) };
  const now = () => new Date(options.now()).toISOString();
  const objective = createCollaborationObjectiveObservations({ scope: options.scope, turnId: options.turnId, taskId,
    ...(options.team === undefined ? {} : { team: options.team }), ...(options.taskGoal === undefined ? {} : { goal: options.taskGoal }) });
  // Share one board across control, experience, and runtime receipts.
  const boardRoot = methodBoardRoot(options.homeDir, options.env);
  const board = createFileCollaborationBoard(boardRoot, enabled);
  const receipts = createCollaborationRuntimeReceiptWriter({ board, scope: options.scope, enabled });
  const experience = createCollaborationExperienceStore({ board, scope: options.scope, now, enabled, recordRuntimeReceipt: receipts.record });
  const capabilities = createCollaborationCapabilities({ ...options, now, boardRoot, homeRoot: tryloHome(options.homeDir, options.env),
    taskId, experience: createExpertExperiencePort({ store: experience,
      contextFor: () => ({ surface: options.team?.surface ?? "code", useScope: { workspaceId: options.scope, taskId } }) }) });
  const execution = createCollaborationExecution({ ...options, now, taskId, capabilities, experience, enabled, objective });
  let worker: CollaborationCentralWorker | undefined;
  const control = createCollaborationControl({ board, now, enabled, ownerId: (options.newOwnerId ?? randomUUID)(),
    worker: { run: input => {
      const owner = learningIssueOwner(input.issue);
      if (owner !== "collaboration") {
        return Promise.resolve({ kind: "failed", reason: learningIssueFocusRequired(owner) });
      }

      const source = collaborationSourceAdmission(input.issue, {
        ...(options.sourceIssueId === undefined ? {} : { sourceIssueId: options.sourceIssueId }),
        ...(options.team === undefined ? {} : { currentTeamRunId: options.team.runId }) });
      if (source.status !== "ready") return Promise.resolve({ kind: "cancelled", reason: source.reason });

      return worker ? worker.run(input) : Promise.resolve({ kind: "failed", reason: "learning_worker_unavailable" });
    } } });
  const dependencies = collaborationDependencies({ scope: options.scope, taskId, board, control, capabilities });
  const memberContext = (member: SubagentTeam["members"][number]): NonNullable<PrepareExperienceInput["context"]> => ({ surface: options.team?.surface ?? "code",
    useScope: { workspaceId: options.scope, taskId }, responsibilities: execution.responsibilityContext(member.memberId)?.responsibilities
      ?? experienceResponsibilities([member.role.description, member.baseRole]) });
  // Resolve experience ownership from the current team and its actual expert identities.
  const owners = async (issueId?: string) => {
    const result: { ref: string; input: PrepareExperienceInput; identity?: ExpertIdentity }[] = [{ ref: "personal_agent",
      input: { owner: { kind: "personal_agent", experienceKey: "trylo.personal_agent.v1" }, maxChars: 600,
        context: { surface: options.team?.surface ?? "code", useScope: { workspaceId: options.scope, taskId } } } }];

    for (const member of options.team?.members ?? []) {
      const observedIdentity = execution.identities().get(member.memberId);
      if (member.expert || observedIdentity) {
        const selection = member.expert;
        const saved = selection && "expertId" in selection ? capabilities.expertHost.library.get(selection.expertId, selection.version) : undefined;
        const request = selection && "requestId" in selection ? capabilities.expertHost.library.requests().find(item => item.requestId === selection.requestId) : undefined;
        const identity: ExpertIdentity | undefined = observedIdentity ?? (saved ? { expertId: saved.expertId, version: saved.version, experienceKey: saved.experienceKey }
          : temporaryExpertIdentityForScope(request, { workspaceId: options.scope, taskId }));
        if (identity) result.push({ ref: `member:${member.memberId}`, identity, input: { owner: { kind: "expert", experienceKey: identity.experienceKey },
          expertVersion: identity.version, ...(identity.draft === undefined ? {} : { expertDraft: identity.draft }), maxChars: 600,
          context: memberContext(member) } });
      } else if (options.team?.profileId) result.push({ ref: `member:${member.memberId}`, input: {
        owner: { kind: "legacy_member", workspace: options.scope, profileId: options.team.profileId, memberId: member.memberId },
        maxChars: 600, context: memberContext(member) } });
    }

    for (const request of capabilities.expertHost.library.requests()) {
      const identity = temporaryExpertIdentityForScope(request, { workspaceId: options.scope, taskId });
      if (!issueId || request.association?.issueId !== issueId || !identity) continue;
      result.push({ ref: `expert-request:${request.requestId}`, identity,
        input: { owner: { kind: "expert", experienceKey: identity.experienceKey }, expertVersion: identity.version,
          expertDraft: identity.draft!, maxChars: 600,
          context: { surface: options.team?.surface ?? "code", useScope: { workspaceId: options.scope, taskId } } } });
    }

    return result;
  };
  const currentResources = async (input?: PersonalAgentInspectionInput) => {
    const state = await board.load();
    const planProjection = state.ok ? collaborationPlanProjection(state.state, { scope: options.scope,
      ...(input?.issueId === undefined ? {} : { issueId: input.issueId }) }) : undefined;
    const experts = capabilities.expertHost.library.query().slice(0, 24).map(expert => ({ ...expert,
      configurationRef: execution.reference({ expertId: expert.expertId, version: expert.version }) }));
    const view = { team: options.team ? { runId: options.team.runId, profileId: options.team.profileId, configurationBasis: "frozen_team_profile",
      members: options.team.members.map(m => ({ memberId: m.memberId, baseRole: m.baseRole, role: m.role,
        lastPreparedBoundary: execution.responsibilityContext(m.memberId),
        ...(m.expert === undefined ? {} : { expert: m.expert, configurationRef: execution.reference(m.expert, m.memberId) }) })) } : undefined,
      owners: await owners(), experts, expertRequests: capabilities.expertHost.library.requests().slice(-16).map(request => ({ ...request,
        configurationRef: execution.reference({ requestId: request.requestId }) })),
      tools: await capabilities.toolLibrary.query({ memberId: "personal_agent", scope: options.scope }, { limit: 24 }),
      plans: planProjection?.items ?? [],
      planSummary: planProjection?.summary ?? { status: "unavailable", reason: state.ok ? "plan_view_unavailable" : state.reason },
      receipts: state.ok ? state.state.collaborationRuntimeReceipts?.filter(r => r.scope === options.scope).slice(-24) : [],
      followUp: state.ok ? collaborationFollowUp(state.state, { scope: options.scope, currentTaskId: taskId,
        limit: 2,
        ...(options.team === undefined ? {} : { currentTeamRunId: options.team.runId }),
        ...(input?.issueId === undefined ? {} : { issueId: input.issueId }),
        ...(input?.followUpAfterReceiptId === undefined ? {} : { afterReceiptId: input.followUpAfterReceiptId }) }) : { unavailable: state.reason },
      objective: objective.inspectionView(),
      objectiveRevision: objective.decisionRevision(),
    };
    // Cursor and optional issue views select detail, not a new resource revision. PA's own exposure cannot invalidate its decision.
    const { receipts: _receipts, followUp: _followUp, objective: _objective, plans: _plans, planSummary: _planSummary, ...decisionResources } = view;

    return { view: input?.issueId === undefined ? view : projectIssueResources(view, input.issueId),
      revision: contentHashOf({ ...decisionResources, planVersionIds: planProjection?.eligibleVersionIds ?? { unavailable: state.ok ? "plan_view_unavailable" : state.reason } }) };
  };

  worker = createCollaborationWorker({ board, scope: options.scope, now, enabled,
    model: createCollaborationDecisionModel({ provider: options.learningProvider ?? options.provider, model: options.model, enabled,
      ...(options.learningMaxOutputTokens === undefined ? {} : { maxOutputTokens: options.learningMaxOutputTokens }) }),
    recoverResearch: createCollaborationResearchRecovery({ board, scope: options.scope, enabled }),
    resources: collaborationResources({ capabilities, experience, owners, record: receipts.record, now,
      ...(options.team === undefined ? {} : { currentTeamRunId: options.team.runId }) }),

    context: async issueId => {
      const state = await control.read(options.scope);
      if (!state.ok) return { unavailable: state.reason };

      const issue = state.issues.find(item => item.issueId === issueId);
      if (!issue) return { unavailable: "learning_issue_not_found" };

      const loaded = await board.load();

      return collaborationLearningContext({ issue, ...(options.team === undefined ? {} : { team: options.team }),
        owners: (await owners(issueId)).map(owner => ({ ref: owner.ref, owner: owner.input.owner, identity: owner.identity,
          retrievalContext: owner.input.context })),
        dependencies: state.dependencies.filter(d => d.issueId === issueId), progress: objective.recentFacts(),
        objective: objective.inspectionView(),
        ...(loaded.ok ? { trialHistory: collaborationTrialHistory(loaded.state, { scope: options.scope, issueId }) }
          : { trialHistory: { unavailable: loaded.reason } }) });
    }, prepareDependencies: dependencies.prepare,

    async experienceInput(issueId, draft) {
      let owner = (await owners(issueId)).find(item => item.ref === draft.ownerRef);
      if (!owner) {
        const ref = /^expert:(.+)@(\d+)$/.exec(draft.ownerRef);
        const saved = ref ? capabilities.expertHost.library.get(ref[1]!, Number(ref[2])) : undefined;
        if (saved) owner = { ref: draft.ownerRef, identity: { expertId: saved.expertId, version: saved.version, experienceKey: saved.experienceKey },
          input: { owner: { kind: "expert", experienceKey: saved.experienceKey }, expertVersion: saved.version, maxChars: 600 } };
      }

      if (!owner) return { ok: false, reason: "experience_owner_unknown" };

      const input: PublishExperienceInput = { issueId, owner: owner.input.owner, familyId: draft.familyId,
        situation: draft.situation, responsibilities: draft.responsibilities, practice: draft.practice, sourceRefs: draft.sourceRefs,
        ...(draft.evaluation === undefined ? {} : { evaluation: draft.evaluation }),
        ...(draft.expertVersion === undefined ? {} : { expertVersion: draft.expertVersion }),
        ...(draft.parentVersion === undefined ? {} : { parentVersion: draft.parentVersion }),
        ...(owner.identity === undefined ? {} : { expertIdentity: owner.identity }),
        conditions: { ...draft.conditions, ...(owner.identity?.draft === undefined ? {} : {
          expertDraft: owner.identity.draft, useScope: { workspaceId: options.scope, taskId } }) } };

      return { ok: true, input };
    }, preflightExperience: experience.preflightExperience, publishExperience: experience.publishExperience });
  const allowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: typeof options.choice === "number" ? options.choice : DEFAULT_COLLABORATION_TOKENS,
    maxCalls: 4, maxSteps: 4, maxPromptChars: 40000 };
  const service = createPersonalAgentCollaboration({ control, scope: options.scope, turnId: options.turnId,
    ...(options.legacyMethodScope === undefined ? {} : { legacyMethodScope: options.legacyMethodScope }),
    currentResources,
    ...(options.skillLearning === undefined ? {} : { skillLearning: options.skillLearning }),
    ...(options.focusedLearning === undefined ? {} : { focusedLearning: options.focusedLearning }),
    ...(options.centralLearning === undefined ? {} : { centralLearning: options.centralLearning }),
    ...(options.beforeCentralInspect === undefined ? {} : { beforeInspect: options.beforeCentralInspect }),
    allowance });
  const tools = createPersonalAgentTools({ service, scope: options.scope, turnId: options.turnId, taskId,
    ...(options.sourceAddress === undefined ? {} : { sourceAddress: options.sourceAddress }),
    learningToolTimeoutMs: collaborationTimingFor(allowance.maxCalls).toolTimeoutMs,
    ...(options.team === undefined ? {} : { teamRunId: options.team.runId }), capability: dependencies.request,

    async library(owner, raw, signal) {
      if (owner === "tool") return capabilities.executeTool("personal_agent", raw, signal);

      const command = parseExpertCommand(raw);
      if (command.operation === "build" || command.operation === "submit" || command.operation === "authorize_creation") {
        return { ok: false, reason: "expert_creation_requires_central_capability_request",
          next: "Report the planning or coordination gap, focus it, then use collaboration_capability on the resulting dependency. Central dispatch owns its original construction allowance." };
      }

      return capabilities.expertHost.execute(command, { signal, useScope: { workspaceId: options.scope, taskId } });
    },

    async feedback(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "feedback_invalid" };

      const prior = await board.load();
      if (!prior.ok) return prior;

      const supplied = raw as Record<string, unknown>;
      const previous = prior.state.collaborationRuntimeReceipts?.find(item => item.receiptId === supplied.receiptId);
      const value: unknown = { ...raw, schemaVersion: 1, phase: "use_feedback", scope: options.scope, recordedAt: previous?.recordedAt ?? now() };
      if (!isCollaborationRuntimeReceipt(value) || value.phase !== "use_feedback") return { ok: false, reason: "feedback_invalid" };

      const recorded = await receipts.record(value);
      if (!recorded.ok) return recorded;

      const loaded = await board.load();
      if (!loaded.ok) return loaded;

      const issueIds = new Set(loaded.state.assets.flatMap(asset => asset.scope === options.scope && value.versionIds.includes(asset.versionId)
        && isCollaborationExperienceContent(asset.content) ? [asset.content.issueId] : []));

      for (const issueId of issueIds) {
        const latest = await control.read(options.scope);
        if (!latest.ok) return latest;

        const issue = latest.issues.find(item => item.issueId === issueId);
        if (!issue) continue;

        const reportId = `use-feedback-report:${contentHashOf([value.receiptId, issueId])}`;
        if (issue.reports.some(report => report.reportId === reportId)) continue;

        // Immutable use facts append independently; only PA decisions/funding own revision-sensitive judgment.
        const appended = await control.report({ scope: options.scope, problemKey: issue.problemKey, issueId,
          report: { reportId,
            source: { teamRunId: options.team?.runId ?? options.turnId, taskId, memberId: "personal_agent" },
            facts: [`PA attributed use feedback (${value.outcome}): ${value.summary}`.slice(0, 1500)], hypotheses: [],
            evidenceRefs: [value.receiptId, ...value.sourceRefs.slice(0, 31)] } });
        if (!appended.ok) return appended;
      }

      return { ok: true, feedbackRef: value.receiptId, appendedIssueIds: [...issueIds] };
    } });
  const onMemberCollaborationReport = createCollaborationMemberReporter({ control, scope: options.scope, turnId: options.turnId, enabled, warn: options.warn });

  return { tools, control, capabilities, experience, member: execution.member, memberConfigurations: execution.memberConfigurations,
    admitLearningSource: (issue: import("../../learning/control/coordination-contract.js").LearningIssue) => collaborationSourceAdmission(issue, {
      ...(options.sourceIssueId === undefined ? {} : { sourceIssueId: options.sourceIssueId }),
      ...(options.team === undefined ? {} : { currentTeamRunId: options.team.runId }) }),
    sourceCondition: (issue: import("../../learning/control/coordination-contract.js").LearningIssue) => collaborationSourceCondition(issue, sourceConditionHost),

    async learn(allowance: CentralLearningAllowance | undefined, signal: AbortSignal) {
      const current = await control.read(options.scope);
      if (!current.ok) return current;

      if (allowance !== undefined && !current.jobs.some(job => job.state === "queued" || job.state === "running")) {
        const issue = current.issues.find(item => learningIssueOwner(item) === "collaboration" && item.decision.kind === "focused_learning" && item.grantId === undefined
          && (options.sourceIssueId === undefined || item.issueId === options.sourceIssueId));
        if (issue) {
          const funded = await control.fund({ issueId: issue.issueId, expectedRevision: issue.revision,
            grantId: `independent-collaboration:${contentHashOf([options.scope, options.turnId])}`, allowance });
          if (!funded.ok) return funded;
        }
      }

      return control.dispatch({ scope: options.scope, signal, ...(options.sourceIssueId === undefined ? {} : { issueId: options.sourceIssueId }) });
    },

    onMemberCollaborationReport, wrapParentTools: execution.wrapParentTools,
    wrapProvider: (provider: RuntimeOptions["provider"]) => createPersonalAgentProvider({ provider, experience, scope: options.scope,
      turnId: options.turnId, taskId, now, warn: options.warn, inspect: service.inspect, recentFacts: objective.recentFacts, enabled,
      ...(options.centralLearning === undefined ? {} : {
        learningInstruction: options.readCentralLearningInstruction?.() ?? CENTRAL_LEARNING_INSTRUCTION }),
      ...(options.readSkillPending === undefined ? {} : { readSkillPending: options.readSkillPending }),
      ...(options.readUserClarification === undefined ? {} : { readUserClarification: options.readUserClarification }),
      surface: options.team?.surface ?? "code" }),

    capture: async (event: Envelope) => {
      if (!enabled()) return;
      objective.capture(event);
    },

    close: async () => { open = false; },
  };
}

export type PersonalAgentRuntime = ReturnType<typeof createPersonalAgentRuntime>;
