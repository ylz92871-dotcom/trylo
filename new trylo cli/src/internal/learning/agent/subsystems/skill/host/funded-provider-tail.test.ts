import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import type { CentralLearningGrant, CentralLearningUsage } from "../../../../control/coordination-contract.js";
import type { SkillCentralFunding } from "../control/contracts.js";
import { withSkillCentralFunding } from "./funded-provider.js";
import { consumeProviderStream } from "../../../../../loop/stream.js";

const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const warning: ProviderEvent = { type: "warning", code: "stream_finish_tail_timeout", message: "tail unavailable" };
const failure: ProviderEvent = { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "redacted failure" };
const usage = (inputTokens: number, outputTokens = 0): ProviderEvent => ({ type: "usage", usage: { mode: "snapshot",
  inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });
const request: ProviderRequest = { attemptId: "skill-tail", model: "fixture", messages: [{ role: "user", content: "bounded source" }], tools: [] };

function fixture(stream: ProviderPort["stream"], signal = new AbortController().signal, settle?: SkillCentralFunding["settle"]) {
  const settlements: CentralLearningUsage[] = [];
  let reserved = false;
  const grant: CentralLearningGrant = { schemaVersion: 2, grantId: "grant", issueId: "issue", scope: "workspace", jobId: "job",
    domain: "skill", focusRevision: 2, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20000,
      maxCalls: 4, maxSteps: 4, maxPromptChars: 12000 }, steps: 0, reservations: [], status: "open" };
  const remaining = { tokens: 20000, calls: 4, steps: 4 };
  const funding: SkillCentralFunding = {
    async inspect() { return { ok: true, active: !reserved, grant, remaining }; },
    async reserve() {
      reserved = true;
      return { ok: true, status: "reserved", grant, remaining };
    },
    async settle(input) { settlements.push(input.usage);
    return settle === undefined
      ? { ok: true, status: "settled", grant, remaining } : settle(input); },
  };
  const provider = withSkillCentralFunding({ stream }, { funding, newId: () => "reservation" });
  const events: ProviderEvent[] = [];
  const terminalBreak = async () => {
    for await (const event of provider.stream(request, signal)) {
      events.push(event);
      if (event.type === "finish") break;
    }
  };

  return { provider, signal, settlements, events, terminalBreak, funding };
}

test("terminal-break consumer sees finish only after post-finish usage tail was drained", async () => {
  let drained = false;
  const fx = fixture(async function* () {
    yield usage(100, 10);
    yield finish;
    yield usage(200, 20);
    drained = true;
  });
  await fx.terminalBreak();
  assert.equal(drained, true);
  assert.equal(fx.settlements[0]?.kind, "reported");
  if (fx.settlements[0]?.kind === "reported") assert.equal(fx.settlements[0].totalTokens, 220);
  assert.equal(fx.events.at(-1)?.type, "finish");
});

test("post-finish tail warning preserves unknown usage under terminal-break consumption", async () => {
  const fx = fixture(async function* () {
    yield usage(100);
    yield finish;
    yield warning;
  });
  await fx.terminalBreak();
  assert.equal(fx.settlements[0]?.kind, "unknown");
  assert.ok(fx.events.some(event => event.type === "warning"));
});

test("post-finish typed error preserves unknown usage and hides the buffered success terminal", async () => {
  const fx = fixture(async function* () {
    yield usage(100);
    yield finish;
    yield failure;
  });
  await fx.terminalBreak();
  assert.equal(fx.settlements[0]?.kind, "unknown");
  assert.ok(fx.events.some(event => event.type === "error"));
  assert.equal(fx.events.some(event => event.type === "finish"), false);
});

test("partial streams and consumers returning before a terminal remain unknown", async () => {
  const partial = fixture(async function* () { yield usage(100); });
  await partial.terminalBreak();
  assert.equal(partial.settlements[0]?.kind, "unknown");
  const early = fixture(async function* () {
    yield usage(100);
    yield finish;
  });
  for await (const event of early.provider.stream(request, early.signal)) {
    assert.equal(event.type, "usage");
    break;
  }
  assert.equal(early.settlements[0]?.kind, "unknown");
});

test("cancellation in the finish tail is not hidden by the terminal-break consumer", async () => {
  const controller = new AbortController();
  const fx = fixture(async function* () {
    yield usage(100);
    yield finish;
    controller.abort();
    yield { type: "cancel_ack" };
  }, controller.signal);
  await assert.rejects(fx.terminalBreak(), /learning_aborted/);
  assert.equal(fx.settlements[0]?.kind, "unknown");
});

test("observed overrun after finish preserves its measured lower bound", async () => {
  const fx = fixture(async function* () {
    yield usage(100);
    yield finish;
    yield usage(20000);
  });
  await assert.rejects(fx.terminalBreak(), /learning_grant_exhausted/);
  assert.equal(fx.settlements[0]?.kind, "reported");
  if (fx.settlements[0]?.kind === "reported") assert.equal(fx.settlements[0].totalTokens, 20000);
});

test("normal complete usage remains reported", async () => {
  const fx = fixture(async function* () {
    yield usage(100, 10);
    yield finish;
  });
  await fx.terminalBreak();
  assert.equal(fx.settlements[0]?.kind, "reported");
  if (fx.settlements[0]?.kind === "reported") assert.equal(fx.settlements[0].totalTokens, 110);
});

for (const ending of ["typed_failure", "rejected"] as const) {
  test(`actual Loop cannot accept skill finish when settlement is ${ending}`, async () => {
    const fx = fixture(async function* () {
      yield usage(100);
      yield finish;
    }, undefined, async () => {
      if (ending === "rejected") throw new Error("synthetic_settlement_io_failure");
      return { ok: false, reason: "board_unavailable" };
    });
    let event = 0;
    const observed = await consumeProviderStream({ port: fx.provider, request, signal: fx.signal,
      startSequence: 0, nextEventId: () => `settlement:${++event}` });

    assert.deepEqual({ sawFinish: observed.sawFinish, transportFailure: observed.inputs.some(input => input.type === "transport_fail"),
      settlementAttempts: fx.settlements.length }, { sawFinish: false, transportFailure: true, settlementAttempts: 1 });
  });
}

test("cancellation during confirmed settlement hides skill finish without changing its reported receipt", async () => {
  const controller = new AbortController();
  const fx = fixture(async function* () {
    yield usage(100);
    yield finish;
  }, controller.signal);
  const settle = fx.funding.settle;

  fx.funding.settle = async input => {
    const result = await settle(input);
    controller.abort();
    return result;
  };
  let event = 0;
  const observed = await consumeProviderStream({ port: fx.provider, request, signal: fx.signal,
    startSequence: 0, nextEventId: () => `confirmed-cancellation:${++event}` });

  assert.deepEqual({ sawFinish: observed.sawFinish, settlementAttempts: fx.settlements.length,
    usageKind: fx.settlements[0]?.kind }, { sawFinish: false, settlementAttempts: 1, usageKind: "reported" });
});
