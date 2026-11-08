import assert from "node:assert/strict";
import test from "node:test";
import {
  decideFallback,
  isFallbackRescuable,
  validateFallback,
} from "./fallback-resolver.js";

/**
 * WP18.2 (L05) contract: same-model fallback is a usage error, only transient
 * classes move, and the move happens at most once per turn.
 */

test("a fallback equal to the primary is refused", () => {
  const refused = validateFallback("lab-7b", "lab-7b");

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "same_model");
  }

  assert.deepEqual(validateFallback("lab-7b", undefined), {
    ok: true,
    declaration: { primary: "lab-7b" },
  });
  assert.deepEqual(validateFallback("lab-7b", "  "), {
    ok: true,
    declaration: { primary: "lab-7b" },
  });
});

test("only transient classes move, and only once", () => {
  const declaration = { primary: "lab-7b", fallback: "lab-70b" };

  assert.equal(isFallbackRescuable("rate_limit"), true);
  assert.equal(isFallbackRescuable("server"), true);
  assert.equal(isFallbackRescuable("network"), true);
  assert.equal(isFallbackRescuable("timeout"), true);
  assert.equal(isFallbackRescuable("auth"), false);
  assert.equal(isFallbackRescuable("invalid_request"), false);
  assert.equal(isFallbackRescuable("cancelled"), false);
  assert.deepEqual(decideFallback(declaration, "server", false), {
    action: "switch",
    model: "lab-70b",
  });
  assert.deepEqual(decideFallback(declaration, "server", true), { action: "stay" });
  assert.deepEqual(decideFallback(declaration, "auth", false), { action: "stay" });
  assert.deepEqual(decideFallback({ primary: "lab-7b" }, "server", false), { action: "stay" });
});
