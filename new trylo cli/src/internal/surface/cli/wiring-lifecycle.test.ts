import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { createDenyAllPermission } from "./permission.js";
import { wirePorts } from "./wiring.js";

test("two turns observe the same lent process registry; turn teardown does not stop its lender", async () => {
  let listed = 0;
  let stopped = 0;
  const sessions: ProcessSessionRegistry = {
    maxSessions: 1,
    start: async () => { throw new Error("unused start"); },
    write: async () => { throw new Error("unused write"); },
    stop: async () => { throw new Error("unused stop"); },
    get: () => undefined,

    list: () => {
      listed += 1;
      return { sessions: [] };
    },

    shutdown: async () => { stopped += 1; },
  };
  const input = {
    providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    workspaceRoot: process.cwd(), permission: createDenyAllPermission(),
    execution: { sessions, spawner: async () => { throw new Error("unused spawn"); }, close: sessions.shutdown },
  };

  for (let turn = 0; turn < 2; turn += 1) {
    const wiring = wirePorts(input);

    assert.ok(!("code" in wiring));
    const result = await wiring.ports.tools.execute({ toolCallId: "list", name: "list_processes", arguments: {} }, new AbortController().signal);

    assert.equal(result.outcome, "result");
    const close = Reflect.get(wiring, "close") as (() => Promise<void>) | undefined;

    assert.equal(typeof close, "function", "the turn must expose an owned-resource teardown");
    await close?.();
  }

  assert.equal(listed, 2, "each turn must consult the registry the prepared session lends");
  assert.equal(stopped, 0, "only the prepared session may end a lent process registry");
});
