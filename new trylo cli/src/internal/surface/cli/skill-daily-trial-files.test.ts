import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replayFileDigest, replayInputsUnchanged } from "./skill-daily-trial-files.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-frozen-replay-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "source.json"), '{"rows":[1,2,3]}');
  await writeFile(path.join(root, "nested/check.mjs"), "process.exit(1);\n");
  const hashes = Object.fromEntries(await Promise.all(["source.json", "nested/check.mjs"].map(async file => [file, replayFileDigest(await readFile(path.join(root, file)))])));

  return { root, hashes };
}

test("independent replay accepts unchanged input bytes while permitting genuinely new outputs", async t => {
  const fx = await fixture(t);
  await writeFile(path.join(fx.root, "output.json"), '{"total":6}');
  await writeFile(path.join(fx.root, "large-new-output.bin"), Buffer.alloc(2_097_152));
  assert.equal(await replayInputsUnchanged(fx.root, fx.hashes), true);
});

test("an oversized initial input is refused even when its claimed digest matches", async t => {
  const fx = await fixture(t), oversized = Buffer.alloc(1_048_577, 7);
  await writeFile(path.join(fx.root, "source.json"), oversized);
  assert.equal(await replayInputsUnchanged(fx.root, { "source.json": replayFileDigest(oversized) }), false);
});

test("a model cannot improve the verifier result by changing source data or checker", async t => {
  const fx = await fixture(t);
  await writeFile(path.join(fx.root, "source.json"), '{"rows":[]}');
  assert.equal(await replayInputsUnchanged(fx.root, fx.hashes), false);
  await writeFile(path.join(fx.root, "source.json"), '{"rows":[1,2,3]}');
  await writeFile(path.join(fx.root, "nested/check.mjs"), "process.exit(0);\n");
  assert.equal(await replayInputsUnchanged(fx.root, fx.hashes), false);
});

test("missing, replaced, or outside-workspace replay inputs are not silently accepted", async t => {
  const fx = await fixture(t);
  await unlink(path.join(fx.root, "source.json"));
  assert.equal(await replayInputsUnchanged(fx.root, fx.hashes), false);
  assert.equal(await replayInputsUnchanged(fx.root, { "../outside.json": "hash" }), false);
});
