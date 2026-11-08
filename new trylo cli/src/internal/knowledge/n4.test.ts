import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJournal } from "../journal/index.js";
import { bindContextPort } from "./assemble.js";
import { createIngest } from "./ingest.js";
import { isVerified } from "./outcome.js";
import { createFragmentStore } from "./store.js";

async function withDir(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "trylo-n4-1h-"));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("2: correction is effective; inferred candidate is invisible to assemble", async () => {
  await withDir(async (rootDir) => {
    const store = createFragmentStore(rootDir);
    const ingest = createIngest(store);
    const assemble = bindContextPort(store).assemble;

    await ingest.recordCorrection("run the designated check first", "user");
    await ingest.appendCandidate("skip the check next time");
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some((item) => item.body === "run the designated check first"),
      true,
    );
    assert.equal(
      assembled.systemFragments.some((item) => item.body === "skip the check next time"),
      false,
    );
  });
});

test("3: assemble failure returns empty fragments and keeps messages", async () => {
  await withDir(async (rootDir) => {
    await writeFile(path.join(rootDir, "fragments.json"), "{not-an-array}", "utf8");
    const messages = [{ role: "user", content: "keep" }];
    const assembled = await bindContextPort(createFragmentStore(rootDir)).assemble({
      messages,
    });

    assert.deepEqual(assembled.systemFragments, []);
    assert.deepEqual(assembled.messages, messages);
    assert.equal(assembled.degradedReason?.code, "board_unavailable");
  });
});

test("4: collect=false journal.project is empty", () => {
  const journal = createJournal();
  journal.record({ eventId: "e1", kind: "turn_end" });
  assert.deepEqual(journal.project({ collect: false }), []);
});

test("withdraw hides an effective fragment from the next assemble", async () => {
  await withDir(async (rootDir) => {
    const store = createFragmentStore(rootDir);
    const ingest = createIngest(store);
    const assemble = bindContextPort(store).assemble;
    const written = await ingest.recordCorrection("always run the check", "user");

    await ingest.withdraw(written.id);
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some((item) => item.id === written.id),
      false,
    );
    const stored = await store.readAll();

    assert.equal(stored.find((item) => item.id === written.id)?.state, "withdrawn");
  });
});

test("remove deletes a fragment so assemble cannot see it", async () => {
  await withDir(async (rootDir) => {
    const store = createFragmentStore(rootDir);
    const ingest = createIngest(store);
    const assemble = bindContextPort(store).assemble;
    const written = await ingest.recordCorrection("delete this rule", "user");

    await ingest.remove(written.id);
    const stored = await store.readAll();

    assert.equal(stored.some((item) => item.id === written.id), false);
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some((item) => item.body === "delete this rule"),
      false,
    );
  });
});

test("5+6: verified defaults false; learning result has no permission fields", async () => {
  await withDir(async (rootDir) => {
    const assembled = await bindContextPort(createFragmentStore(rootDir)).assemble();

    assert.equal(assembled.verified, false);
    assert.equal(isVerified({ turn: { finish: "completed" } }), false);
    assert.deepEqual(assembled.requiredChecks, []);
    assert.equal("permission" in assembled, false);
    assert.equal("allow" in assembled, false);
    assert.equal("grants" in assembled, false);
  });
});
