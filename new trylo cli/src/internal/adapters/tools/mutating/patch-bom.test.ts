import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch, parseUnifiedPatch, prepareSource } from "./patch-engine.js";

test("a first-line edit matches UTF-8 BOM text and preserves the BOM and line endings", () => {
  const patch = parseUnifiedPatch("@@\n-export function total() {\n+export function total(items) {\n   return 0;\n }\n");
  assert.equal(patch.ok, true);
  if (!patch.ok) return;
  const result = applyPatch(prepareSource("\uFEFFexport function total() {\r\n  return 0;\r\n}\r\n"), patch.hunks);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, "\uFEFFexport function total(items) {\r\n  return 0;\r\n}\r\n");
});

test("encoding tolerance does not relax mismatched source or remove an untouched BOM", () => {
  const patch = parseUnifiedPatch("@@\n-two\n+changed\n");

  assert.equal(patch.ok, true);

  if (!patch.ok) return;

  const source = prepareSource("\uFEFFone\ntwo\n");
  const changed = applyPatch(source, patch.hunks);

  assert.equal(changed.ok, true);

  if (changed.ok) assert.equal(changed.content, "\uFEFFone\nchanged\n");

  assert.equal(applyPatch(prepareSource("\uFEFFone\nother\n"), patch.hunks).ok, false);
});
