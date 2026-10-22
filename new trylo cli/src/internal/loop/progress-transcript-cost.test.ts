import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleEngine } from "./runner-engine.js";
import { runTurn } from "./runner.js";
import { flushProgress } from "./progress.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "./fakes.js";
import type { ProviderEvent } from "../ports/provider.js";
import type { ExecutionProgressPort } from "../ports/execution-progress.js";
import type { Transcript } from "../protocol/transcript.js";

const request = { sessionId: "s", turnId: "t", correlationId: "c", text: "continue" };
const finish = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false } as const;

function ports(progress: ExecutionProgressPort) {
  return {
    profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: createFakeTools([], []), progress,
    provider: { async *stream(): AsyncIterable<ProviderEvent> { yield finish; } },
  };
}

test("reasoning deltas do not repeatedly submit acknowledged large history", async () => {
  const text = "synthetic history ".repeat(16_384);
  const history: Transcript = [{ kind: "user", sequence: 0, text }];
  let historySubmissions = 0;
  let beforeDeltas = 0;
  let afterDeltas = 0;
  const progress: ExecutionProgressPort = {
    async flush(facts) {
      historySubmissions += facts.transcript.filter(item => item.sequence === 0).length;
      return { ok: true };
    },
    async issue() { return { ok: true }; }, async settle() { return { ok: true }; },
  };
  const result = await runTurn({
    ...ports(progress),
    provider: { async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "reasoning_start", blockId: "r", redacted: false };
      beforeDeltas = historySubmissions;
      for (let i = 0; i < 128; i++) yield {
        type: "reasoning_delta", blockId: "r", text: "synthetic reasoning ", redacted: false,
      };
      afterDeltas = historySubmissions;
      yield { type: "reasoning_end", blockId: "r" };
      yield finish;
    } },
  }, { ...request, resumedTranscript: history });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(afterDeltas - beforeDeltas, 0, "received reasoning must not resubmit unchanged durable history");
  assert.ok(result.transcript.some(item => item.kind === "user" && item.text === text));
});

test("only an acknowledged transcript may be omitted; replacements still reach persistence", async () => {
  const submissions: Transcript[] = [];
  let fail = true;
  const progress: ExecutionProgressPort = {
    async flush(facts) {
      submissions.push(facts.transcript);
      if (fail) { fail = false; return { ok: false, code: "disk_full" }; }
      return { ok: true };
    },
    async issue() { return { ok: true }; }, async settle() { return { ok: true }; },
  };
  const setup = ports(progress);
  const engine = await assembleEngine(setup, request, new AbortController());
  await assert.rejects(flushProgress(engine, setup), /disk_full/);
  await flushProgress(engine, setup);
  assert.deepEqual(submissions[1], submissions[0], "a failed ack cannot consume history");
  await flushProgress(engine, setup);
  assert.deepEqual(submissions[2], [], "acknowledged unchanged history is omitted");
  const replacement: Transcript = [{ kind: "user", sequence: 41, text: "replacement view after a gap" }];
  engine.transcript = replacement;
  await flushProgress(engine, setup);
  assert.deepEqual(submissions[3], replacement, "changed and sparse transcript views must still be checked");
});
