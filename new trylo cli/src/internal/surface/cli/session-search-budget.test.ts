import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enrichSessions } from "./session-list.js";

test("session search reads only matching journals, including display-name matches", async (t) => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "trylo-session-search-"));
  const ids = ["desktop-current", "unrelated", "named-session"];

  for (const id of ids) fs.writeFileSync(join(dir, `${id}.ndjson`), "");

  fs.writeFileSync(join(dir, "named-session.meta.json"), JSON.stringify({ version: 1, displayName: "CURRENT task" }));
  const reads: string[] = [];
  const originalRead = fs.readFileSync;

  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0]));
    return originalRead(...args);
  });
  syncBuiltinESMExports();

  try {
    const ctx = { readDir: () => ids.map(name => ({ name: `${name}.ndjson`, bytes: 0, modifiedAtMs: 1 })) };
    const rows = await enrichSessions(ctx, dir, 100, "current");
    assert.deepEqual(rows.map(row => row.id), ["desktop-current", "named-session"]);
    assert.equal(reads.some(path => path.endsWith("unrelated.ndjson")), false);
    assert.equal(reads.some(path => path.endsWith("desktop-current.ndjson")), true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
