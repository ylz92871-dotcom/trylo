import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderMessage } from "../ports/provider.js";
import { SUBAGENT_ROUTING_PARENT_BYTES, type SubagentRoutingPort } from "../ports/subagent-routing.js";
import { chooseSubagentRouting, isSubagentRoutingReceipt } from "./routing.js";

test("oversized implicit choice never serializes or snapshots the parent before falling back", async () => {
  let called = 0;
  const port: SubagentRoutingPort = {
    choose: async () => {
      called++;
      throw new Error("oversized parent reached the selection callback");
    },
    dispatched: async () => {}, finished: async () => {},
  };
  const raw: ProviderMessage[] = [{ role: "user", content: "x".repeat(SUBAGENT_ROUTING_PARENT_BYTES + 1) }];
  const parent = new Proxy(raw, { get(target, key, receiver) {
    if (key === "toJSON") throw new Error("unbounded serialization attempted");
    return Reflect.get(target, key, receiver);
  } });
  const result = await chooseSubagentRouting(port, { executionId: "oversized", message: "Given the task", parentMessages: parent,
    signal: new AbortController().signal });

  assert.equal(called, 0);
  assert.equal(result.receipt.actualPath, "independent");
  assert.ok(result.diagnostics.includes("routing_context_capacity"));
  assert.equal(result.receipt.conditions.parentBytes, undefined, "unknown bytes must not become zero or a saturated exact count");
  assert.equal(isSubagentRoutingReceipt(JSON.parse(JSON.stringify(result.receipt))), true, "new unknown-byte checkpoint is readable");
});

test("bounded UTF8 and answered tool context keep their precise old numeric checkpoint facts", async () => {
  const parent: readonly ProviderMessage[] = [
    { role: "user", content: "前文🙂\r\n\u0000\"\\\ud800" },
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "done", name: "read_file",
      arguments: { nested: [1e-7, 1e22, -0, true, false, null, "中文🙂\udc00\t"] } }] },
    { role: "tool", toolCallId: "done", content: "actual answer" },
  ];
  const port: SubagentRoutingPort = {
    choose: async () => ({ path: "fork", reason: "learned_policy", candidateIds: ["independent", "fork"], versionId: "routing:existing" }),
    dispatched: async () => {}, finished: async () => {},
  };
  const result = await chooseSubagentRouting(port, { executionId: "bounded", message: "Use the parent data", parentMessages: parent,
    signal: new AbortController().signal });

  assert.equal(result.receipt.actualPath, "fork");
  assert.equal(result.receipt.decision.versionId, "routing:existing");
  assert.equal(result.receipt.conditions.parentBytes, Buffer.byteLength(JSON.stringify(parent), "utf8"));
  assert.equal(isSubagentRoutingReceipt(JSON.parse(JSON.stringify(result.receipt))), true, "old numeric checkpoint remains readable");
});
