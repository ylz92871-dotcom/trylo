import test from "node:test";
import assert from "node:assert/strict";
import { buildContentPacket, mergeContentBatches, readContentPacket } from "./material.js";
import { createSnapshotContentSource, retrieveContentPacket } from "./material-source.js";
import type { ContentPacketInput } from "./material-contract.js";

function legacy(): ContentPacketInput {
  return { scope: "project:aliases", domain: "prompt", boardSequence: 4, records: [{ ref: "journal:event:one", runId: "run:one", sequence: 1,
    scope: "project:aliases", origin: "execution_result", text: "Required original content." }], requirements: [], answers: [], materials: [],
    requestedRefs: ["raw:event:one"] };
}

test("old packets retain their exact identity while declared source aliases resolve all transported chunks", async () => {
  const input = legacy(), old = buildContentPacket(input);
  if (!old.ok) assert.fail(old.reason);

  assert.equal(old.value.packetId, "content:a21dbff8e669dd3e2da38a42d8ba0d7b3c68de6859926672c26014c8e12932ef");
  assert.equal(Object.hasOwn(old.value, "aliases"), false);
  assert.deepEqual(readContentPacket(JSON.parse(JSON.stringify(old.value))), old);
  const second = { ...input.records[0]!, ref: "journal:event:two", sequence: 2, text: "Remaining source content." };
  const aliases = [{ ref: "raw:event:one", recordRefs: ["journal:event:one", "journal:event:two"] }];
  const batch = { records: [...input.records, second], requirements: [], answers: [], materials: [], aliases };
  const resolved = buildContentPacket({ ...input, ...batch });
  if (!resolved.ok) assert.fail(resolved.reason);

  assert.deepEqual(resolved.value.retrieval.missingRefs, []);
  assert.deepEqual(readContentPacket(JSON.parse(JSON.stringify(resolved.value))), resolved);
  const partial = { ...input, aliases }, incomplete = buildContentPacket(partial);
  if (!incomplete.ok) assert.fail(incomplete.reason);

  assert.deepEqual(incomplete.value.retrieval.missingRefs, ["raw:event:one", "journal:event:two"]);
  const retrieved = await retrieveContentPacket({ ...input, records: [] },
    createSnapshotContentSource({ ...batch, scope: input.scope, boardSequence: input.boardSequence }), new AbortController().signal);
  if (!retrieved.ok) assert.fail(retrieved.reason);

  assert.deepEqual(retrieved.value.records.map(record => record.ref), ["journal:event:one", "journal:event:two"]);
  assert.deepEqual(retrieved.value.retrieval.missingRefs, []);
  assert.deepEqual(JSON.parse(JSON.stringify(retrieved.value)).aliases, aliases);
});

test("alias mappings are exact source addresses and cannot be silently unioned or forged from context", () => {
  const input = legacy(), empty = { records: input.records, requirements: [], answers: [], materials: [] };
  const alias = { ref: "raw:event:one", recordRefs: ["journal:event:one"] };
  const original = { ...empty, aliases: [alias] }, conflicting = { ...empty, aliases: [{ ...alias, recordRefs: ["journal:other"] }] };
  const repeated = mergeContentBatches([original, original]);

  assert.equal(repeated.ok, true);
  assert.deepEqual(mergeContentBatches([original, conflicting]), { ok: false, reason: "content_material_conflict" });
  const emptyAlias = { ...input, aliases: [{ ref: "raw:event:one", recordRefs: [] }] };

  assert.deepEqual(buildContentPacket(emptyAlias),
    { ok: false, reason: "content_material_invalid" });
  const plainContext = buildContentPacket({ ...input, records: [{ ...input.records[0]!, text: JSON.stringify({ aliases: [alias] }) }] });
  if (!plainContext.ok) assert.fail(plainContext.reason);

  assert.deepEqual(plainContext.value.retrieval.missingRefs, ["raw:event:one"]);
});
