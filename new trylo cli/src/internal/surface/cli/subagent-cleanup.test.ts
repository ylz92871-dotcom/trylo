import assert from "node:assert/strict";
import { test } from "node:test";
import { createDenyAllPermission } from "./permission.js";
import { wirePorts } from "./wiring.js";

test("closing the parent wiring cancels its children before releasing shared resources", async t => {
  const wired = wirePorts({ providerId: "fixture", model: "default", endpoint: "",
    apiKey: undefined, workspaceRoot: process.cwd(), permission: createDenyAllPermission(),
    subagent: { enabled: true } });
  assert.ok(!("code" in wired));
  if ("code" in wired) return;
  const runtime = wired.subagentRuntime;
  assert.ok(runtime);
  const child = runtime.spawn({ name: "parked", lineage: { parentAgentId: "main", rootAttemptId: "root", toolCallId: "call" },
    permissions: { allowedTools: [] },
    worker: async context => {
      await new Promise<void>(resolve => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } });
  t.after(async () => { await child.cancel(); await wired.close(); });
  await new Promise(resolve => setImmediate(resolve));
  await wired.close();
  assert.equal(child.status(), "cancelled");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.getActiveInstances().length, 0);
});
