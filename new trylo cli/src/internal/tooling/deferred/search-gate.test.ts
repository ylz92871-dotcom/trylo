import assert from "node:assert/strict";
import test from "node:test";
import {
  applySchemaLoad,
  applySearch,
  evaluateToolCall,
  searchThresholdMet,
  INITIAL_SEARCH_GATE,
} from "./search-gate.js";

const PDF = { name: "pdf_lint", shouldDefer: true, alwaysLoad: false, schemaVersion: "v3", packageVersionId: "pkg:pdf:3" };
const CORE = { name: "read", shouldDefer: false, alwaysLoad: true, schemaVersion: "v1", packageVersionId: "pkg:core:1" };

test("direct tools run without search; deferred tools need search then schema", () => {
  assert.equal(evaluateToolCall({ state: INITIAL_SEARCH_GATE, toolName: "read", entry: CORE, expectedGeneration: 0 }).ok, true);
  const unsearched = evaluateToolCall({ state: INITIAL_SEARCH_GATE, toolName: "pdf_lint", entry: PDF, expectedGeneration: 0 });

  assert.equal(unsearched.ok, false);

  const searched = applySearch(INITIAL_SEARCH_GATE, "pdf", ["pdf_lint"]);
  const noschema = evaluateToolCall({ state: searched, toolName: "pdf_lint", entry: PDF, expectedGeneration: 0 });

  assert.equal(noschema.ok, false);

  const loaded = applySchemaLoad(searched, "pdf_lint", "v3");

  assert.equal(loaded.ok, true);

  if (!loaded.ok) {
    return;
  }

  assert.equal(evaluateToolCall({ state: loaded.value, toolName: "pdf_lint", entry: PDF, expectedGeneration: 0 }).ok, true);
});

test("schema load without search is refused; conflicts need a re-select", () => {
  assert.equal(applySchemaLoad(INITIAL_SEARCH_GATE, "pdf_lint", "v3").ok, false);
  const searched = applySearch(INITIAL_SEARCH_GATE, "pdf", ["pdf_lint"]);
  const loaded = applySchemaLoad(searched, "pdf_lint", "v2");

  assert.equal(loaded.ok, true);

  if (!loaded.ok) {
    return;
  }

  const conflict = evaluateToolCall({ state: loaded.value, toolName: "pdf_lint", entry: PDF, expectedGeneration: 0 });

  assert.equal(conflict.ok, false);

  if (!conflict.ok) {
    assert.equal(conflict.code, "schema_conflict");
  }
});

test("uninstalled tools cannot execute; stale generations never run", () => {
  const searched = applySearch(INITIAL_SEARCH_GATE, "pdf", ["pdf_lint"]);
  const loaded = applySchemaLoad(searched, "pdf_lint", "v3");

  assert.equal(loaded.ok, true);

  if (!loaded.ok) {
    return;
  }

  assert.equal(
    evaluateToolCall({ state: loaded.value, toolName: "pdf_lint", entry: undefined, expectedGeneration: 0 }).ok,
    false,
  );
  const moved = { ...loaded.value, generation: 2 };

  assert.equal(evaluateToolCall({ state: moved, toolName: "pdf_lint", entry: PDF, expectedGeneration: 1 }).ok, false);
});

test("search threshold defaults to 10% of context", () => {
  assert.equal(searchThresholdMet({ deferredChars: 2_500, contextChars: 20_000 }), true);
  assert.equal(searchThresholdMet({ deferredChars: 500, contextChars: 20_000 }), false);
  assert.equal(searchThresholdMet({ deferredChars: 500, contextChars: 0 }), false);
});
