import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { canonicalJson, sha256Hex } from "../../../../control/hash.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { createExperienceStore } from "./experience-store.js";
import type { MethodCard } from "../domain/contracts.js";

const AT = "2026-11-03T00:00:00.000Z";

async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-method-snapshot-version-"));
  try {
    const card: MethodCard = { schemaVersion: 1, hint: "Inspect first.", labels: [], appliesWhen: {},
      lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "repeat_call" } } };
    assert.ok((await createMethodBoardWriter(root).commitCard({ card, versionId: "v", proposalId: "p", evidenceId: "e",
      nicheId: "n", writeId: "card", sample: "synthetic", observedAt: AT })).ok);
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function compact(root: string) {
  const result = await withBoardWriter(root, async store => { const loaded = await store.load();
    assert.ok(loaded.ok);
  return store.compact(loaded.generation); });
  assert.ok(result.ok);
  return JSON.parse(readFileSync(path.join(root, "board-snapshot.json"), "utf8")) as {
    schemaVersion?: number; generation: number; sequence: number; state: unknown; checksum: string };
}

test("a new method exit cannot be bypassed by a v1 reader after compaction", async () => {
  await fixture(async root => {
    const store = createExperienceStore(root, () => AT);

    await store.append(view => ({ kind: "exit", factId: "archive", versionId: "v", sequence: view.sequence + 1,
      mode: "archive", reason: "superseded" }));
    const raw = await compact(root);

    assert.equal(raw.schemaVersion, 2);
    const v1Checksum = sha256Hex(canonicalJson({ generation: raw.generation, sequence: raw.sequence, state: raw.state }));

    assert.notEqual(v1Checksum, raw.checksum, "an old reader must discard the snapshot instead of ignoring exit facts");
    assert.match(readFileSync(path.join(root, "board-events.ndjson"), "utf8"), /record_method_experience/,
      "its fallback must encounter the explicit unknown-command boundary, not silently restore defaults");
    const restored = await createMethodBoardWriter(root).load();
    assert.ok(restored.ok);
    assert.equal(restored.variants[0]?.ledger.state, "archived");
  });
});

test("a legacy Board without new method facts retains the v1 checksum and loads unchanged", async () => {
  await fixture(async root => {
    const raw = await compact(root);
    assert.equal(raw.schemaVersion, undefined);
    assert.equal(sha256Hex(canonicalJson({ generation: raw.generation, sequence: raw.sequence, state: raw.state })), raw.checksum);
    const restored = await createBoardReader(root).load();
    assert.ok(restored.ok);
    assert.equal(restored.state.assets.length, 1);
    assert.deepEqual(restored.state.methodExperienceFacts, []);
  });
});
