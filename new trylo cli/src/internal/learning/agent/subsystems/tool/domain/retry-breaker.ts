import type { CuratorJobState } from "../../../../../tooling/contract/types.js";

export type BreakerPolicy = {
  readonly maxConsecutiveFailures: number;
};

export const DEFAULT_BREAKER: BreakerPolicy = {
  maxConsecutiveFailures: 3,
};

export type CuratorJob = {
  readonly jobId: string;
  readonly state: CuratorJobState;
  readonly consecutiveFailures: number;
  readonly lastError?: string;
};

export function recordJobOutcome(
  job: CuratorJob,
  outcome: "success" | "denied" | "expired" | "failed" | "timeout",
  policy: BreakerPolicy = DEFAULT_BREAKER,
): CuratorJob {
  if (outcome === "success") {
    return { ...job, state: "completed", consecutiveFailures: 0 };
  }

  if (outcome === "denied") {
    return { ...job, state: "denied", consecutiveFailures: job.consecutiveFailures + 1, lastError: "denied" };
  }

  if (outcome === "expired") {
    return { ...job, state: "expired", consecutiveFailures: job.consecutiveFailures + 1, lastError: "expired" };
  }

  const consecutive = job.consecutiveFailures + 1;
  if (consecutive >= policy.maxConsecutiveFailures) {
    return {
      ...job,
      state: "stopped_breaker",
      consecutiveFailures: consecutive,
      lastError: outcome,
    };
  }

  return {
    ...job,
    state: "failed",
    consecutiveFailures: consecutive,
    lastError: outcome,
  };
}

export function mayRetry(job: CuratorJob): boolean {
  return job.state === "running" || job.state === "failed";
}

export function applyApprovalDecision(
  job: CuratorJob,
  decision: "approved" | "denied" | "expired",
): CuratorJob {
  if (job.state !== "waiting_approval") {
    return { ...job, state: "failed", lastError: "approval_decision_without_wait" };
  }

  if (decision === "approved") {
    return { ...job, state: "running", consecutiveFailures: 0 };
  }

  if (decision === "denied") {
    return { ...job, state: "denied", lastError: "denied" };
  }

  return { ...job, state: "expired", lastError: "expired" };
}
