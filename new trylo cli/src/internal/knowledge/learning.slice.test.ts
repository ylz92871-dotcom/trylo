import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJournal } from "../journal/index.js";
import { bindContextPort } from "./assemble.js";
import { createIngest } from "./ingest.js";
import { createFragmentStore } from "./store.js";

async function withSlice(
  run: (ports: {
    ingest: ReturnType<typeof createIngest>;
    assemble: ReturnType<typeof bindContextPort>["assemble"];
    store: ReturnType<typeof createFragmentStore>;
    journal: ReturnType<typeof createJournal>;
    rootDir: string;
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "trylo-n4-"));
  const store = createFragmentStore(rootDir);
  const ingest = createIngest(store);
  const context = bindContextPort(store);
  const journal = createJournal();

  try {
    await run({
      ingest,
      assemble: (input) => context.assemble(input),
      store,
      journal,
      rootDir,
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("recordCorrection is active and the next assemble contains the body", async () => {
  await withSlice(async ({ ingest, assemble }) => {
    await ingest.recordCorrection("never grant extra tools from memory", "user correction");
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some(
        (fragment) => fragment.body === "never grant extra tools from memory",
      ),
      true,
    );
  });
});

test("appendCandidate stays pending and assemble does not include the body", async () => {
  await withSlice(async ({ ingest, assemble, store }) => {
    const candidate = await ingest.appendCandidate("maybe extract a method later");

    assert.equal(candidate.state, "pending");
    const stored = await store.readAll();

    assert.equal(stored.find((fragment) => fragment.id === candidate.id)?.state, "pending");
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some(
        (fragment) => fragment.body === "maybe extract a method later",
      ),
      false,
    );
  });
});

test("withdrawn fragments are invisible to assemble", async () => {
  await withSlice(async ({ assemble, store }) => {
    await store.write({
      id: "withdrawn-1",
      type: "user",
      origin: "user-stated",
      scope: "user",
      version: 1,
      state: "withdrawn",
      body: "this correction was withdrawn",
    });
    const assembled = await assemble();

    assert.equal(
      assembled.systemFragments.some(
        (fragment) => fragment.body === "this correction was withdrawn",
      ),
      false,
    );
  });
});

test("journal.project({ collect: false }) is empty", async () => {
  await withSlice(async ({ journal, ingest }) => {
    await ingest.recordCorrection("visible to assemble only", "not a journal collect");
    const projection = journal.project({ collect: false });
    assert.deepEqual(projection, []);
  });
});

test("assemble failure is equivalent to empty fragments and keeps messages", async () => {
  await withSlice(async ({ assemble, rootDir }) => {
    await writeFile(path.join(rootDir, "fragments.json"), "{not-an-array}", "utf8");
    const messages = [{ role: "user", content: "keep" }];
    const assembled = await assemble({ messages });
    assert.deepEqual(assembled.systemFragments, []);
    assert.deepEqual(assembled.messages, messages);
    assert.equal(assembled.degradedReason?.code, "board_unavailable");
  });
});
