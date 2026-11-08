import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { CliContext } from "./context.js";
import { openSession } from "./session-open.js";
import { sessionPath } from "./session-paths.js";

function context(homeDir: string): CliContext {
  return {
    homeDir, env: { TRYLO_HOME: homeDir }, cwd: homeDir, nodeVersion: "v24", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => false, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => prefix + "-fixed",
  };
}

const fingerprint = { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" };

for (const type of ["effect_issued", "compact"] as const) {
  test("resume composition refuses " + type + " that cannot be safely replayed, and releases the lock", async () => {
    const root = mkdtempSync(join(os.tmpdir(), "trylo-progress-resume-"));
    const ctx = context(root);
    const path = sessionPath(root, ctx.env, "s");
    const store = createNdjsonSessionStore({ path });

    try {
      await store.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z", fingerprint });
      await store.append({ type, sessionId: "s", turnId: "t", at: "1970-01-01T00:00:01Z",
        payload: type === "compact" ? {} : { key: "tool:c" },
      });
      await store.release();
      const opened = await openSession(ctx, { resume: "s", message: [], readStdin: false }, fingerprint);
      if (opened.kind === "resume") await opened.session.release();

      assert.equal(opened.kind, "failed");

      if (opened.kind !== "failed") return;

      assert.equal(opened.failure.exitCode, 52);
      assert.match(opened.failure.message, type === "compact" ? /cannot be projected/ : /reconciliation/);
      assert.equal(existsSync(path + ".lock"), false);
    } finally {
      await store.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
