import { createFileToolLedger } from "./ledger-file.js";
import { createToolGapRuntime, type ToolGapRuntime } from "./awareness-runtime.js";
import { handoffPendingToolPlans } from "./outbox-handoff.js";
import { ToolOutboxError } from "./outbox-reader.js";
import { createToolLearningReportTools } from "./learning-report-tool.js";
import { resumeToolFeedbackLearning } from "./feedback-learning.js";
import { readToolDecisionHistory } from "./decision-history.js";
import { resumeToolProductionCheckLearning } from "./production-check-learning.js";

/** Host resolves runtime locations; this subsystem owns close/outbox sequencing. */
export type ToolGapSessionInput = {
  readonly ledgerRoot: string;
  readonly boardRoot: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly afterEnqueue?: (jobIds: readonly string[]) => Promise<void>;
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

export function createToolGapSession(host: ToolGapSessionInput): ToolGapRuntime {
  const ledger = createFileToolLedger(host.ledgerRoot);
  const runtime = createToolGapRuntime({
    ledger,
    now: host.now,
    warn: host.warn,
    decisionHistory: tool => readToolDecisionHistory(host.boardRoot, host.ledgerRoot, tool),
    ...(host.workspaceId === undefined ? {} : { pipelineScope: host.workspaceId }),
  });
  const dispatched = new Set<string>();
  let pendingBoundary: Promise<void> | undefined;
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  const requestedJobs = new Set<string>();
  const recoverJobs = async () => {
    if (host.workspaceId === undefined) return [];

    const feedback = await resumeToolFeedbackLearning(host.boardRoot, host.workspaceId);
    if (!feedback.ok) throw new Error(feedback.code);

    const checks = await resumeToolProductionCheckLearning(host.boardRoot, host.workspaceId);
    if (!checks.ok) throw new Error(checks.code);

    if (feedback.failures.length > 0 || feedback.truncated || checks.failures.length > 0 || checks.truncated) {
      host.warn("tool learning: some feedback or check handoffs remain pending; inspect tools jobs");
    }

    return [...feedback.jobIds, ...checks.jobIds];
  };
  const dispatchBoundary = async () => {
    try {
      const queued = host.workspaceId === undefined ? [] : await handoffPendingToolPlans({ ledger, boardRoot: host.boardRoot,
        scope: host.workspaceId, now: host.now, warn: host.warn });
      const recovered = await recoverJobs();
      const jobs = [...new Set([...queued, ...recovered, ...requestedJobs])].filter(id => !dispatched.has(id));
      requestedJobs.clear();
      if (jobs.length > 0) {
        await host.afterEnqueue?.(jobs);
        for (const id of jobs) dispatched.add(id);
      }
    } catch {
      // Evidence/outbox remains durable. Close/startup can retry the handoff, never the external action.
      host.warn("tool learning: task-boundary handoff unavailable; durable reports remain pending");
    }
  };
  const scheduleBoundary = (jobIds: readonly string[]) => {
    for (const id of jobIds) requestedJobs.add(id);
    if (boundaryTimer !== undefined) return;
    boundaryTimer = setTimeout(() => {
      boundaryTimer = undefined;
      pendingBoundary = (pendingBoundary ?? Promise.resolve()).then(dispatchBoundary);
    }, 0);
  };
  let closing: Promise<void> | undefined;

  return { ...runtime, ...(host.workspaceId === undefined || host.sessionId === undefined ? {} : {
    toolsForTask: (taskId: string) => createToolLearningReportTools({ runtime, boardRoot: host.boardRoot,
      workspaceId: host.workspaceId!, sessionId: host.sessionId!, taskId, now: host.now, afterQueued: scheduleBoundary }),
  }), close: () => closing ??= (async () => {
    const scheduled = boundaryTimer !== undefined;

    if (boundaryTimer !== undefined) {
      clearTimeout(boundaryTimer);
      boundaryTimer = undefined;
    }

    await pendingBoundary;

    if (scheduled) await dispatchBoundary();

    await flushToolGapPlans({ ...host, afterEnqueue: async ids => {
      const recovered = await recoverJobs();
      const jobs = [...new Set([...ids, ...recovered])].filter(id => !dispatched.has(id));
      if (jobs.length > 0 || dispatched.size === 0) await host.afterEnqueue?.(jobs);
    } }, runtime, ledger);
  })() };
}

async function flushToolGapPlans(host: ToolGapSessionInput, runtime: ToolGapRuntime, ledger: ReturnType<typeof createFileToolLedger>): Promise<void> {
  const details = runtime.proposalDetails();

  await runtime.close();

  if (host.workspaceId === undefined) {
    if (details.length > 0) host.warn("tool learning: workspace identity missing; gap was not queued");
    return;
  }

  try {
    const jobIds = await handoffPendingToolPlans({ ledger, boardRoot: host.boardRoot,
      scope: host.workspaceId, now: host.now, warn: host.warn });
    await host.afterEnqueue?.(jobIds);
  } catch (error) {
    // The user's answer is already complete; do not replace it with learning I/O failure.
    host.warn(`tool learning: post-turn work unavailable${error instanceof ToolOutboxError ? ` (${error.code})` : ""}; inspect tools jobs before retrying`);
  }
}

