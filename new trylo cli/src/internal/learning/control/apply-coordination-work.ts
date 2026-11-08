import { learningDependencyResumable, type CoordinateLearningCommand, type LearningDependency } from "./coordination-contract.js";
import { closeCentralGrant, commitCoordination, coordinationForJob, withoutClaim } from "./coordination-state.js";
import type { BoardState } from "./state.js";
import { contentHashOf } from "./hash.js";
import { fail, replay } from "./result.js";
import { MAX_CENTRAL_LEARNING_RESOURCE } from "./central-learning-resources.js";

type Command<K extends CoordinateLearningCommand["action"]["kind"]> = CoordinateLearningCommand & {
  readonly action: Extract<CoordinateLearningCommand["action"], { kind: K }> };

function sourceRevisionFailure(state: BoardState, expected: number | undefined, current: number) {
  return expected !== undefined && current !== expected ? fail(state, "learning_claim_conflict", "source_issue_revision_changed") : undefined;
}

export function applyCentralClaim(state: BoardState, command: Command<"claim">) {
  const a = command.action, current = coordinationForJob(state, a.jobId);
  if (current === undefined) return fail(state, "job_not_found", a.jobId);

  const { issue, job, grant } = current;
  const revisionFailure = sourceRevisionFailure(state, a.expectedIssueRevision, issue.revision);
  if (revisionFailure !== undefined) return revisionFailure;

  if (issue.decision.kind !== "focused_learning") return fail(state, "learning_issue_not_focused", issue.issueId);

  if (grant.status !== "open") return fail(state, "learning_grant_closed", grant.grantId);

  if (job.attempt !== a.expectedAttempt) return fail(state, "learning_claim_conflict", "job_attempt_changed");

  if (job.state === "running" && grant.claim !== undefined && Date.parse(grant.claim.expiresAt) > Date.parse(command.issuedAt)) {
    return fail(state, "learning_claim_active", grant.claim.claimId);
  }

  if (job.state !== "queued" && job.state !== "running") return fail(state, "illegal_transition", `${job.state}->central_claim`);

  if (Date.parse(a.expiresAt) <= Date.parse(command.issuedAt) || Date.parse(a.expiresAt) - Date.parse(command.issuedAt) > 600000) {
    return fail(state, "invalid_learning_coordination", "claim_lease");
  }

  // A funded job may still assemble a returned dependency with no paid calls left.
  // Only reserve admits model spending; dispatch never silently creates more allowance.
  const managed = grant.budgetId !== undefined;
  const recoveries = managed && grant.claim !== undefined ? (grant.claim.recoveryAttempts ?? 0) + 1 : 0;

  // Confirmed handoffs clear the claim. Only consecutive unresolved lease takeovers
  // consume a managed worker's retry ceiling; total attempts remain audit history.
  if (job.breakerOpen || (!managed && job.attempt >= job.maxAttempts) || managed && recoveries > job.maxAttempts) {
    return fail(state, "learning_grant_exhausted", grant.grantId);
  }

  if (!Number.isSafeInteger(job.attempt) || job.attempt >= MAX_CENTRAL_LEARNING_RESOURCE) return fail(state, "learning_grant_capacity", "claim_counter_capacity");

  const reservations = grant.reservations.map(r => r.state === "reserved" ? { ...r, state: "settled" as const,
    usage: { kind: "unknown" as const, reason: "previous_claim_expired" } } : r);

  return commitCoordination(state, command, { job: { ...job, state: "running", attempt: job.attempt + 1 }, grant: { ...grant, reservations,
    claim: { claimId: a.claimId, ownerId: a.ownerId, expiresAt: a.expiresAt, step: job.attempt + 1,
      ...(managed ? { recoveryAttempts: recoveries } : {}) } } });
}

/** Only the still-live owner may renew. Renewal does not claim another attempt,
 * settle a bill, change focus or replenish a resource allowance. */
export function applyCentralRenewal(state: BoardState, command: Command<"renew">) {
  const a = command.action, current = coordinationForJob(state, a.jobId);
  if (current === undefined) return fail(state, "job_not_found", a.jobId);

  const { issue, job, grant } = current, claim = grant.claim;
  const revisionFailure = sourceRevisionFailure(state, a.expectedIssueRevision, issue.revision);
  if (revisionFailure !== undefined) return revisionFailure;

  if (issue.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision) return fail(state, "learning_issue_not_focused", issue.issueId);

  if (grant.status !== "open") return fail(state, "learning_grant_closed", grant.grantId);

  const now = Date.parse(command.issuedAt), expires = Date.parse(a.expiresAt);
  if (job.state !== "running" || claim?.claimId !== a.claimId || claim.ownerId !== a.ownerId
    || job.attempt !== a.expectedStep || claim.step !== a.expectedStep || claim.expiresAt !== a.expectedExpiresAt || Date.parse(claim.expiresAt) <= now) {
    return fail(state, "learning_claim_conflict", "renewal_owner_changed_or_expired");
  }

  if (expires <= Date.parse(claim.expiresAt) || expires - now > 600000) return fail(state, "invalid_learning_coordination", "claim_lease");

  return commitCoordination(state, command, { grant: { ...grant, claim: { ...claim, expiresAt: a.expiresAt } } });
}

export function applyCentralFinish(state: BoardState, command: Command<"finish">) {
  const a = command.action, current = coordinationForJob(state, a.jobId);
  if (current === undefined) return fail(state, "job_not_found", a.jobId);

  const { issue, job, grant } = current;
  const revisionFailure = sourceRevisionFailure(state, a.expectedIssueRevision, issue.revision);
  if (revisionFailure !== undefined) return revisionFailure;

  if (issue.decision.kind !== "focused_learning") return fail(state, "learning_issue_not_focused", issue.issueId);

  if (grant.status !== "open") return fail(state, "learning_grant_closed", grant.grantId);

  if (job.state !== "running" || grant.claim?.claimId !== a.claimId) return fail(state, "learning_claim_conflict", "late_worker_result");

  if (a.result.kind === "yielded" && job.domain !== "prompt" && job.domain !== "tool" && job.domain !== "workflow" && job.domain !== "collaboration" && job.domain !== "skill") {
    // Retain the historical failure detail for domains without a yield contract.
    return fail(state, "invalid_learning_coordination", "yield_requires_method_job");
  }

  if (a.result.kind === "yielded" && job.domain === "skill" && grant.reservations.length !== 0) {
    return fail(state, "invalid_learning_coordination", "skill_yield_requires_unsent_review");
  }

  const settled = { ...grant, reservations: grant.reservations.map(r => r.state === "reserved" && r.claimId === a.claimId
    ? { ...r, state: "settled" as const, usage: { kind: "unknown" as const, reason: "work_ended_without_usage" } } : r) };

  // Research may yield its lease. Skill uses this only for a confirmed unsent
  // recovery boundary. The source/grant and all known/unknown charges survive.
  if (a.result.kind === "yielded") return commitCoordination(state, command, {
    job: { ...job, state: "queued" }, grant: withoutClaim(settled),
  });

  if (a.result.kind === "completed") return commitCoordination(state, command, {
    job: { ...job, state: "succeeded", coordination: { issueId: issue.issueId, grantId: grant.grantId, resultRefs: a.result.resultRefs } },
    grant: closeCentralGrant(settled, "completed"),
  });

  if (a.result.kind === "failed" || a.result.kind === "cancelled") return commitCoordination(state, command, {
    job: { ...job, state: a.result.kind === "cancelled" ? "cancelled" : "failed",
      ...(a.result.resultRefs === undefined ? {} : { coordination: { issueId: issue.issueId, grantId: grant.grantId, resultRefs: a.result.resultRefs } }) },
    grant: closeCentralGrant(settled, a.result.reason),
  });

  if (a.result.kind !== "waiting_dependency") return fail(state, "invalid_learning_coordination", "invalid_work_result");

  const dependencies: LearningDependency[] = [];

  for (const draft of a.result.dependencies) {
    const existing = state.learningDependencies?.find(d => d.dependencyId === draft.dependencyId);
    if (existing !== undefined && (existing.issueId !== issue.issueId || existing.jobId !== job.jobId || existing.grantId !== grant.grantId
      || existing.owner !== draft.owner || existing.requestId !== draft.requestId || existing.correlationRef !== draft.correlationRef)) {
      return fail(state, "learning_dependency_conflict", draft.dependencyId);
    }

    dependencies.push(existing ?? { ...draft, schemaVersion: 1, issueId: issue.issueId, jobId: job.jobId,
      grantId: grant.grantId, revision: 1, observedAt: command.issuedAt });
  }

  const failure = dependencies.find(d => ["failed", "rejected", "cancelled"].includes(d.state.kind));

  return commitCoordination(state, command, { dependencies,
    job: { ...job, state: failure !== undefined ? "failed" : dependencies.every(learningDependencyResumable) ? "queued" : "waiting_evidence" },
    grant: failure === undefined ? withoutClaim(settled) : closeCentralGrant(settled, `dependency:${failure.state.kind}`) });
}

export function applyDependencyObservation(state: BoardState, command: Command<"dependency">) {
  const a = command.action, previous = state.learningDependencies?.find(d => d.dependencyId === a.dependencyId);
  if (previous === undefined) return fail(state, "learning_dependency_not_found", a.dependencyId);

  if (a.requestId !== undefined && previous.requestId !== undefined && a.requestId !== previous.requestId) {
    return fail(state, "learning_dependency_conflict", "dependency_request_already_bound");
  }

  if (a.state.kind === "authorized" && (a.requestId ?? previous.requestId) === undefined) return fail(state, "invalid_learning_coordination", "authorization_request_missing");

  if ((a.requestId === undefined || previous.requestId === a.requestId) && contentHashOf(previous.state) === contentHashOf(a.state)) return replay(state);

  if (previous.revision !== a.expectedRevision) return fail(state, "learning_dependency_conflict", "dependency_revision_changed");

  if (previous.state.kind !== "waiting" && previous.state.kind !== "unavailable" && previous.state.kind !== "authorized") return fail(state, "learning_dependency_conflict", "dependency_wait_is_terminal");

  const current = coordinationForJob(state, previous.jobId);
  if (current === undefined) return fail(state, "job_not_found", previous.jobId);

  const dependency: LearningDependency = { ...previous, revision: previous.revision + 1, observedAt: command.issuedAt, state: a.state,
    ...(a.requestId === undefined ? {} : { requestId: a.requestId }) };

  // A late library receipt remains an observation; a resolved issue never reopens work or its grant.
  if (current.issue.decision.kind !== "focused_learning" || current.grant.status !== "open" || current.job.state !== "waiting_evidence") {
    return commitCoordination(state, command, { dependencies: [dependency] });
  }

  const all = (state.learningDependencies ?? []).filter(d => d.jobId === current.job.jobId).map(d => d.dependencyId === a.dependencyId ? dependency : d);
  const failed = all.some(d => ["failed", "rejected", "cancelled"].includes(d.state.kind));

  return commitCoordination(state, command, { dependencies: [dependency],
    ...(failed ? { job: { ...current.job, state: "failed" as const }, grant: closeCentralGrant(current.grant, `dependency:${a.state.kind}`) }
      : all.every(learningDependencyResumable) ? { job: { ...current.job, state: "queued" as const } } : {}) });
}
