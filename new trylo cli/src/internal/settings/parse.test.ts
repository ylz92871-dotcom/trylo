import assert from "node:assert/strict";
import test from "node:test";
import { parseLayerContent, validateCliFlag } from "./parse.js";

/**
 * One layer's bytes -> validated values, keeping the three outcomes distinct:
 * missing (contributes nothing, fine), invalid (fail-closed upstream), present.
 * The crucial separation is missing vs invalid: a broken file must never be
 * reported as "not configured".
 */

const SOURCE = "user";

test("missing layer yields empty values and is not an error", () => {
  const result = parseLayerContent({ status: "missing" }, SOURCE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.values, {});
  }
});

test("malformed JSON is invalid, not missing", () => {
  const result = parseLayerContent({ status: "present", raw: "{not json" }, SOURCE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_json");
  }
});

test("an empty or whitespace-only file is invalid (a started-but-unfinished file)", () => {
  for (const raw of ["", "   ", "\n\t"]) {
    const result = parseLayerContent({ status: "present", raw }, SOURCE);
    assert.equal(result.ok, false, JSON.stringify(raw));
    if (!result.ok) {
      assert.equal(result.code, "invalid_json");
    }
  }
});

test("an empty object is valid and contributes nothing (all falls to packaged)", () => {
  const result = parseLayerContent({ status: "present", raw: "{}" }, SOURCE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.values, {});
  }
});

test("a non-object document is invalid", () => {
  for (const raw of ["[1,2]", '"a string"', "null", "42"]) {
    const result = parseLayerContent({ status: "present", raw }, SOURCE);
    assert.equal(result.ok, false, raw);
    if (!result.ok) {
      assert.equal(result.code, "invalid_json");
    }
  }
});

test("formatVersion 1 is accepted and stripped from the values", () => {
  const result = parseLayerContent(
    { status: "present", raw: '{"formatVersion":1,"model":"m"}' },
    SOURCE,
  );

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.deepEqual(result.values, { model: "m" });
    assert.equal(Object.hasOwn(result.values, "formatVersion"), false);
  }
});

test("a lone formatVersion 1 is a valid empty config", () => {
  const result = parseLayerContent({ status: "present", raw: '{"formatVersion":1}' }, SOURCE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.values, {});
  }
});

test("formatVersion 2 is refused (this build reads only 1)", () => {
  const result = parseLayerContent({ status: "present", raw: '{"formatVersion":2}' }, SOURCE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unknown_format_version");
  }
});

test("a non-integer formatVersion is refused", () => {
  for (const raw of ['{"formatVersion":"1"}', '{"formatVersion":1.5}', '{"formatVersion":true}']) {
    const result = parseLayerContent({ status: "present", raw }, SOURCE);
    assert.equal(result.ok, false, raw);
    if (!result.ok) {
      assert.equal(result.code, "unknown_format_version");
    }
  }
});

test("a secret key in the file is refused before it can resolve", () => {
  const result = parseLayerContent(
    { status: "present", raw: '{"apiKey":"sk-FAKE-not-real"}' },
    SOURCE,
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "secret_key");
  }
});

test("an MCP declaration in the file is refused", () => {
  const result = parseLayerContent(
    { status: "present", raw: '{"mcpServers":{"fs":{}}}' },
    SOURCE,
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "forbidden_key");
  }
});

test("an unknown key is refused", () => {
  const result = parseLayerContent({ status: "present", raw: '{"nope":1}' }, SOURCE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "unknown_key");
  }
});

test("a value failing its rule is refused", () => {
  const result = parseLayerContent({ status: "present", raw: '{"maxTokens":0}' }, SOURCE);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_value");
  }
});

test("validateCliFlag accepts schema keys and refuses secrets/unknown without a formatVersion escape", () => {
  assert.equal(validateCliFlag({ model: "m" }).ok, true);
  const secret = validateCliFlag({ token: "x" });

  assert.equal(secret.ok, false);

  if (!secret.ok) {
    assert.equal(secret.code, "secret_key");
  }

  // formatVersion is document metadata; in a flag object it is just an unknown key.
  const version = validateCliFlag({ formatVersion: 1 });

  assert.equal(version.ok, false);

  if (!version.ok) {
    assert.equal(version.code, "unknown_key");
  }
});
