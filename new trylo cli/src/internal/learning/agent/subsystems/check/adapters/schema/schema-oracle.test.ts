import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject, JsonValue } from "../../../../../../protocol/envelope.js";
import { prepareSupportedSchema } from "./schema-support.js";
import { evaluateSchemaOutput } from "./schema-oracle.js";

const invoice: JsonObject = { type: "object", additionalProperties: false, required: ["items", "total"], properties: {
  items: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
    required: ["qty", "unitPrice"], properties: { qty: { type: "integer", minimum: 0 }, unitPrice: { type: "number", minimum: 0 } } } },
  total: { type: "number", minimum: 0 }, discount: { type: "number", minimum: 0 },
} };

test("structural oracle executes the schema but makes no independent arithmetic claim", () => {
  const valid = evaluateSchemaOutput(invoice, { items: [{ qty: 0, unitPrice: 12 }], total: 0 });

  assert.equal(valid.status, "pass");
  assert.equal(valid.code, "schema_match");
  assert.equal(evaluateSchemaOutput(invoice, { items: [{ qty: 2, unitPrice: 12 }], total: 999 }).status, "pass",
    "the learned semantic checker must detect this gap, not a fabricated structural verdict");

  for (const output of [{ items: [], total: 0 }, { items: [{ qty: "2", unitPrice: 12 }], total: 24 },
    { items: [{ qty: 2, unitPrice: 12 }], total: 24, unexpected: true }, { items: [{ qty: 1 }] }]) {
    const result = evaluateSchemaOutput(invoice, output);
    assert.equal(result.status, "fail", JSON.stringify(output));
    assert.ok(result.findings.length > 0);
  }
});

test("required fields and additional property schemas are actually enforced", () => {
  const schema: JsonObject = { type: "object", required: ["label"], properties: { label: { type: "string" } }, additionalProperties: { type: "boolean" } };

  assert.equal(evaluateSchemaOutput(schema, { label: "one", visible: true }).status, "pass");
  assert.equal(evaluateSchemaOutput(schema, { visible: true }).status, "fail");
  assert.equal(evaluateSchemaOutput(schema, { label: "one", visible: 1 }).status, "fail");
  const ownProto = JSON.parse('{"__proto__":1}') as JsonValue;

  assert.equal(evaluateSchemaOutput({ type: "object", additionalProperties: false }, ownProto).status, "unavailable",
    "the installed converter ignores this extra key, so it cannot be used as a structural pass");
});

test("array item types and length bounds execute even when items was omitted", () => {
  const typed: JsonObject = { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 2 };

  for (const output of [[0], [1, 2]]) assert.equal(evaluateSchemaOutput(typed, output).status, "pass");

  for (const output of [[], [1, 2, 3], ["1"]]) assert.equal(evaluateSchemaOutput(typed, output).status, "fail");

  const untyped: JsonObject = { type: "array", minItems: 2, maxItems: 3 };

  assert.equal(evaluateSchemaOutput(untyped, [1]).status, "fail", "the converter normally ignores these bounds without items");
  assert.equal(evaluateSchemaOutput(untyped, [1, "x"]).status, "pass");
  assert.equal(evaluateSchemaOutput({ type: "array", items: false }, [1]).status, "fail");
  assert.equal(evaluateSchemaOutput({ type: "array", items: false }, []).status, "pass");
});

test("numeric limits, zero values, integer type and nullable unions remain distinct", () => {
  const schema: JsonObject = { type: ["integer", "null"], minimum: 0, exclusiveMaximum: 4 };
  for (const output of [0, 3, null]) assert.equal(evaluateSchemaOutput(schema, output).status, "pass");
  for (const output of [-1, 4, 1.5, "0"]) assert.equal(evaluateSchemaOutput(schema, output).status, "fail");
  assert.equal(evaluateSchemaOutput({ type: "number", exclusiveMinimum: 0, maximum: 1 }, 0).status, "fail");
  assert.equal(evaluateSchemaOutput({ type: "number", exclusiveMinimum: 0, maximum: 1 }, 0.5).status, "pass");
});

test("composition preserves conjunction and exclusive versus ordinary alternatives", () => {
  const any: JsonObject = { anyOf: [{ type: "string" }, { type: "number" }] };

  assert.equal(evaluateSchemaOutput(any, "x").status, "pass");
  assert.equal(evaluateSchemaOutput(any, false).status, "fail");
  const exclusive: JsonObject = { oneOf: [{ type: "number" }, { type: "integer" }] };

  assert.equal(evaluateSchemaOutput(exclusive, 1).status, "fail");
  assert.equal(evaluateSchemaOutput(exclusive, 1.5).status, "pass");
  const both: JsonObject = { allOf: [{ type: "number", minimum: 2 }, { type: "number", maximum: 4 }] };

  assert.equal(evaluateSchemaOutput(both, 3).status, "pass");
  assert.equal(evaluateSchemaOutput(both, 1).status, "fail");
  assert.equal(evaluateSchemaOutput({ not: {} }, null).status, "fail");
});

test("primitive enums and const are supported without ignoring contradictory siblings", () => {
  assert.equal(evaluateSchemaOutput({ type: "string", enum: ["one", "two"] }, "one").status, "pass");
  assert.equal(evaluateSchemaOutput({ type: "string", enum: ["one", "two"] }, "three").status, "fail");
  assert.equal(evaluateSchemaOutput({ const: null }, null).status, "pass");

  for (const schema of [{ type: "number", enum: ["one"] }, { type: "number", const: 1, minimum: 2 },
    { enum: [{ id: 1 }] }, { const: [1] }, { enum: [] }, { enum: [1, 1] }, { type: "object", const: null }, { enum: [1], const: 1 }]) {
    assert.equal(evaluateSchemaOutput(schema, 1).status, "unavailable", JSON.stringify(schema));
  }
});

test("direct local references execute for the two supported dialects", () => {
  for (const [dialect, defsKey] of [["https://json-schema.org/draft/2020-12/schema", "$defs"], ["http://json-schema.org/draft-07/schema#", "definitions"]]) {
    const schema: JsonObject = { $schema: dialect!, [defsKey!]: { amount: { type: "number", minimum: 0 } }, type: "object",
      required: ["total"], properties: { total: { $ref: `#/${defsKey}/amount` } }, additionalProperties: false };
    assert.equal(evaluateSchemaOutput(schema, { total: 0 }).status, "pass");
    assert.equal(evaluateSchemaOutput(schema, { total: -1 }).status, "fail");
    assert.equal(evaluateSchemaOutput(schema, {}).status, "fail");
  }
});

test("unresolved, recursive, external and assertion-bearing references are unavailable", () => {
  const schemas: JsonObject[] = [
    { $ref: "https://example.invalid/schema" }, { $ref: "#/$defs/missing" },
    { $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" },
    { $defs: { text: { type: "string" } }, $ref: "#/$defs/text", type: "number" },
    { $defs: { text: { type: "string" } }, $ref: "#/$defs/text/ignored" },
    { $defs: { text: { type: "string" }, unused: { type: "array", uniqueItems: true } }, $ref: "#/$defs/text" },
    { type: "object", $defs: { any: {} }, properties: { requiredAny: { $ref: "#/$defs/any" } }, required: ["requiredAny"] },
    { type: "object", properties: { child: { $defs: { text: { type: "string" } }, type: "string" } } },
  ];
  for (const schema of schemas) assert.equal(evaluateSchemaOutput(schema, {}).status, "unavailable", JSON.stringify(schema));
});

test("ignored or unsupported validation keywords never silently produce schema pass", () => {
  const schemas: JsonObject[] = [{ type: "array", items: { type: "integer" }, uniqueItems: true },
    { type: "array", contains: { const: 1 } }, { type: "object", minProperties: 1 }, { type: "string", format: "invented-format" },
    { type: "string", pattern: "(a+)+$" }, { type: "number", multipleOf: 0.1 }, { type: "object", dependentRequired: { x: ["y"] } },
    { type: "object", unevaluatedProperties: false }, { if: { type: "number" }, then: { minimum: 2 } },
    { anyOf: [{ type: "number" }], allOf: [{ type: "string" }] },
    { type: "string", customQualityGate: true }, { $dynamicRef: "#node" }, { $schema: "http://json-schema.org/draft-04/schema#", type: "string" }];
  for (const schema of schemas) assert.equal(evaluateSchemaOutput(schema, [1, 1]).status, "unavailable", JSON.stringify(schema));
});

test("annotation defaults do not repair missing required data or mutate the checked output", () => {
  const schema: JsonObject = { type: "object", required: ["qty"], properties: { qty: { type: "integer", default: 1 } },
    title: "invoice", examples: [{ qty: 1 }], readOnly: true, additionalProperties: false };
  const output: JsonObject = {};
  assert.equal(evaluateSchemaOutput(schema, output).status, "fail");
  assert.deepEqual(output, {});
  assert.equal(Object.isFrozen(output), false);
  const valid = { qty: 0 };
  assert.equal(evaluateSchemaOutput(schema, valid).status, "pass");
  assert.equal(Object.isFrozen(valid), false);
});

test("untyped assertions and required-any cases are unsupported instead of being ignored", () => {
  for (const schema of [{ minimum: 2 }, { properties: { x: { type: "string" } } }, { minLength: 3 },
    { type: "object", required: ["x"] }, { type: "object", properties: { x: {} }, required: ["x"] },
    { type: "object", properties: { x: true }, required: ["x"] }]) {
    assert.equal(evaluateSchemaOutput(schema, {}).status, "unavailable", JSON.stringify(schema));
  }
});

test("string bounds use BMP-safe input and report unsupported Unicode instead of misjudging astral length", () => {
  assert.equal(evaluateSchemaOutput({ type: "string", minLength: 2, maxLength: 3 }, "你好").status, "pass");
  assert.equal(evaluateSchemaOutput({ type: "string", minLength: 2, maxLength: 3 }, "你").status, "fail");
  assert.equal(evaluateSchemaOutput({ type: "string", minLength: 2 }, "😀").status, "unavailable");
  assert.equal(evaluateSchemaOutput({ type: "string" }, "😀").status, "pass");
});

test("invalid schema shapes, tuples and unsupported property names fail as oracle unavailability", () => {
  const prototypeProperty: JsonObject = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as JsonObject;
  for (const schema of [{ type: [] }, { type: ["integer", "integer"] }, { type: "unknown" }, { type: "array", items: [{ type: "integer" }] },
    { type: "array", minItems: 0.5 }, { type: "number", exclusiveMinimum: true }, { anyOf: [] }, { type: "object", required: [1] }, prototypeProperty]) {
    assert.equal(evaluateSchemaOutput(schema, {}).status, "unavailable", JSON.stringify(schema));
  }
});

test("unsafe numeric, cyclic, sparse, oversized and non-JSON inputs are not object violations", () => {
  for (const output of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, new Array<JsonValue>(2), "x".repeat(262_145)]) {
    assert.equal(evaluateSchemaOutput({ type: "number" }, output).status, "unavailable");
  }
  const cyclic: Record<string, JsonValue> = {};
  cyclic.loop = cyclic;
  assert.equal(evaluateSchemaOutput(cyclic, 1).status, "unavailable");
  assert.equal(evaluateSchemaOutput({ type: "object" }, cyclic).status, "unavailable");
});

test("findings are bounded and do not echo sensitive output values", () => {
  const schema: JsonObject = { type: "array", items: { type: "integer" } };
  const result = evaluateSchemaOutput(schema, Array.from({ length: 50 }, () => "private-payload-value"));
  assert.equal(result.status, "fail");
  assert.equal(result.findings.length, 32);
  assert.equal(JSON.stringify(result).includes("private-payload-value"), false);
});

test("root schema identifiers are metadata and preserve invoice structural verdicts", () => {
  for (const id of ["urn:trylo:acceptance:invoice:v2", "https://example.invalid/schemas/invoice.json", "trylo:invoice-v2"]) {
    const schema: JsonObject = { $id: id, ...invoice };
    const prepared = prepareSupportedSchema(schema);

    assert.ok(prepared.ok, JSON.stringify(prepared));
    assert.equal(Object.hasOwn(prepared.schema, "$id"), false);
    assert.equal(schema.$id, id, "the frozen caller schema retains its identity");
    assert.equal(evaluateSchemaOutput(schema, { items: [{ qty: 0, unitPrice: 12 }], total: 0 }).status, "pass");
    assert.equal(evaluateSchemaOutput(schema, { items: [{ qty: 2, unitPrice: 12 }], total: 999 }).status, "pass",
      "root identity metadata makes no arithmetic quality claim");
    assert.equal(evaluateSchemaOutput(schema, { items: [{ qty: "2", unitPrice: 12 }], total: 24 }).status, "fail");
  }
  assert.equal(evaluateSchemaOutput({ $id: "urn:trylo:literal:v1", type: "string", enum: ["one", "two"] }, "one").status, "pass");
});

test("root identifier beside a local reference cannot change reference resolution", () => {
  for (const [dialect, defsKey] of [["https://json-schema.org/draft/2020-12/schema", "$defs"],
    ["http://json-schema.org/draft-07/schema#", "definitions"]]) {
    const schema: JsonObject = { $id: "https://example.invalid/schemas/invoice.json", $schema: dialect!,
      [defsKey!]: { amount: { type: "number", minimum: 0 } }, $ref: "#/" + defsKey + "/amount" };

    assert.equal(evaluateSchemaOutput(schema, 0).status, "pass");
    assert.equal(evaluateSchemaOutput(schema, -1).status, "fail");
    assert.equal(evaluateSchemaOutput({ ...schema, type: "string" }, 0).status, "unavailable", "identity does not permit assertion siblings");

    for (const reference of ["https://example.invalid/amount.json", "./amount.json", "amount.json", "urn:trylo:amount", "#missing"]) {
      assert.equal(evaluateSchemaOutput({ ...schema, $ref: reference }, 0).status, "unavailable", reference);
    }
  }
});

test("invalid root identifiers and all nested identity scopes remain unavailable", () => {
  for (const id of [null, 1, false, "", " ", "invoice-v2", "./invoice.json", "/invoice.json",
    "urn:trylo:invoice#fragment", "urn:trylo:invoice#", "https://user:password@example.invalid/schema",
    "urn:trylo:bad%zz", "urn:trylo:line\nbreak", "urn:trylo:" + "a".repeat(513)]) {
    const result = evaluateSchemaOutput({ $id: id, type: "number" }, 1);
    assert.equal(result.status, "unavailable", JSON.stringify(id));
    assert.equal(result.code, "schema_identifier_invalid");
  }

  const nested: JsonObject[] = [
    { type: "object", properties: { total: { $id: "urn:trylo:nested", type: "number" } } },
    { $defs: { amount: { $id: "urn:trylo:nested", type: "number" } }, $ref: "#/$defs/amount" },
    { anyOf: [{ $id: "urn:trylo:nested", type: "number" }] },
    { type: "array", items: { $id: "urn:trylo:nested", type: "number" } },
  ];

  for (const schema of nested) assert.equal(evaluateSchemaOutput({ $id: "urn:trylo:root", ...schema }, {}).status, "unavailable");
});
