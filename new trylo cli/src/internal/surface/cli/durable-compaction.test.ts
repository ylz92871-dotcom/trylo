import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createFakePermission } from "../../loop/fakes.js";
import type { SessionPort } from "../../ports/session.js";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";

for (const failure of ["read", "window", "append"] as const) {
  test("live compaction " + failure + " failure stops the durable finish with its original classification", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "trylo-compact-failure-"));
    const store = createNdjsonSessionStore({ path: join(root, "s.ndjson") });
    const output: string[] = [];
    let reached = false;
    const session: SessionPort = {
      ...store,

      async readRecords() {
        reached = true;
        if (failure === "read") return { ok: false, code: "checksum_mismatch", detail: "injected" };
        if (failure === "window") return { ok: true, view: { records: [], tornTail: false } };
        return store.readRecords();
      },

      append: record => record.type === "compact" && failure === "append"
        ? Promise.resolve({ ok: false, code: "disk_full" }) : store.append(record),
    };
    const input: TurnHostInput = {
      text: "write and read back ".repeat(100), sessionId: "s", turnId: "t", correlationId: "c",
      workspaceRoot: root, workspaceId: "w", checkpointRoot: join(root, "undo"),
      providerId: "fixture-write", model: "m", endpoint: "", apiKey: undefined,
      permission: createFakePermission("approved"), format: "stream-json", session,
      contextTokenLimit: 10, sink: { stdout: line => output.push(line), stderr: line => output.push(line) }, now: () => 0,
    };

    try {
      await store.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z",
        fingerprint: { schemaVersion: "1", workspaceId: "w", providerId: "fixture-write", model: "m", toolCatalogHash: "h" },
      });
      const result = await executeTurn(input);

      assert.equal(reached, true, "the real loop must author a window before injecting persistence failure");
      assert.equal(isTurnFailure(result), true);

      if (!isTurnFailure(result)) return;

      assert.equal(result.exitCode, 52);
      const code = failure === "read" ? "checksum_mismatch" : failure === "window" ? "window_not_on_journal" : "disk_full";

      assert.match(result.message, new RegExp("execution_progress_failed.*" + code));
      assert.equal(output.some(line => line.includes('"type":"run_result"')), false);
    } finally {
      await store.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
