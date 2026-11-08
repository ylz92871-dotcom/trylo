import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFileBoardStore } from "../../adapters/learning-store/file-event-store.js";
import { createRewardV2BoardPort, RewardV2BoardError } from "../reward/v2-board-port.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import type { ProviderPort } from "../../ports/provider.js";

const SCOPE = "project:c24-receipt-recovery", BUDGET = "budget:c24-receipts";
const PUBLIC_TEXT = "Original public observation for the remaining learning question. ".repeat(360);

function request(operationId: string): CentralDeliberationRequest {
  return { schemaVersion: 1, scope: SCOPE, budgetId: BUDGET, boardSequence: 0,
    resources: { boardSequence: 0, budgetId: BUDGET, limits: { tokens: 100000, calls: 4, steps: 4 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
    configuration: { schemaVersion: 1, configurationRef: "configuration:c24", authorizationRef: "authorization:c24",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
    stateRef: "state:c24", state: { schemaVersion: 1, scope: SCOPE, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [], materials: [{ ref: "source:c24", kind: "source", text: PUBLIC_TEXT, sourceRefs: ["source:c24"] }], organization: [],
    operation: { kind: "think", operationId, purpose: "Choose useful bounded research.", expectedChange: "Resolve the next original question.", sourceRefs: ["source:c24"] } };
}

function payload(operationId: string): { readonly request: CentralDeliberationRequest; readonly output: CentralDeliberationOutput } {
  return { request: request(operationId), output: { schemaVersion: 1, intents: [], publicExplanation: "Wait for actual use feedback.", sourceRefs: ["source:c24"] } };
}

type Fault = "not_started" | "ack_lost" | "unknown" | "none";

async function fixture(t: TestContext, firstFault: Fault) {
  const root = await mkdtemp(join(tmpdir(), "trylo-c24-receipts-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const board = createRewardV2BoardPort(root, () => true);
  const counts = { reads: 0, append: 0, batch: 0, entered: 0, batchSizes: [] as number[] };
  let fault = firstFault;

  async function invoke<T>(write: () => Promise<T>): Promise<T> {
    const next = fault;
    fault = "none";

    if (next === "not_started") throw new RewardV2BoardError("multi_writer", "not_started");

    if (next === "unknown") throw new RewardV2BoardError("multi_writer");

    counts.entered += 1;
    const result = await write();

    if (next === "ack_lost") throw new Error("scripted acknowledgement lost after the original append completed");

    return result;
  }

  const wrapped: ReturnType<typeof createRewardV2BoardPort> = {
    read: async () => {
      counts.reads += 1;
      return board.read();
    },

    append: (...args) => {
      counts.append += 1;
      return invoke(() => board.append(...args));
    },

    appendBatch: (...args) => {
      counts.batch += 1;
      counts.batchSizes.push(args[1].length);
      const appendBatch = board.appendBatch;
      if (appendBatch === undefined) throw new Error("the original Board does not provide batch append");
      return invoke(() => appendBatch(...args));
    },
  };
  const options = { boardRoot: root, scope: SCOPE, budgetId: BUDGET, enabled: () => true };
  const store = createCentralDeliberationReceiptsAtRoot({ ...options, board: wrapped });

  return { root, board, counts, store, cold: () => createCentralDeliberationReceiptsAtRoot(options) };
}

test("receipt persistence retries only proved non-entry, confirms complete lost acknowledgements, and fences unknown writes before another funded thought", async t => {
  // A known pre-entry refusal can retry the same deterministic batch. It does
  // not poison the next operation or change the original response body.
  {
    const f = await fixture(t, "not_started"), input = payload("operation:c24-contention");
    const saved = await f.store.save(input);

    assert.deepEqual(saved.request, input.request);
    assert.deepEqual(saved.output, input.output);
    assert.equal(f.counts.append, 0);
    assert.equal(f.counts.batch, 2);
    assert.equal(f.counts.entered, 1);
    assert.ok(f.counts.batchSizes.every(size => size > 2), "the real long payload contains multiple chunks and its manifest");
    assert.deepEqual(await f.cold().read(input.request.operation.operationId), saved);
    const before = f.counts.batch, next = payload("operation:c24-after-contention");
    const nextSaved = await f.store.save(next);

    assert.equal(f.counts.batch - before, 1, "normal multi-chunk persistence has one original batch admission");
    assert.equal(f.counts.append, 0);
    assert.equal(f.counts.entered, 2);
    assert.deepEqual(await f.cold().read(next.request.operation.operationId), nextSaved);
  }

  // All original facts are durable before the injected acknowledgement loss.
  // Exact readback confirms that same payload without issuing another append.
  {
    const f = await fixture(t, "ack_lost"), input = payload("operation:c24-lost-ack");
    const saved = await f.store.save(input), prefix = await f.board.read();

    assert.equal(f.counts.append, 0);
    assert.equal(f.counts.batch, 1);
    assert.equal(f.counts.entered, 1);
    assert.ok(f.counts.batchSizes[0]! > 2);
    assert.equal(prefix.facts.length, f.counts.batchSizes[0]);
    assert.equal(new Set(prefix.facts.map(fact => fact.id)).size, prefix.facts.length);
    assert.equal(prefix.facts.at(-1)?.id, saved.deliveryRef, "the original manifest remains the final fact");
    assert.deepEqual(await f.store.save(input), saved);
    assert.deepEqual(await f.cold().read(input.request.operation.operationId), saved);
    assert.deepEqual(await f.board.read(), prefix);
    assert.equal(f.counts.batch, 1);
    assert.equal(f.counts.append, 0);
  }

  // The same reason without a non-entry proof remains unknown. Absent original
  // facts cannot become a delivery, a retry right, or another funded call.
  {
    const f = await fixture(t, "unknown"), input = payload("operation:c24-unknown");

    await assert.rejects(f.store.save(input), /central_deliberation_receipt_write_unconfirmed/);
    assert.equal(f.counts.append, 0);
    assert.equal(f.counts.batch, 1);
    assert.equal(f.counts.entered, 0);
    assert.equal(await f.cold().read(input.request.operation.operationId), undefined);
    await assert.rejects(f.store.save(payload("operation:c24-after-unknown")), /central_deliberation_receipt_writer_suspended/);
    const calls = { inspect: 0, reserve: 0, settle: 0, provider: 0 };

    async function* stream() {
      calls.provider += 1;
      throw new Error("a suspended receipt must not reach the provider");
    }

    const provider: ProviderPort = { stream, fork: () => ({ stream }) };
    const model = createCentralModelDeliberation({ provider, model: "scripted-c24-zero-http", outputMode: "tool", receipts: f.store,
      funding: {
        async inspect() {
          calls.inspect += 1;
          throw new Error("a suspended receipt must not inspect funding");
        },

        async reserve() {
          calls.reserve += 1;
          throw new Error("a suspended receipt must not reserve funding");
        },

        async settle() {
          calls.settle += 1;
          throw new Error("a suspended receipt cannot require settlement");
        },
      } });
    const notSent = (error: unknown): boolean => {
      assert.ok(error instanceof CentralDeliberationError);
      assert.equal(error.reason, "central_deliberation_response_write_unconfirmed");
      assert.equal(error.delivery, "not_sent");
      assert.equal(error.receiptFailure?.reason, "central_deliberation_receipt_writer_suspended");
      return true;
    };

    await assert.rejects(model.prepareDelivery!(request("operation:c24-prepare-after-unknown"), new AbortController().signal), notSent);
    await assert.rejects(model.deliberate(request("operation:c24-thought-after-unknown"), new AbortController().signal), notSent);
    assert.deepEqual(calls, { inspect: 0, reserve: 0, settle: 0, provider: 0 });
    assert.equal(f.counts.batch, 1);
    assert.equal(f.counts.append, 0);
    assert.deepEqual((await f.board.read()).facts, []);
  }

  // A cancellation known before save enters neither append path and does not
  // suspend the writer used by a later non-cancelled original operation.
  {
    const f = await fixture(t, "none"), controller = new AbortController();
    controller.abort();
    const input = payload("operation:c24-cancelled");

    await assert.rejects(f.store.save(input, controller.signal), /central_deliberation_receipt_cancelled/);
    assert.equal(f.counts.reads, 0);
    assert.equal(f.counts.batch, 0);
    assert.equal(f.counts.append, 0);
    assert.equal(f.counts.entered, 0);
    assert.deepEqual((await f.board.read()).facts, []);
    const saved = await f.store.save(payload("operation:c24-after-cancel"));

    assert.equal(f.counts.batch, 1);
    assert.equal(f.counts.append, 0);
    assert.equal(f.counts.entered, 1);
    assert.deepEqual(await f.cold().read("operation:c24-after-cancel"), saved);
    // A real held original lock also stays cancellable during admission, before its callback can write.
    const held = createFileBoardStore(f.root);
    assert.ok("apply" in held);

    try {
      const cancelled = new AbortController();
      const attempt = f.board.append((await f.board.read()).revision, {
        id: "receipt-admission:cancelled", scope: SCOPE, algorithmVersion: "c24-admission", kind: "projection", payloadJson: "{}",
      }, cancelled.signal);

      await nextTurn();
      cancelled.abort();
      await assert.rejects(attempt, error => {
        assert.ok(error instanceof RewardV2BoardError);
        assert.equal(error.writeOutcome, "not_started");
        return true;
      });
    } finally { await held.close(); }

    assert.equal((await f.board.read()).facts.some(fact => fact.id === "receipt-admission:cancelled"), false);
  }
});
