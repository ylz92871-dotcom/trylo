import assert from "node:assert/strict";
import test from "node:test";
import { isActionableCentralChangeStructureRejection } from "./change-structure-rejection.js";

test("correction eligibility uses concrete shape diagnostics without repairing values or inventing erased keys", () => {
  const type = { schemaVersion: 1, stage: "shape", field: "/changes", expected: "array", actual: "string", cause: "type" };

  assert.equal(isActionableCentralChangeStructureRejection(type), true);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "", expected: "object", actual: "array" }), true);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "/changes/0/why", expected: "meaning", actual: "missing", cause: "missing" }), true);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "/action", expected: "enum", cause: "value" }), true);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "", expected: "enum", cause: "value" }), true,
    "old root enum diagnostics stay unchanged but can be reconsidered against the exact current contract");

  for (const field of ["", "/changes/0"]) assert.equal(isActionableCentralChangeStructureRejection({ ...type,
    field, expected: "known_fields", actual: "object", cause: "unexpected" }), true, "the current public field table supports autonomous re-expression");

  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "/inspect/maximumChars", expected: "integer", actual: "number" }), true);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, stage: "generation", expected: "generation_limit", cause: "unavailable" }), false);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, expected: "integer", actual: "number", cause: "range" }), true);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "/changes/0/next/offset", expected: "query_offset", actual: "number", cause: "relation" }), false);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, field: "/private-caller-key" }), false);
  assert.equal(isActionableCentralChangeStructureRejection({ ...type, rejectedValue: "not permitted in diagnostics" }), false);
});
