import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createFakeDiscoveryPort } from "../assets/acquisition/discovery.js";
import { admitBuiltPackage } from "../assets/builder/admit.js";
import { schemaNotSentHint, assembleDeferredContext } from "../../../../../tooling/catalog/production-search.js";
import { projectMyTools } from "../assets/my-tools/projector.js";
import { isForbiddenQuarantineRoot } from "../adapters/quarantine/acquire.js";
import { createSideEffectGuard } from "../../../../../tooling/side-effects.js";
import {
  archive,
  candidate,
  observation,
  passingSignals,
  pkg,
} from "../../../../../tooling/testing/fixtures.js";
import { createRecordingBoardPort } from "./board-adapter.js";
import { runLearningPipeline } from "./pipeline.js";
import type { CuratorJob } from "./retry-breaker.js";

function job(): CuratorJob {
  return { jobId: "job-pipe", state: "running", consecutiveFailures: 0 };
}

test("end-to-end curator pipeline discovers without acquiring or activating", () => {
  const guard = createSideEffectGuard();
  const board = createRecordingBoardPort();
  const result = runLearningPipeline({
    job: job(),
    observations: [
      observation({ observationId: "o1", kind: "tool_failure" }),
      observation({ observationId: "o2", kind: "tool_failure" }),
      observation({ observationId: "o3", kind: "tool_failure" }),
    ],
    discovery: createFakeDiscoveryPort([
      candidate({ candidateId: "cand-mit", name: "pdf-lint" }),
      candidate({ candidateId: "cand-mit-alt", name: "pdf-lint-alt" }),
    ]),
    board,
    guard,
  });

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.value.job.state, "waiting_approval");
  assert.equal(result.value.commands.some((item) => item.kind === "submit_gap"), true);
  assert.equal(result.value.commands.some((item) => item.kind === "submit_candidate"), true);
  assert.equal(result.value.commands.some((item) => item.kind === "submit_binding_draft"), false);
  assert.deepEqual(guard.attempts(), []);
});

test("failed verification hides capabilities in My Tools", () => {
  const rejected = pkg({ catalogState: "rejected" });
  const entries = projectMyTools({
    packages: [rejected],
    validations: [
      {
        validationId: "v-fail",
        packageVersionId: rejected.packageVersionId,
        stages: [],
        verdict: "fail",
        actor: "verifier",
      },
    ],
    activations: [],
    contributionByPackage: {},
  });

  assert.deepEqual(entries[0]?.capabilities, []);
  assert.deepEqual(entries[0]?.permissionNeeds, []);
  assert.equal(entries[0]?.lastValidation, "fail");
});

test("built packages cannot skip the shared verification pipeline", () => {
  const built = pkg({ catalogState: "quarantined" });
  const admitted = admitBuiltPackage({
    pkg: built,
    archive: archive(),
    compressedBytes: 32,
    signals: passingSignals({ unitTestsPass: false }),
  });

  assert.equal(admitted.ok, false);
});

test("deferred tool call without schema load gets an explicit hint", () => {
  const assembled = assembleDeferredContext([
    {
      packageVersionId: "a",
      origin: "direct",
      name: "deferred",
      searchHint: "pdf",
      description: "pdf",
      shouldDefer: true,
      alwaysLoad: false,
    },
  ]);
  const hint = schemaNotSentHint("deferred", assembled);

  assert.equal(typeof hint, "string");
});

test("global config roots are forbidden quarantine targets", () => {
  const home = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  if (home !== undefined && home.length > 0) {
    assert.equal(isForbiddenQuarantineRoot(path.join(home, ".trylo")), true);
    if (process.platform === "darwin") {
      assert.equal(isForbiddenQuarantineRoot(path.join(home, "LIBRARY", "application support")), true);
    }
  }
});

test("side-effect guard fail-closes clone/download/execute", () => {
  const guard = createSideEffectGuard();
  assert.equal(guard.deny("clone").ok, false);
  assert.equal(guard.deny("download").ok, false);
  assert.equal(guard.deny("execute").ok, false);
  assert.equal(guard.attempts().includes("clone"), true);
});
