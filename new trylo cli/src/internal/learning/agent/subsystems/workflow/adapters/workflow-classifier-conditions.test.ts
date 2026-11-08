import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPort } from "../../../../../ports/provider.js";
import { emptyUsage } from "../../../../../ports/provider.js";
import { createWorkflowModelPort } from "./workflow-worker.js";

const family = { id: "bundle", intentClass: "artifact_bundle", checkKind: "acceptance" as const, checkSchema: "bundle/v1" };
const task = { scope: "project-a", taskFamily: family, conditions: { input_format: "json" } };
const known = { ...task, conditions: { input_format: "csv", output_schema: "bundle/v1" } };

function worker(value: unknown) {
  const provider: ProviderPort = { async *stream() {
    yield { type: "text_delta", blockId: "b", text: JSON.stringify(value) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  return createWorkflowModelPort({ provider, model: "test", allowance: 16000 });
}

test("omitted known condition dimensions require repair instead of saving an unusable conditional branch", async () => {
  const result = await worker(task).classify({ scope: task.scope, text: "JSON input, bundle/v1 output", families: [known] }, new AbortController().signal);
  assert.ok(!result.ok);
  assert.equal(result.code, "learning_conditions_missing");
  assert.match(result.message, /output_schema/);
});

test("a supported new value can form a new branch; unrelated families do not supply missing premises", async () => {
  const current = { ...task, conditions: { ...task.conditions, output_schema: "bundle/v1" } };
  const classified = await worker(current).classify({ scope: task.scope, text: "JSON input, bundle/v1 output", families: [known] }, new AbortController().signal);
  assert.ok(classified.ok);
  assert.deepEqual(classified.value, current);
  const separate = await worker(task).classify({ scope: task.scope, text: "JSON input", families: [{ ...known, taskFamily: { ...family, checkSchema: "other/v1" } }] }, new AbortController().signal);
  assert.ok(separate.ok);
});
