import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptySnapshot } from "../learning/profile/resolver.js";
import { loadLastKnownGood, saveLastKnownGood } from "./lkg.js";

test("corrupt last-known-good checksum is ignored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-lkg-"));
  try {
    const snapshot = emptySnapshot("user", 1, "full", []);

    await saveLastKnownGood(dir, snapshot);
    await writeFile(
      path.join(dir, "last-known-good.json"),
      JSON.stringify({ checksum: "nope", snapshot }),
      "utf8",
    );
    const loaded = await loadLastKnownGood(dir);

    assert.equal(loaded, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saved last-known-good round-trips", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-lkg-"));
  try {
    const snapshot = emptySnapshot("user", 3, "full", []);
    await saveLastKnownGood(dir, snapshot);
    const loaded = await loadLastKnownGood(dir);
    assert.equal(loaded?.snapshotHash, snapshot.snapshotHash);
    assert.equal(loaded?.createdFromBoardSequence, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable LKG degrades to a miss and the next write heals it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-lkg-"));
  try {
    // A directory where the file belongs reads as EISDIR. The LKG is a cache:
    // any unusable form degrades to "absent", and the next successful write
    // replaces the file (asserted below) rather than a turn failing over a
    // derived file.
    await mkdir(path.join(dir, "last-known-good.json"));
    assert.equal(await loadLastKnownGood(dir), undefined);
    await rm(path.join(dir, "last-known-good.json"), { recursive: true, force: true });
    const snapshot = emptySnapshot("user", 7, "full", []);

    await saveLastKnownGood(dir, snapshot);
    const healed = await loadLastKnownGood(dir);

    assert.equal(healed?.createdFromBoardSequence, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unparseable LKG degrades to absent and rebuilds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-lkg-"));
  try {
    await writeFile(path.join(dir, "last-known-good.json"), "not json", "utf8");
    assert.equal(await loadLastKnownGood(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a foreign-shaped LKG degrades to absent rather than being guessed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-lkg-"));
  try {
    await writeFile(path.join(dir, "last-known-good.json"), "42", "utf8");
    assert.equal(await loadLastKnownGood(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
