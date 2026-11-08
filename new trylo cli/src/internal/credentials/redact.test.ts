import assert from "node:assert/strict";
import test from "node:test";
import { REDACTED, containsNoSecret, redactText, redactValue } from "./redact.js";

/**
 * The redaction module is the second layer of defence (the first being the
 * public view's shape, which has no `secret` field). These tests use deliberately
 * awkward secrets — an `sk-` token, a JSON fragment, an accountId-shaped string —
 * because a scrubber that only handles "one contiguous token" would pass a
 * naive test and still leak a value that happens to contain punctuation.
 */

const SECRETS = [
  "sk-live-abcdef1234567890",
  '{"apiKey":"embedded-json-secret"}',
  "account-shaped-A1B2C3",
];

test("every known secret is replaced in free text", () => {
  for (const secret of SECRETS) {
    const text = `before ${secret} after`;
    const out = redactText(text, SECRETS);
    assert.equal(out.includes(secret), false);
    assert.equal(containsNoSecret(out, SECRETS), true);
    assert.equal(out.includes(REDACTED), true);
  }
});

test("redaction is idempotent and leaves unrelated text intact", () => {
  const out = redactText("keep this sk-live-abcdef1234567890 and this", SECRETS);
  assert.equal(redactText(out, SECRETS), out);
  assert.equal(out.startsWith("keep this "), true);
  assert.equal(out.endsWith(" and this"), true);
});

test("short and empty secrets are ignored so unrelated text is not corrupted", () => {
  assert.equal(redactText("abc", [""]), "abc");
  assert.equal(redactText("abc", ["a"]), "abc");
});

test("redactValue scrubs string leaves and keys without mutating the input", () => {
  const input = {
    detail: "failed with sk-live-abcdef1234567890",
    nested: ["account-shaped-A1B2C3", 42, true],
    "sk-live-abcdef1234567890": "key-is-a-secret-too",
  };
  const out = redactValue(input, SECRETS) as typeof input;
  const serialized = JSON.stringify(out);

  assert.equal(containsNoSecret(serialized, SECRETS), true);
  // Input untouched.
  assert.equal(input.detail.includes("sk-live-abcdef1234567890"), true);
});

test("no secrets means the value passes through unchanged", () => {
  const input = { a: "b" };
  assert.equal(redactValue(input, []), input);
});
