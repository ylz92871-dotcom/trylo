import { contentHashOf } from "../../../../control/hash.js";
import type { CentralLearningAllowance } from "../../../../control/coordination-contract.js";
import type { FocusedLearningDispatch, FocusedLearningPort } from "../../../../control/focused-learning-port.js";
import type { createCollaborationControl } from "../control/index.js";
import { learningIssueOwner, learningIssueFocusRequired, type FocusedLearningDomain } from "./focus-owner.js";
import { personalAgentInspectionState } from "./inspection-state.js";

export type PersonalAgentCollaborationOptions = {
  readonly control: ReturnType<typeof createCollaborationControl>; readonly scope: string;
  readonly legacyMethodScope?: string;
  readonly turnId: string; readonly allowance: CentralLearningAllowance;
  readonly currentResources: (input?: PersonalAgentInspectionInput) => Promise<{ readonly view: unknown; readonly revision: string }>;
  readonly skillLearning?: PersonalAgentSkillLearning;
  readonly focusedLearning?: Partial<Readonly<Record<FocusedLearningDomain, PersonalAgentFocusedLearning>>>;
  /** A host-mounted unified allocator supersedes independent domain purses. */
  readonly centralLearning?: FocusedLearningPort;
  readonly beforeInspect?: () => Promise<void>;
};

export type PersonalAgentInspectionInput = { readonly issueId?: string; readonly followUpAfterReceiptId?: string };

export const isPersonalAgentInspectionReference = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= 512 && !value.includes("\0");

export type PersonalAgentDecision = {
  readonly inspectionId: string; readonly issueId: string; readonly expectedRevision: number;
  readonly decision: "resolved" | "ordinary_execution" | "focused_learning";
  readonly reason: string; readonly sourceRefs: readonly string[];
};

/** The host mounts the skill owner's independently funded route; PA cannot choose its worker or allowance. */
export type PersonalAgentFocusedLearning = FocusedLearningPort;

export type PersonalAgentSkillLearning = PersonalAgentFocusedLearning;

type ControlReadState = Extract<Awaited<ReturnType<PersonalAgentCollaborationOptions["control"]["read"]>>, { readonly ok: true }>;

/** Keep exact selected issue facts and their current rows. With no selection, retain the original full issue view. */
function inspectionProjection(state: ControlReadState, issueId?: string) {
  const issues = issueId === undefined ? state.issues : state.issues.filter(issue => issue.issueId === issueId);
  const jobIds = new Set(issues.map(issue => issue.jobId)), grantIds = new Set(issues.map(issue => issue.grantId));
  const jobs = state.jobs.filter(job => jobIds.has(job.jobId)), grants = state.grants.filter(grant => grantIds.has(grant.grantId));
  const dependencies = state.dependencies.filter(dependency => issues.some(issue => issue.issueId === dependency.issueId
    && issue.jobId === dependency.jobId && issue.grantId === dependency.grantId));
  const hiddenJobs = state.jobs.length - jobs.length, hiddenGrants = state.grants.length - grants.length,
    hiddenDependencies = state.dependencies.length - dependencies.length;

  return { state: { ...state, issues, jobs, grants, dependencies },
    ...(issueId === undefined && hiddenJobs + hiddenGrants + hiddenDependencies === 0 ? {} : {
      historySummary: { ...(issueId === undefined ? {} : { hiddenIssues: state.issues.length - issues.length }),
        hiddenJobs, hiddenGrants, hiddenDependencies, detailSource: "control.read" as const },
    }) };
}

/** The normal parent is Personal Agent. This service records its decisions; it performs no additional triage model call. */
export function createPersonalAgentCollaboration(options: PersonalAgentCollaborationOptions) {
  const route = (domain: FocusedLearningDomain) => options.focusedLearning?.[domain] ?? (domain === "skill" ? options.skillLearning : undefined);
  // A decision rechecks the same view that PA inspected, including full-view
  // callers. Keep selectors only; current facts and resources are read afresh.
  const inspectedViews = new Map<string, PersonalAgentInspectionInput | undefined>();
  const inspect = async (input?: PersonalAgentInspectionInput) => {
    if (input?.issueId !== undefined && !isPersonalAgentInspectionReference(input.issueId)) {
      return { ok: false as const, reason: "invalid_learning_coordination" };
    }

    await options.beforeInspect?.();
    const state = await personalAgentInspectionState(options.control, options.scope, options.legacyMethodScope);
    if (!state.ok) return state;

    if (input?.issueId !== undefined && !state.issues.some(issue => issue.issueId === input.issueId)) {
      return { ok: false as const, reason: "learning_issue_not_found" };
    }

    const resources = await options.currentResources(input);
    const projection = inspectionProjection(state, input?.issueId);
    const inspectionId = `collaboration-inspection:${contentHashOf({ selection: input?.issueId ?? null,
      state: projection.state, resourceRevision: resources.revision })}`;

    inspectedViews.set(inspectionId, input === undefined ? undefined : { ...input });

    return { ok: true as const, inspectionId, ...projection, resources: resources.view,
      learningRoutes: projection.state.issues.map(issue => {
        const owner = learningIssueOwner(issue);
        return { issueId: issue.issueId, owner, focusTool: "collaboration_decide", resumeTool: "collaboration_resume",
          mounted: owner !== "ambiguous" && (options.centralLearning !== undefined || owner === "collaboration" || route(owner) !== undefined),
          ...(options.centralLearning === undefined ? {} : { funding: "shared_central_pool" as const,
            preparationTool: "central_learning" as const }) };
      }) };
  };

  return {
    inspect,
    report: options.control.report,
    async decide(input: PersonalAgentDecision, signal: AbortSignal) {
      const knownView = inspectedViews.has(input.inspectionId), inspected = inspectedViews.get(input.inspectionId);
      if (knownView && inspected?.issueId !== undefined && inspected.issueId !== input.issueId) {
        return { ok: false as const, reason: "collaboration_state_changed_inspect_again" };
      }

      let latest = await inspect(knownView ? inspected : { issueId: input.issueId });

      // Hash-based inspection references can cross service lifetimes. Accept a
      // still-current full view too, without trusting an old selector or facts.
      if (!knownView && latest.ok && latest.inspectionId !== input.inspectionId) latest = await inspect();

      if (!latest.ok) return latest;

      if (latest.inspectionId !== input.inspectionId) return { ok: false as const, reason: "collaboration_state_changed_inspect_again" };

      const issue = latest.state.issues.find(i => i.issueId === input.issueId && (i.scope === options.scope
        || i.scope === options.legacyMethodScope && learningIssueOwner(i) === "method"));
      if (!issue || issue.revision !== input.expectedRevision) return { ok: false as const, reason: "learning_issue_conflict" };

      const owner = learningIssueOwner(issue);

      if (input.decision === "focused_learning" && options.centralLearning !== undefined) {
        if (owner === "ambiguous") return { ok: false as const, reason: learningIssueFocusRequired(owner) };
        return options.centralLearning.focus({ issueId: input.issueId, expectedRevision: input.expectedRevision,
          reason: input.reason, sourceRefs: input.sourceRefs }, signal);
      }

      if (input.decision === "focused_learning" && owner !== "collaboration") {
        if (signal.aborted) return { ok: false as const, reason: "learning_aborted" };
        const selected = owner === "ambiguous" ? undefined : route(owner);
        return selected ? selected.focus({ issueId: input.issueId, expectedRevision: input.expectedRevision,
          reason: input.reason, sourceRefs: input.sourceRefs }, signal)
          : { ok: false as const, reason: learningIssueFocusRequired(owner) };
      }

      const decided = await options.control.decide({ issueId: input.issueId, expectedRevision: input.expectedRevision,
        decision: input.decision, reason: input.reason, sourceRefs: input.sourceRefs });
      if (!decided.ok || input.decision !== "focused_learning") return decided;

      // One host allowance per invocation, not a fresh purse on every model-selected issue or retry.
      const funded = await options.control.fund({ issueId: decided.issue.issueId, expectedRevision: decided.issue.revision,
        grantId: `personal-agent-collaboration:${contentHashOf([options.scope, options.turnId])}`, allowance: options.allowance });
      if (!funded.ok) return funded;

      return options.control.dispatch({ scope: options.scope, issueId: decided.issue.issueId, signal });
    },
    async resume(signal: AbortSignal) {
      if (options.centralLearning !== undefined) return options.centralLearning.resume(signal);

      let result: FocusedLearningDispatch = await options.control.dispatch({ scope: options.scope, signal });
      let waiting: typeof result | undefined;

      for (const domain of ["method", "tool", "workflow", "skill"] as const) {
        if (!result.ok || signal.aborted) return signal.aborted ? { ok: false as const, reason: "learning_aborted" } : result;

        // A dispatch carrying a result ran work in this invocation. Existing
        // leases/dependencies carry no result and cannot starve another owner.
        if (result.status !== "idle" && ((result.status !== "busy" && result.status !== "waiting_dependency") || result.result !== undefined)) return result;

        if (result.status !== "idle") waiting ??= result;

        const selected = route(domain);
        if (selected) {
          result = await selected.resume(signal);
          if (result.workAttempted) return result;
        }
      }

      return result.ok && result.status === "idle" ? waiting ?? result : result;
    },
  };
}
