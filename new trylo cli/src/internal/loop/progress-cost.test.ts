import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "./runner.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "./fakes.js";
import type { ProviderEvent } from "../ports/provider.js";

test("streaming flush submits each immutable envelope once instead of rescanning history", async () => {
  const submitted = new Map<string, number>();
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: createFakeTools([], []),
    provider: { async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "text_start", blockId: "b" };
      for (let i = 0; i < 128; i += 1) yield { type: "text_delta", blockId: "b", text: "hello " };
      yield { type: "text_end", blockId: "b" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } },
    progress: {
      async flush(facts) {
        for (const e of facts.envelopes) submitted.set(e.eventId, (submitted.get(e.eventId) ?? 0) + 1);
        return { ok: true };
      },
      async issue() { return { ok: true }; }, async settle() { return { ok: true }; },
    },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "go" });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(submitted.size, result.envelopes.length);
  assert.equal(Math.max(...submitted.values()), 1, "previous durable deltas must not be re-serialized on every token");
});
