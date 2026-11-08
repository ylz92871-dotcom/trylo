import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "../../adapters/learning-store/file-event-store.js";
import { command, inferredDraft } from "./fixtures.js";
import { createScheduler, type WorkerPort } from "./scheduler.js";
import type { BoardStore } from "./store-port.js";

test("worker may only submit proposal or evidence, never activate", async () => {
  await withScheduler(
    {
      async run() {
        return { kind: "proposal", proposal: inferredDraft({ proposalId: "from-job" }) };
      },
    },
    async (store, scheduler) => {
      await scheduler.enqueue(
        command("enqueue_job", {
          job: {
            jobId: "j1",
            observationId: "obs-1",
            domain: "prompt",
            scope: "project",
            maxAttempts: 2,
            dedupeKey: "obs-1:prompt:project",
          },
        }),
      );
      const tick = await scheduler.tick();

      assert.equal(tick.ok, true);
      const loaded = await store.load();

      assert.equal(loaded.ok, true);

      if (loaded.ok) {
        assert.equal(loaded.state.proposals[0]?.lifecycle, "draft");
        assert.equal(loaded.state.activations.length, 0);
        assert.equal(loaded.state.jobs[0]?.state, "succeeded");
      }
    },
  );
});

test("duplicate observation/domain/scope is rejected", async () => {
  await withScheduler(
    {
      async run() {
        return { kind: "failed", reason: "unused" };
      },
    },
    async (_store, scheduler) => {
      const job = {
        jobId: "j1",
        observationId: "obs-1",
        domain: "prompt" as const,
        scope: "project",
        maxAttempts: 2,
        dedupeKey: "obs-1:prompt:project",
      };
      const first = await scheduler.enqueue(command("enqueue_job", { job }));

      assert.equal(first.ok, true);
      const second = await scheduler.enqueue(
        command("enqueue_job", { job: { ...job, jobId: "j2" } }),
      );

      assert.equal(second.ok, false);

      if (!second.ok) {
        assert.equal(second.reason, "job_dedupe_hit");
      }
    },
  );
});

test("cancel and expire do not block execution and jobs have no shell/network fields", async () => {
  await withScheduler(
    {
      async run() {
        return { kind: "failed", reason: "unused" };
      },
    },
    async (store, scheduler) => {
      await scheduler.enqueue(
        command("enqueue_job", {
          job: {
            jobId: "j1",
            observationId: "obs-1",
            domain: "prompt",
            scope: "project",
            maxAttempts: 2,
            dedupeKey: "obs-1:prompt:project",
          },
        }),
      );
      const cancelled = await scheduler.cancel("j1");

      assert.equal(cancelled.ok, true);
      await scheduler.enqueue(
        command("enqueue_job", {
          job: {
            jobId: "j2",
            observationId: "obs-2",
            domain: "prompt",
            scope: "project",
            maxAttempts: 2,
            dedupeKey: "obs-2:prompt:project",
          },
        }),
      );
      const expired = await scheduler.expire("j2");

      assert.equal(expired.ok, true);
      const loaded = await store.load();

      assert.equal(loaded.ok, true);

      if (loaded.ok) {
        const cancelledJob = loaded.state.jobs.find((item) => item.jobId === "j1");
        const expiredJob = loaded.state.jobs.find((item) => item.jobId === "j2");

        assert.equal(cancelledJob?.state, "cancelled");
        assert.equal(expiredJob?.state, "expired");
        const job = cancelledJob;

        assert.equal("shell" in (job ?? {}), false);
        assert.equal("allowNetwork" in (job ?? {}), false);
        assert.equal("permission" in (job ?? {}), false);
      }
    },
  );
});

test("queued job is recoverable after store reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-sched-"));
  const first = createFileBoardStore(dir);
  if (!("apply" in first)) {
    throw new Error(first.reason);
  }

  try {
    const scheduler = createScheduler(first, {
      async run() {
        return { kind: "proposal", proposal: inferredDraft({ proposalId: "recovered" }) };
      },
    });

    await scheduler.enqueue(
      command("enqueue_job", {
        job: {
          jobId: "j1",
          observationId: "obs-1",
          domain: "prompt",
          scope: "project",
          maxAttempts: 2,
          dedupeKey: "obs-1:prompt:project",
        },
      }),
    );
    await first.close();
    const reopened = createFileBoardStore(dir);
    if (!("apply" in reopened)) {
      throw new Error(reopened.reason);
    }

    try {
      const again = createScheduler(reopened, {
        async run() {
          return { kind: "proposal", proposal: inferredDraft({ proposalId: "recovered" }) };
        },
      });
      const tick = await again.tick();

      assert.equal(tick.ok, true);
      const loaded = await reopened.load();

      assert.equal(loaded.ok, true);

      if (loaded.ok) {
        assert.equal(loaded.state.jobs[0]?.state, "succeeded");
        assert.equal(loaded.state.proposals[0]?.proposalId, "recovered");
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker evidence that cannot be recorded fails the job without blocking execution", async () => {
  await withScheduler(
    {
      async run() {
        return {
          kind: "evidence",
          evidence: {
            evidenceId: "ev1",
            proposalId: "missing",
            kinds: ["external_verifier"],
            dataVersion: "v1",
            failureSamples: [],
            provenance: "worker",
            externalVerdict: "pass",
          },
        };
      },
    },
    async (store, scheduler) => {
      await scheduler.enqueue(
        command("enqueue_job", {
          job: {
            jobId: "j1",
            observationId: "obs-1",
            domain: "prompt",
            scope: "project",
            maxAttempts: 2,
            dedupeKey: "obs-1:prompt:project",
          },
        }),
      );
      const tick = await scheduler.tick();

      assert.equal(tick.ok, false);

      if (!tick.ok) {
        assert.equal(tick.blockedExecution, false);
      }

      const loaded = await store.load();

      assert.equal(loaded.ok, true);

      if (loaded.ok) {
        assert.equal(loaded.state.jobs[0]?.state, "failed");
      }
    },
  );
});

test("worker failure does not throw to the execution caller", async () => {
  await withScheduler(
    {
      async run() {
        throw new Error("worker exploded");
      },
    },
    async (_store, scheduler) => {
      await scheduler.enqueue(
        command("enqueue_job", {
          job: {
            jobId: "j1",
            observationId: "obs-1",
            domain: "prompt",
            scope: "project",
            maxAttempts: 1,
            dedupeKey: "obs-1:prompt:project",
          },
        }),
      );
      const tick = await scheduler.tick();

      assert.equal(tick.ok, false);

      if (!tick.ok) {
        assert.equal(tick.blockedExecution, false);
      }
    },
  );
});

async function withScheduler(
  worker: WorkerPort,
  run: (store: BoardStore, scheduler: ReturnType<typeof createScheduler>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-sched-"));
  const store = createFileBoardStore(dir);
  if (!("apply" in store)) {
    throw new Error(store.reason);
  }

  const scheduler = createScheduler(store, worker);

  try {
    await run(store, scheduler);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
