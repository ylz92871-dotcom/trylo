import assert from "node:assert/strict";
import test from "node:test";
import { parsePromptOps, parseTaskFamily, parseVersionPins } from "./parse.js";

test("malformed task family fail-closes", () => {
  const missing = parseTaskFamily({ id: "x" });

  assert.equal(missing.ok, false);
  const badKind = parseTaskFamily({
    id: "x",
    intentClass: "fix",
    checkKind: "not-a-kind",
  });

  assert.equal(badKind.ok, false);
});

test("malformed versions and ops fail-close", () => {
  assert.equal(parseVersionPins({ model: "m" }).ok, false);
  assert.equal(parsePromptOps("not-array").ok, false);
  assert.equal(parsePromptOps([{ op: "explode" }]).ok, false);
});

test("valid task family with checkSchema parses", () => {
  const parsed = parseTaskFamily({
    id: "ts-unit-fix",
    intentClass: "fix_failing_unit_test",
    checkKind: "unit_test",
    checkSchema: "npm test -- test/foo.test.ts",
  });

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.value.checkSchema, "npm test -- test/foo.test.ts");
  }
});
