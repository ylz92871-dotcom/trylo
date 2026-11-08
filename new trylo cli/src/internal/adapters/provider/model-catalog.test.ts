import assert from "node:assert/strict";
import test from "node:test";
import {
  demandModel,
  demandStructuredSupport,
  emptyCatalog,
  findModel,
  type ModelCatalog,
} from "./model-catalog.js";

/**
 * WP18.1 (C70) contract: rich per-model demands refuse by name, and an
 * undeclared model is never refused on anyone's behalf.
 */

const CATALOG: ModelCatalog = {
  models: [
    {
      id: "lab-7b",
      displayName: "Lab 7B",
      inputModalities: ["text"],
      contextWindow: 128000,
      reasoningEffort: "none",
      toolKinds: ["function"],
      structuredOutput: false,
    },
    {
      id: "lab-vision",
      inputModalities: ["text", "image"],
      reasoningEffort: "medium",
      structuredOutput: true,
    },
  ],
};

test("an undeclared model passes structured demands; a refusing one does not", () => {
  assert.equal(demandStructuredSupport(emptyCatalog(), "anything").ok, true);
  assert.equal(demandStructuredSupport(CATALOG, "lab-vision").ok, true);
  const refused = demandStructuredSupport(CATALOG, "lab-7b");

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.denial.code, "unsupported_structured_output");
  }
});

test("modalities and tool kinds refuse by name, unknown models list the known", () => {
  assert.equal(demandModel(CATALOG, "lab-vision", { kind: "modality", modality: "image" }).ok, true);
  const noImage = demandModel(CATALOG, "lab-7b", { kind: "modality", modality: "image" });

  assert.equal(noImage.ok, false);

  if (!noImage.ok) {
    assert.equal(noImage.denial.code, "unsupported_modality");
  }

  const noSearch = demandModel(CATALOG, "lab-7b", { kind: "toolKind", toolKind: "web_search" });

  assert.equal(noSearch.ok, false);
  const unknown = demandModel(CATALOG, "ghost", { kind: "structured" });

  assert.equal(unknown.ok, false);

  if (!unknown.ok && unknown.denial.code === "unknown_model") {
    assert.deepEqual(unknown.denial.known, ["lab-7b", "lab-vision"]);
  }

  assert.equal(findModel(CATALOG, "ghost"), undefined);
});

test("a model with effort none is never offered the reasoning channel", () => {
  const denied = demandModel(CATALOG, "lab-7b", { kind: "capability", capability: "reasoning" });
  assert.equal(denied.ok, false);
  assert.equal(
    demandModel(CATALOG, "lab-vision", { kind: "capability", capability: "reasoning" }).ok,
    true,
  );
});
