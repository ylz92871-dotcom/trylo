import assert from "node:assert/strict";
import test from "node:test";
import type { ToolRunnerPort, ToolRunnerResult } from "../../../../../../ports/tool-runner-port.js";
import { ToolLearningServiceError } from "../../domain/evolution/service-error.js";
import { requestToolLearningJson } from "./planning-model.js";

function runner(result: ToolRunnerResult): ToolRunnerPort {
  return { submit: async task => ({ taskId: task.taskId }), onProgress: () => () => {}, cancel: async () => true,
    wait: async () => result, status: async () => result.status };
}

const options = () => ({ taskId: "test-artifact", timeoutMs: 1000, signal: new AbortController().signal });

test("worker execution deadlines and cancellation retain their distinct redacted causes across contract transport", async () => {
  for (const [status, code] of [["timed_out", "tool_planning_timeout"], ["cancelled", "tool_planning_cancelled"]] as const) {
    await assert.rejects(requestToolLearningJson(runner({ taskId: "test-artifact", status, observed: "terminal",
      error: { code: "PRIVATE_UNTRUSTED_CODE", message: "PRIVATE_UNTRUSTED_BODY" } }), "TEST ONLY prompt", options()),
    error => error instanceof ToolLearningServiceError && error.code === code && !error.message.includes("PRIVATE_"));
  }
});

test("malformed model JSON is an artifact error and private transport bodies never become failure messages", async () => {
  await assert.rejects(requestToolLearningJson(runner({ taskId: "test-artifact", status: "completed", observed: "terminal", output: "not JSON" }), "TEST ONLY", options()),
    error => error instanceof ToolLearningServiceError && error.code === "tool_planning_invalid_json");
  await assert.rejects(requestToolLearningJson(runner({ taskId: "test-artifact", status: "failed", observed: "terminal", error: { code: "PRIVATE_", message: "PRIVATE_BODY" } }), "TEST ONLY", options()),
    error => error instanceof ToolLearningServiceError && error.code === "tool_planning_unavailable" && !error.message.includes("PRIVATE_"));
});
