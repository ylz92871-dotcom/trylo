import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../../control/hash.js";
import { applyToolSourcePatch, decodeToolSourcePatch } from "./source-edits.js";
import { parseToolEvolutionCandidate } from "./parse.js";

test("exact source edits preserve unchanged bytes and apply replacement text literally in order", () => {
  const source = "const n = 1;\r\nmodule.exports = () => n;\r\n";
  const patch = { baseContentHash: contentHashOf(source), edits: [
    { search: "const n = 1;", replace: "const n = 2;" },
    { search: "module.exports = () => n;", replace: "module.exports = () => '$& $1';" },
  ] };
  const result = applyToolSourcePatch(source, patch);
  assert.ok(result.ok);
  assert.equal(result.source, "const n = 2;\r\nmodule.exports = () => '$& $1';\r\n");
  assert.equal(result.baseContentHash, patch.baseContentHash);
  assert.equal(result.resultContentHash, contentHashOf(result.source));
  assert.equal(source, "const n = 1;\r\nmodule.exports = () => n;\r\n");
});

test("a stale base, missing anchor or any ambiguous exact match rejects the whole edit sequence", () => {
  const apply = (source: string, search: string, baseContentHash = contentHashOf(source)) => applyToolSourcePatch(source, { baseContentHash, edits: [{ search, replace: "x" }] });

  for (const [source, search, code] of [["abcd", "abc\n", "source_patch_search_missing"], ["aaaa", "aa", "source_patch_search_ambiguous"]] as const) {
    const result = apply(source, search);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
  }

  const stale = apply("abc", "abc", contentHashOf("old"));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "source_patch_base_mismatch");

  const partial = applyToolSourcePatch("abc", { baseContentHash: contentHashOf("abc"), edits: [{ search: "ab", replace: "x" }, { search: "not-found", replace: "" }] });

  assert.equal(partial.ok, false);
  assert.equal(Object.hasOwn(partial, "source"), false, "failed edits never expose a partially applied source");
});

test("patch limits count UTF-8 input and every intermediate output, while the decoder rejects executable or hidden fields", () => {
  const source = "汉字", patch = { baseContentHash: contentHashOf(source), edits: [{ search: source, replace: "" }] };
  const input = applyToolSourcePatch(source, patch, { maxInputBytes: 8, maxOutputBytes: 16 });
  assert.equal(input.ok, false);

  if (!input.ok) assert.equal(input.code, "source_patch_input_too_large");

  const output = applyToolSourcePatch("abc", { baseContentHash: contentHashOf("abc"), edits: [
    { search: "abc", replace: "12345678901" }, { search: "12345678901", replace: "x" },
  ] }, { maxInputBytes: 1000, maxOutputBytes: 10 });
  assert.equal(output.ok, false);

  if (!output.ok) {
    assert.equal(output.code, "source_patch_output_too_large");
    assert.equal(output.editIndex, 0);
  }

  const surrogate = applyToolSourcePatch("😀", { baseContentHash: contentHashOf("😀"), edits: [
    { search: "\ud83d", replace: "" }, { search: "\ude00", replace: "" },
  ] }, { maxInputBytes: 1000, maxOutputBytes: 2 });

  assert.equal(surrogate.ok, false, "a split surrogate's intermediate UTF-8 bytes count before the next edit");

  if (!surrogate.ok) assert.equal(surrogate.editIndex, 0);

  for (const raw of [{ ...patch, edits: [] }, { ...patch, edits: Array.from({ length: 9 }, () => patch.edits[0]) },
    { ...patch, edits: [{ search: "", replace: "x" }] }, { ...patch, permissions: [] }]) assert.equal(decodeToolSourcePatch(raw), undefined);

  let accessed = false;

  assert.equal(decodeToolSourcePatch({ get baseContentHash() {
    accessed = true;
    return patch.baseContentHash;
  }, edits: patch.edits }), undefined);
  assert.equal(accessed, false);
});

test("the generated response parser expands a patch only against host-supplied prior source and keeps the canonical artifact complete", () => {
  const source = "module.exports = input => Math.round(input * 2);";
  const descriptor = { identity: "double", description: "Double decimals", inputSchema: { type: "number" }, mastery: { whenToUse: ["Double a finite number"], preconditions: [], pitfalls: [] } };
  const response = { ...descriptor, sourcePatch: { baseContentHash: contentHashOf(source), edits: [{ search: "Math.round(input * 2)", replace: "input * 2" }] } };
  const parsed = parseToolEvolutionCandidate(JSON.stringify(response), source);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.source, "module.exports = input => input * 2;");
  assert.equal(Object.hasOwn(parsed.value, "sourcePatch"), false);
  assert.equal(parseToolEvolutionCandidate(JSON.stringify(response)).ok, false);
  assert.equal(parseToolEvolutionCandidate(JSON.stringify(response), "different source").ok, false);
  assert.equal(parseToolEvolutionCandidate(JSON.stringify({ ...response, source })).ok, false);
  assert.equal(parseToolEvolutionCandidate(JSON.stringify({ ...response, permissions: ["shell"] }), source).ok, false);
  assert.ok(parseToolEvolutionCandidate(JSON.stringify({ ...descriptor, source })).ok, "existing full-module responses remain compatible");
});
