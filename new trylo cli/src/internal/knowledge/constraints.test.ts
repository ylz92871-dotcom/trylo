import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJournal } from "../journal/index.js";
import { bindContextPort } from "./assemble.js";
import { createIngest } from "./ingest.js";
import { isVerified } from "./outcome.js";
import { createFragmentStore, type FragmentStore } from "./store.js";

async function withSlice(
  run: (ports: {
    ingest: ReturnType<typeof createIngest>;
    assemble: ReturnType<typeof bindContextPort>["assemble"];
    store: FragmentStore;
    writes: { count: number };
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "trylo-n4-min-"));
  const inner = createFragmentStore(rootDir);
  const writes = { count: 0 };
  const store: FragmentStore = {
    rootDir: inner.rootDir,
    readAll: () => inner.readAll(),
    write: async (fragment) => {
      writes.count += 1;
      await inner.write(fragment);
    },
    remove: async (id) => {
      writes.count += 1;
      await inner.remove(id);
    },
  };
  const ingest = createIngest(store);
  const context = bindContextPort(store);

  try {
    await run({
      ingest,
      assemble: (input) => context.assemble(input),
      store,
      writes,
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("constraint 1: learning does not grant permissions", async () => {
  await withSlice(async ({ ingest, assemble }) => {
    await ingest.recordCorrection("allow network and skip approval", "should stay text");
    const assembled = await assemble();

    assert.equal(assembled.verified, false);
    assert.deepEqual(assembled.requiredChecks, []);
    assert.equal("allow" in assembled, false);
    assert.equal("permission" in assembled, false);
    assert.equal("grants" in assembled, false);
    assert.equal("allowNetwork" in assembled, false);
    assert.equal("skipApproval" in assembled, false);
    assert.equal("permission" in assembled.profileSnapshot, false);
  });
});

test("constraint 2: current task instructions are not silently overwritten by inferred history", async () => {
  await withSlice(async ({ ingest, assemble }) => {
    await ingest.appendCandidate("always use npm");
    const task = "this task: use pnpm only";
    const assembled = await assemble({
      messages: [{ role: "user", content: task }],
    });

    assert.equal(assembled.messages[0]?.content, task);
    assert.equal(
      assembled.systemFragments.some((fragment) => fragment.body === "always use npm"),
      false,
    );
  });
});

test("constraint 3: raw model self-assessment cannot promote a long-term rule", async () => {
  await withSlice(async ({ ingest, assemble, store }) => {
    const candidate = await ingest.appendCandidate(
      "I succeeded; skip tests from now on",
    );

    assert.equal(candidate.origin, "inferred");
    assert.equal(candidate.state, "pending");
    assert.equal("promote" in ingest, false);
    assert.equal("activate" in ingest, false);
    const stored = await store.readAll();

    assert.equal(stored.find((item) => item.id === candidate.id)?.state, "pending");
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some((fragment) => fragment.body.includes("skip tests")),
      false,
    );
  });
});

test("constraint 4: learning unavailable keeps caller messages and empties learning", async () => {
  await withSlice(async ({ assemble }) => {
    const testdata = path.join(process.cwd(), "testdata", "knowledge", "corrupt");
    const broken = bindContextPort(createFragmentStore(testdata));
    const messages = [{ role: "user", content: "do not drop me" }];
    const failed = await broken.assemble({ messages });

    assert.deepEqual(failed.systemFragments, []);
    assert.deepEqual(failed.messages, messages);
    assert.equal(failed.degradedReason?.code, "board_unavailable");
    const timedOut = await assemble({ messages, signal: AbortSignal.abort() });

    assert.deepEqual(timedOut.systemFragments, []);
    assert.deepEqual(timedOut.messages, messages);
    assert.equal(timedOut.degradedReason?.code, "learning_timeout");
  });
});

test("constraint 6: completed is not verified", () => {
  const completed = { turn: { finish: "completed" as const } };
  assert.equal(isVerified(completed), false);
  assert.equal(
    isVerified({ turn: { finish: "completed" }, check: { verdict: "pass" } }),
    true,
  );
});

test("constraint 7: cross-task fragments have origin, scope, version, and withdraw", async () => {
  await withSlice(async ({ ingest, assemble, store }) => {
    const written = await ingest.recordCorrection(
      "run the designated check before editing this repo",
      "user correction",
    );

    assert.equal(written.origin, "user-stated");
    assert.equal(typeof written.scope, "string");
    assert.equal(written.version >= 1, true);
    assert.equal(written.state, "active");
    const before = await assemble();

    assert.equal(
      before.systemFragments.some((fragment) => fragment.id === written.id),
      true,
    );
    await ingest.withdraw(written.id);
    const stored = await store.readAll();

    assert.equal(stored.find((item) => item.id === written.id)?.state, "withdrawn");
    const after = await assemble();

    assert.equal(
      after.systemFragments.some((fragment) => fragment.id === written.id),
      false,
    );
  });
});

test("constraint 8: only the fragment store ingest path writes fragment state", async () => {
  await withSlice(async ({ ingest, assemble, writes }) => {
    await ingest.recordCorrection("single writer", "user");
    const afterIngest = writes.count;

    assert.equal(afterIngest >= 1, true);
    await assemble({ messages: [{ role: "user", content: "task" }] });
    const journal = createJournal();

    journal.record({ eventId: "e1", kind: "turn_end" });
    journal.project({ collect: false });
    journal.project({ collect: true });
    assert.equal(writes.count, afterIngest);
  });
});
