import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindContextPort } from "./assemble.js";
import { createFragmentStore, ensureMigrated } from "./store.js";

test("legacy fragments.json is imported into the board and retired", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-mig-"));
  try {
    await copyFile(
      path.join(process.cwd(), "testdata", "knowledge", "active", "fragments.json"),
      path.join(dir, "fragments.json"),
    );
    await ensureMigrated(dir);
    const migrated = await stat(path.join(dir, "fragments.json.migrated"));

    assert.equal(migrated.isFile(), true);
    const store = createFragmentStore(dir);
    const all = await store.readAll();

    assert.equal(
      all.some((item) => item.body === "run the designated check before editing this repo"),
      true,
    );
    const assembled = await bindContextPort(store).assemble({
      messages: [{ role: "user", content: "task" }],
    });

    assert.equal(
      assembled.systemFragments.some(
        (item) => item.body === "run the designated check before editing this repo",
      ),
      true,
    );
    assert.equal(assembled.profileSnapshot.learningMode, "full");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
