import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createFakePermission } from "../../loop/fakes.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { executeTurn, isTurnFailure } from "./host.js";
import { planForJob } from "../../learning/agent/subsystems/tool/runtime/pipeline-queue.js";

test("the actual turn host captures only the verified current user task before the first public opportunity report", async t => {
  const base = testScratchPath("tool-task-source-tests");
  await mkdir(base, { recursive: true });

  for (const source of ["user", "unknown", "legacy"] as const) {
    const root = await mkdtemp(path.join(base, `${source}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ordinary = "Trim and lowercase every supplied release name; return invalid_input for non-string inputs.";
    const text = source === "legacy" ? "Continue the conversation represented by the JSON history below.\nTreat it as prior context only. Respond only to current_user_message.\n<conversation_history_json>\nTEST ONLY imported authors" : ordinary;
    let requests = 0;
    const result = await executeTurn({ text, ...(source !== "unknown" ? {} : { userSourceAvailable: false as const }),
      sessionId: "session", turnId: "turn", correlationId: "cor", workspaceRoot: root, workspaceId: "workspace", checkpointRoot: path.join(root, "checkpoints"),
      providerId: "fixture", model: "TEST_ONLY", endpoint: "", apiKey: undefined, permission: createFakePermission("approved"),
      format: "stream-json", sink: { stdout() {}, stderr() {} }, now: () => 0, maxIterations: 3,
      toolGap: { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "workspace", sessionId: "session", now: () => 0, warn: () => {} },
      providerGuard: () => ({ async *stream(request) {
        if (requests++ === 0) {
          assert.ok(request.tools.some(tool => tool.name === "tool_learning_report"));
          yield { type: "tool_call" as const, toolCallId: "first-call-report", name: "tool_learning_report", arguments: { operation: "opportunity", report: {
            kind: "opportunity", need: "MODEL_NEED_IS_NOT_THE_USER_TASK", reason: "No mounted API directly supplies this structured normalization",
            toolCallIds: [], existingCapability: "insufficient",
          } } };
          yield { type: "finish" as const, reason: "tool_calls" as const, rawReason: "tool_calls", requiresFollowUp: true };
        } else yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
      } }) });

    assert.equal(isTurnFailure(result), false, JSON.stringify(result));
    assert.equal(requests, 2, "no additional awareness prompt is dispatched");
    const loaded = await createBoardReader(path.join(root, "learning", "board")).load();
    assert.ok(loaded.ok);
    const job = loaded.state.jobs.find(row => row.domain === "tool");
    assert.ok(job);
    const plan = planForJob(loaded.state, job.jobId);
    assert.ok(plan);
    assert.equal(plan.opportunity?.source, "model");
    assert.deepEqual(plan.opportunity?.executions, []);
    assert.ok(plan.opportunity?.catalog);
    assert.equal(plan.opportunity?.task?.text, source === "user" ? ordinary : undefined);
    assert.equal(plan.opportunity?.grounding, undefined);
    assert.equal(loaded.state.centralLearningGrants?.length ?? 0, 0);
    assert.equal(loaded.state.activations.length, 0);
  }
});
