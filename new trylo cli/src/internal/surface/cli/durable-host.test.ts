import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { SessionPort } from "../../ports/session.js";
import { createFakePermission } from "../../loop/fakes.js";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";

function fixture() {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-progress-host-"));
  const store = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const output: string[] = [];
  const input: TurnHostInput = {
    text: "write and read back", sessionId: "s", turnId: "t", correlationId: "c",
    workspaceRoot: root, workspaceId: "w", checkpointRoot: join(root, "undo"),
    providerId: "fixture-write", model: "m", endpoint: "", apiKey: undefined,
    permission: createFakePermission("approved"), format: "stream-json", session: store,
    sink: { stdout: text => output.push(text), stderr: text => output.push(text) }, now: () => 0,
  };

  return { root, store, input, output };
}

async function start(store: SessionPort) {
  assert.deepEqual(await store.start({
    sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z",
    fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture-write", model: "m", toolCatalogHash: "h" },
  }), { ok: true });
}

test("host durable composition: the real workspace write follows its fsynced intent; finish has no duplicate facts", async () => {
  const fx = fixture();
  try {
    await start(fx.store);
    let sawIntent = false;
    const session: SessionPort = {
      ...fx.store,

      async append(record) {
        if (record.type === "effect_issued" && record.payload.key === "tool:fx-write-1") {
          assert.equal(existsSync(join(fx.root, "fixture-output.txt")), false);
          sawIntent = true;
        }
        return fx.store.append(record);
      },
    };
    const result = await executeTurn({ ...fx.input, session });

    assert.equal(isTurnFailure(result), false);

    if (isTurnFailure(result)) return;

    assert.equal(result.exitCode, 0);
    assert.equal(sawIntent, true);
    const records = await fx.store.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) return;

    const items = records.view.records.filter(record => record.type === "transcript_item");

    assert.deepEqual(items.map(record => record.payload), result.transcript);
    assert.equal(new Set(items.map(record => record.payload.sequence)).size, items.length);
    assert.equal(records.view.records.filter(record => record.type === "turn_start").length, 1);
    assert.equal(records.view.records.filter(record => record.type === "terminal").length, 1);
    const read = await fx.store.read();

    assert.equal(read.ok, true);

    if (read.ok) assert.deepEqual(read.session.reconcileRequired, []);
  } finally {
    await fx.store.release();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

for (const failureType of ["effect_issued", "effect_committed", "terminal"] as const) {
  test("host durable composition: " + failureType + " write failure is visible and cannot print a completed result", async () => {
    const fx = fixture();
    try {
      await start(fx.store);
      const session: SessionPort = {
        ...fx.store,
        append: record => record.type === failureType
          ? Promise.resolve({ ok: false, code: "disk_full" })
          : fx.store.append(record),
      };
      const result = await executeTurn({ ...fx.input, session });

      assert.equal(isTurnFailure(result), true);

      if (!isTurnFailure(result)) return;

      assert.equal(result.exitCode, 52);
      assert.match(result.message, /execution_progress_failed.*disk_full/);
      assert.equal(fx.output.some(line => line.includes('"type":"result"') && line.includes('"status":"completed"')), false);

      if (failureType === "effect_issued") assert.equal(existsSync(join(fx.root, "fixture-output.txt")), false);

      if (failureType === "terminal") assert.equal(existsSync(join(fx.root, "fixture-output.txt")), true);

      const beforeRetry = await fx.store.readRecords();
      const second = await executeTurn({ ...fx.input, session, turnId: "t-next" });

      assert.equal(isTurnFailure(second), true, "a durability failure must close this opened session");
      assert.deepEqual(await fx.store.readRecords(), beforeRetry, "retry must not append facts or execute tools");
    } finally {
      await fx.store.release();
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
}
