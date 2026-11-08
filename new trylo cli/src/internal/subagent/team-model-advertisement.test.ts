import assert from "node:assert/strict";
import { test } from "node:test";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";
import type { SubagentTeam } from "./team.js";
import type { JsonObject } from "../protocol/envelope.js";

function harness(models: readonly string[]) {
  let calls = 0;
  const tools = {
    snapshot: () => [],
    execute: async () => ({ outcome: "cancelled" as const }),
    cancel: async () => {},
  };
  const runtime = new SubagentRuntime({ tools });
  const team: SubagentTeam = {
    runId: "frozen-models",
    members: models.map((model, index) => ({
      memberId: `m${index}`, baseRole: "worker", displayName: `worker ${index}`,
      role: { name: "worker", description: "worker", model },
    })),
  };
  const control = createSubagentControlTool({
    runtime, team, model: "parent",
    provider: { async *stream() {
      calls += 1;
      yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
    } },
    permission: {
      request: async () => { throw Error("no approval"); },
      awaitDecision: async () => { throw Error("no approval"); },
    },
  });
  const properties = control.snapshot().find(tool => tool.name === "spawn_agent")?.parameters["properties"] as JsonObject;

  return { runtime, control, properties, calls: () => calls };
}

test("a fixed-model team advertises only its actual configured model choices", async t => {
  const h = harness(["Qwen3.8-Flash-Next", "Qwen3.8-Flash-Next"]);

  t.after(() => h.runtime.cancelAll());
  assert.deepEqual((h.properties["model"] as JsonObject)["enum"], ["Qwen3.8-Flash-Next"]);
  const refused = await h.control.execute({
    name: "spawn_agent", toolCallId: "refused",
    arguments: { message: "inspect", member_id: "m0", model: "unconfigured-model" },
  }, new AbortController().signal);

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") assert.equal(refused.code, "team_model_frozen");

  assert.equal(h.calls(), 0, "a schema hint never replaces runtime admission");
});

test("distinct frozen models remain visible and inherit seats retain the existing override contract", async t => {
  const frozen = harness(["model-a", "model-b"]);
  const inherited = harness(["model-a", "inherit"]);
  t.after(async () => {
    await frozen.runtime.cancelAll();
    await inherited.runtime.cancelAll();
  });
  assert.deepEqual((frozen.properties["model"] as JsonObject)["enum"], ["model-a", "model-b"]);
  assert.equal((inherited.properties["model"] as JsonObject)["enum"], undefined);
  assert.match(String((inherited.properties["model"] as JsonObject)["description"]), /frozen|configured/i);
});
