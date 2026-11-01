import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRewardBoardPort } from "./board-port.js";
import { createRewardGateway } from "./gateway.js";
import { createRewardCatalog } from "../../learning/reward/catalog.js";
import { TOOL_EXECUTION_METRIC } from "./journal-sensor.js";
import type { RewardExposureDraft } from "../../learning/reward/contracts.js";

function exposure(i: number): RewardExposureDraft {
  return { schemaVersion: 1, id: `use-${i}`, source: { sessionId: "s", turnId: "t", attemptId: "a", eventId: `event-${i}` },
    context: { scope: "ws", taskFamily: "coding", environment: "v1", metric: TOOL_EXECUTION_METRIC },
    targets: [{ kind: "memory", id: "fact", version: "v1" }], occurredAt: 1 };
}

test("reward persistence: concurrent same-owner producers serialize; append acknowledgement loss retries exactly once", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reward-faults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fail = true;
  const ledger = createRewardBoardPort(root, { logAppender: (file, data, encoding) => {
    appendFileSync(file, data, encoding);
    if (fail) { fail = false; throw new Error("injected_acknowledgement_loss"); }
  } });
  assert.equal((await ledger.expose(exposure(0))).ok, false);
  const retry = await ledger.expose(exposure(0));
  assert.ok(retry.ok && retry.duplicate);
  const many = await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.expose(exposure(i + 1))));
  assert.ok(many.every(result => result.ok));
  const recovered = await createRewardBoardPort(root).read();
  assert.ok(recovered.ok);
  assert.equal(recovered.records.exposures.length, 9);
});

test("reward boundary: IO throws and collection revocation during read remain typed and never append feedback", async () => {
  let enabled = true;
  let writes = 0;
  const ledger = {
    expose: async () => { throw new Error("disk failed"); },
    feedback: async () => { writes++; return { ok: false as const, reason: "must not run" }; },
    read: async () => { enabled = false; return { ok: false as const, reason: "read_stopped" }; },
  };
  const port = createRewardGateway({ enabled: () => enabled, ledger,
    catalog: createRewardCatalog({ metrics: [TOOL_EXECUTION_METRIC], objectKinds: ["memory"] }),
    output: { replace: async () => { writes++; } }, degraded: () => {} });
  assert.deepEqual(await port.expose(exposure(0)), { ok: false, reason: "reward_ledger_unavailable" });
  assert.deepEqual(await port.signals("ws"), { ok: false, reason: "collect_disabled" });
  assert.equal(writes, 0);
});
