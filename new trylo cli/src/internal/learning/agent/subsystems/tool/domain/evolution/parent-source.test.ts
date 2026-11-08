import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../../control/hash.js";
import { decodeToolParentSourceRead, readToolParentSourcePage } from "./parent-source.js";

test("parent paging binds exact frozen source, reports reproducible character offsets and cannot read a host path", () => {
  const prior = { versionId: "parent", source: "before\r\n目标🙂after" }, hash = contentHashOf(prior.source);
  const page = readToolParentSourcePage(prior, { action: "read_parent", baseContentHash: hash, offset: 8, limit: 2 });
  assert.ok(page.ok);
  assert.equal(page.page.text, "目标");
  assert.equal(page.page.nextOffset, 10);
  assert.equal(page.page.sourceChars, prior.source.length);
  assert.equal(readToolParentSourcePage(prior, { action: "read_parent", baseContentHash: "a".repeat(64), offset: 0 }).ok, false);
  assert.equal(readToolParentSourcePage(prior, { action: "read_parent", baseContentHash: hash, offset: 500 }).ok, false);
  assert.equal(readToolParentSourcePage(undefined, { action: "read_parent", baseContentHash: hash, offset: 0 }).ok, false);
  assert.equal(decodeToolParentSourceRead({ action: "read_parent", baseContentHash: hash, offset: 0, path: "C:/secret" }), undefined);
  assert.equal(decodeToolParentSourceRead({ action: "read_parent", baseContentHash: hash, offset: 0, limit: 4001 }), undefined);
});
