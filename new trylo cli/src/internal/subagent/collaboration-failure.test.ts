import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPort } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { SubagentCollaborationPort } from "./collaboration.js";
import { createSubagentControlTool } from "./control-tools.js";
import { SubagentRuntime } from "./runtime.js";

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const phases = ["prepare", "dispatched", "completed", "ended"] as const;

for (const rejectedPhase of phases) test(`rejecting collaboration ${rejectedPhase} observer cannot change execution or suppress terminal publication`, async t => {
  const diagnostics: string[] = [];
  const fail = async (phase: string): Promise<void> => {
    if (phase === rejectedPhase) throw new Error(`observer_rejected:${phase}`);
  };
  const collaboration: SubagentCollaborationPort = {
    async prepare() {
      await fail("prepare");
      return "OPTIONAL_ADVICE";
    },
    dispatched: () => fail("dispatched"), completed: () => fail("completed"), ended: () => fail("ended"),
  };
  const provider: ProviderPort = { async *stream() {
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: "real member output" };
    yield { type: "text_end", blockId: "a" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });

  t.after(() => runtime.cancelAll());
  const options = { runtime, provider, collaboration, onCollaborationFailure: (phase: string) => {
    diagnostics.push(phase);
    throw new Error("diagnostic sink also rejected");
  },
    permission: { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } },
    team: { runId: "team", members: [{ memberId: "architect", baseRole: "architect", displayName: "architect",
      role: { name: "architect", description: "architect" } }] } };
  const tools = createSubagentControlTool(options);
  let sequence = 0;
  const call = (name: string, args: JsonObject) => tools.execute({ name, arguments: args,
    toolCallId: `call-${++sequence}` }, new AbortController().signal);
  const spawn = await call("spawn_agent", { message: "inspect", agent_type: "architect", member_id: "architect" });

  assert.equal(spawn.outcome, "result");
  if (spawn.outcome !== "result") return;

  const id = String(spawn.value["agent_id"]);
  const ready = await call("wait_agent", { targets: [id], timeout_ms: 1000 });

  assert.equal(ready.outcome, "result");
  if (ready.outcome !== "result") return;

  const row = (ready.value["results"] as JsonObject)[id] as JsonObject;

  assert.equal(row["output"], "real member output");
  assert.equal(row["phase"], "awaiting_input");
  await call("close_agent", { target: id });
  const result = await runtime.wait(id);

  assert.equal(result.status, "completed");
  await flush();
  const final = await call("wait_agent", { targets: [id], timeout_ms: 0 });

  assert.equal(final.outcome, "result");
  if (final.outcome !== "result") return;

  const terminal = (final.value["results"] as JsonObject)[id] as JsonObject;

  assert.equal(terminal["phase"], "terminal");
  assert.equal(terminal["status"], "completed");
  assert.deepEqual(diagnostics, [rejectedPhase]);
});

test("a pending terminal observer cannot postpone execution terminal notification", async t => {
  let observing = false;
  const collaboration: SubagentCollaborationPort = { prepare: async () => undefined,
    dispatched: async () => {}, completed: async () => {}, ended: async () => {
      observing = true;
      await new Promise<void>(() => {});
    } };
  const provider: ProviderPort = { async *stream() {
    yield { type: "text_start", blockId: "a" };
    yield { type: "text_delta", blockId: "a", text: "done" };
    yield { type: "text_end", blockId: "a" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} } });

  t.after(() => runtime.cancelAll());
  const tools = createSubagentControlTool({ runtime, provider, collaboration,
    permission: { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } },
    team: { runId: "team", members: [{ memberId: "architect", baseRole: "architect", displayName: "architect",
      role: { name: "architect", description: "architect" } }] } });
  const call = (name: string, args: JsonObject) => tools.execute({ name, arguments: args,
    toolCallId: name }, new AbortController().signal);
  const spawn = await call("spawn_agent", { message: "inspect", agent_type: "architect", member_id: "architect" });

  assert.equal(spawn.outcome, "result");
  if (spawn.outcome !== "result") return;

  const id = String(spawn.value["agent_id"]);

  await call("wait_agent", { targets: [id], timeout_ms: 1000 });
  await call("close_agent", { target: id });
  assert.equal((await runtime.wait(id)).status, "completed");
  await flush();
  const final = await call("wait_agent", { targets: [id], timeout_ms: 0 });

  assert.equal(final.outcome, "result");
  if (final.outcome !== "result") return;

  assert.equal(((final.value["results"] as JsonObject)[id] as JsonObject)["phase"], "terminal");
  assert.equal(observing, true);
});

