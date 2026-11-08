import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDiscoveryPort } from "../assets/acquisition/discovery.js";
import { candidate, observation } from "../../../../../tooling/testing/fixtures.js";
import { createRecordingBoardPort } from "./board-adapter.js";
import {
  CURATOR_PERMISSIONS,
  curatorMayApproveOwnTool,
  curatorOwnsExecutionLoop,
  runToolCurator,
  submitBindingDraft,
} from "./curator.js";
import { applyApprovalDecision, mayRetry, recordJobOutcome, type CuratorJob } from "./retry-breaker.js";

function job(overrides: Partial<CuratorJob> = {}): CuratorJob {
  return { jobId: "job-1", state: "running", consecutiveFailures: 0, ...overrides };
}

test("curator is a peripheral worker without execution loop or self-approval", () => {
  assert.equal(curatorOwnsExecutionLoop(), false);
  assert.equal(curatorMayApproveOwnTool(), false);
  assert.equal(CURATOR_PERMISSIONS.network, false);
  assert.equal(CURATOR_PERMISSIONS.shell, false);
  assert.equal(CURATOR_PERMISSIONS.executionLoop, false);
});

test("curator submits gap and candidates without activating", () => {
  const board = createRecordingBoardPort();
  const discovery = createFakeDiscoveryPort([
    candidate({ candidateId: "cand-mit", name: "pdf-lint" }),
    candidate({ candidateId: "cand-mit-alt", name: "pdf-lint-alt" }),
  ]);
  const result = runToolCurator({
    job: job(),
    observations: [
      observation({ observationId: "o1", kind: "tool_failure" }),
      observation({ observationId: "o2", kind: "tool_failure" }),
      observation({ observationId: "o3", kind: "tool_failure" }),
    ],
    discovery,
    board,
  });

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.submitted.some((item) => item.kind === "submit_gap"), true);
  assert.equal(result.value.submitted.some((item) => item.kind === "submit_candidate"), true);
  assert.equal(result.value.submitted.some((item) => item.kind === "submit_binding_draft"), false);
  assert.equal(result.value.job.state, "waiting_approval");
});

test("unverified packages cannot become binding drafts", async () => {
  const board = createRecordingBoardPort();
  const denied = await submitBindingDraft(
    board,
    {
      draftId: "d1",
      scope: "docs",
      taskFamily: "docs",
      packageVersionId: "pkg:1",
      candidateId: "cand-mit",
    },
    undefined,
    { now: "2026-09-12T00:00:00Z" },
  );

  assert.equal(denied.ok, false);
  assert.deepEqual(board.snapshot(), []);
});

test("worker breaker stops infinite retry after consecutive failures", () => {
  let current = job();

  current = recordJobOutcome(current, "failed");
  current = recordJobOutcome(current, "timeout");
  current = recordJobOutcome(current, "failed");
  assert.equal(current.state, "stopped_breaker");
  assert.equal(mayRetry(current), false);
  const board = createRecordingBoardPort();
  const discovery = createFakeDiscoveryPort([]);
  const result = runToolCurator({
    job: current,
    observations: [observation({ observationId: "o1", kind: "tool_failure" })],
    discovery,
    board,
  });

  assert.equal(result.ok, false);
});

test("waiting_approval does not retry discovery until a decision", () => {
  const waiting = job({ state: "waiting_approval" });

  assert.equal(mayRetry(waiting), false);
  const denied = applyApprovalDecision(waiting, "denied");

  assert.equal(denied.state, "denied");
  assert.equal(mayRetry(denied), false);
  const approved = applyApprovalDecision(waiting, "approved");

  assert.equal(approved.state, "running");
});

test("negative regression only emits suspend/rollback commands", () => {
  const board = createRecordingBoardPort();

  board.submit({ kind: "request_suspend", packageVersionId: "pkg:1", reason: "negative regression" });
  board.submit({ kind: "request_rollback", packageVersionId: "pkg:1", reason: "negative regression" });
  assert.equal(
    board.snapshot().every((item) => item.kind === "request_suspend" || item.kind === "request_rollback"),
    true,
  );
});
