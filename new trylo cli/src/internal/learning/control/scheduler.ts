import type { BoardCommand } from "./commands.js";
import type { EvidenceBundle, LearningJob, LearningProposal } from "./contracts.js";
import type { ReduceResult } from "./result.js";
import type { BoardState } from "./state.js";
import type { BoardStore, StoreLoadErr } from "./store-port.js";

export type WorkerOutput =
  | { readonly kind: "proposal"; readonly proposal: Omit<LearningProposal, "lifecycle"> }
  | { readonly kind: "evidence"; readonly evidence: EvidenceBundle }
  | { readonly kind: "failed"; readonly reason: string };

export type WorkerPort = {
  run(job: LearningJob): Promise<WorkerOutput>;
};

export type SchedulerTick =
  | { readonly ok: true; readonly jobId?: string }
  | { readonly ok: false; readonly reason: string; readonly blockedExecution: false };

export type LearningScheduler = {
  enqueue(
    command: Extract<BoardCommand, { type: "enqueue_job" }>,
  ): Promise<ReduceResult | StoreLoadErr>;
  tick(): Promise<SchedulerTick>;
  cancel(jobId: string): Promise<SchedulerTick>;
  expire(jobId: string): Promise<SchedulerTick>;
};

export function createScheduler(store: BoardStore, worker: WorkerPort): LearningScheduler {
  return {
    enqueue(command) {
      return store.apply(command);
    },
    async tick() {
      try {
        return await runQueued(store, worker);
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "scheduler failed",
          blockedExecution: false,
        };
      }
    },
    cancel(jobId) {
      return stopJob(store, jobId, "cancelled");
    },
    expire(jobId) {
      return stopJob(store, jobId, "expired");
    },
  };
}

async function stopJob(
  store: BoardStore,
  jobId: string,
  terminal: "cancelled" | "expired",
): Promise<SchedulerTick> {
  try {
    const loaded = await store.load();
    if (!loaded.ok) {
      return { ok: false, reason: loaded.reason, blockedExecution: false };
    }

    const applied = await store.apply({
      type: "fail_job",
      commandId: `job-${terminal}:${jobId}`,
      issuedAt: jobTime(loaded.state),
      jobId,
      terminal,
    });
    if (!applied.ok) {
      return { ok: false, reason: applied.reason, blockedExecution: false };
    }

    return { ok: true, jobId };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "scheduler stop failed",
      blockedExecution: false,
    };
  }
}

async function runQueued(store: BoardStore, worker: WorkerPort): Promise<SchedulerTick> {
  const loaded = await store.load();
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason, blockedExecution: false };
  }

  const job = nextQueued(loaded.state);
  if (job === undefined) {
    return { ok: true };
  }

  const started = await store.apply({
    type: "start_job",
    commandId: `job-start:${job.jobId}:${String(job.attempt + 1)}`,
    issuedAt: jobTime(loaded.state),
    jobId: job.jobId,
  });
  if (!started.ok) {
    return { ok: false, reason: started.reason, blockedExecution: false };
  }

  let output: WorkerOutput;

  try {
    output = await worker.run({ ...job, state: "running", attempt: job.attempt + 1 });
  } catch (err) {
    await store.apply({
      type: "fail_job",
      commandId: `job-fail:${job.jobId}`,
      issuedAt: jobTime(started.state),
      jobId: job.jobId,
      terminal: "failed",
    });
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "worker exploded",
      blockedExecution: false,
    };
  }

  if (output.kind === "failed") {
    await store.apply({
      type: "fail_job",
      commandId: `job-fail:${job.jobId}`,
      issuedAt: jobTime(started.state),
      jobId: job.jobId,
      terminal: "failed",
    });
    return { ok: false, reason: output.reason, blockedExecution: false };
  }

  const submitted = await submitWorkerOutput(store, job, output, started.state);
  if (!submitted.ok) {
    await store.apply({
      type: "fail_job",
      commandId: `job-fail:${job.jobId}`,
      issuedAt: jobTime(started.state),
      jobId: job.jobId,
      terminal: "failed",
    });
    return { ok: false, reason: submitted.reason, blockedExecution: false };
  }

  await store.apply({
    type: "complete_job",
    commandId: `job-done:${job.jobId}`,
    issuedAt: jobTime(submitted.state),
    jobId: job.jobId,
    next: output.kind === "evidence" ? "waiting_evidence" : "succeeded",
  });

  return { ok: true, jobId: job.jobId };
}

async function submitWorkerOutput(
  store: BoardStore,
  job: LearningJob,
  output: Exclude<WorkerOutput, { kind: "failed" }>,
  state: BoardState,
): Promise<ReduceResult | StoreLoadErr> {
  if (output.kind === "proposal") {
    return store.apply({
      type: "submit_proposal",
      commandId: `job-proposal:${job.jobId}`,
      issuedAt: jobTime(state),
      proposal: output.proposal,
    });
  }
  return store.apply({
    type: "record_evidence",
    commandId: `job-evidence:${job.jobId}`,
    issuedAt: jobTime(state),
    evidence: output.evidence,
  });
}

function nextQueued(state: BoardState): LearningJob | undefined {
  return state.jobs.find((job) => job.state === "queued" && !job.breakerOpen);
}

function jobTime(state: BoardState): string {
  return `seq:${String(state.sequence)}`;
}
