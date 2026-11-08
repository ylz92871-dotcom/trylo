import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "./runner.js";
import { emptyProfileLoader, createFakePermission, createFakeTools } from "./fakes.js";
import type { ProviderEvent } from "../ports/provider.js";

test("reasoning and text reach the observer before the provider finishes", async () => {
  let release!: () => void;
  let blocked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { blocked = resolve; });
  const seen: string[] = [];
  const running = runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: createFakeTools([]),
    provider: { async *stream(): AsyncGenerator<ProviderEvent> {
      yield { type: "stream_start", providerId: "fixture", model: "live", warnings: [] };
      yield { type: "reasoning_start", blockId: "r", redacted: false };
      yield { type: "reasoning_delta", blockId: "r", text: "first", redacted: false };
      yield { type: "text_start", blockId: "t" };
      yield { type: "text_delta", blockId: "t", text: "hello" };
      blocked();
      await gate;
      yield { type: "reasoning_end", blockId: "r" };
      yield { type: "text_end", blockId: "t" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } },
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "hello", onEnvelope: e => { seen.push(e.kind); } });

  try {
    await waiting;
    assert.ok(seen.includes("thinking"), "received reasoning must be visible while the stream is still open");
    assert.ok(seen.includes("text"), "received text must be visible while the stream is still open");
  } finally {
    release();
    await running;
  }
});
