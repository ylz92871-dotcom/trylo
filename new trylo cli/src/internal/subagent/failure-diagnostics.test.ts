import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderErrorClass, ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import { createChildAttemptWorker } from "./child-attempt.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import { SubagentRuntime } from "./runtime.js";

const tools: ToolPort = { snapshot: () => [], execute: async () => ({ outcome: "error", code: "unexpected", message: "unexpected" }), cancel: async () => {} };
const permission = { request: async () => { throw new Error("unexpected approval"); }, awaitDecision: async () => { throw new Error("unexpected approval"); } };
for (const kind of ["delegate", "interactive"] as const) {
  for (const errorClass of ["auth", "rate_limit", "invalid_request", "network"] satisfies ProviderErrorClass[]) {
    test(`${kind}: the parent receives the ${errorClass} cause instead of an undifferentiated failed`, async () => {
      const message = `diagnostic-${errorClass}-8291`;
      const provider: ProviderPort = { async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "error", class: errorClass, retryable: false, phase: "before_headers", message };
      } };
      const options = { provider, permission, model: "test" };
      const worker = kind === "delegate" ? createChildAttemptWorker({ ...options, prompt: "work" }) : createInteractiveChildWorker({ ...options, message: "work" });
      const runtime = new SubagentRuntime({ tools });
      const handle = runtime.spawn<unknown>({ name: kind, worker, permissions: { allowedTools: [] }, lineage: { parentAgentId: "parent", rootAttemptId: "root" } });
      const result = await handle.wait();
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, errorClass);
      assert.match(result.error?.message ?? "", new RegExp(message));
    });
  }
}
