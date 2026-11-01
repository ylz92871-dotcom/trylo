import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, contentHashOf } from "./hash.js";

test("canonical JSON preserves own prototype-named keys instead of treating them as setters", () => {
  const value: unknown = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}');
  assert.equal(canonicalJson(value), '{"__proto__":1,"constructor":2,"prototype":3}');
  assert.notEqual(contentHashOf(value), contentHashOf({ constructor: 2, prototype: 3 }));
});

test("nested JSON prototype-named values cannot collide with an empty expected result", () => {
  const actual: unknown = JSON.parse('{"kind":"value","value":{"__proto__":{"lost":true}}}');
  assert.notEqual(canonicalJson(actual), canonicalJson({ kind: "value", value: {} }));
});
