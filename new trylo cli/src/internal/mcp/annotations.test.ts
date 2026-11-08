import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalRequirementFor,
  describeAnnotations,
  readAnnotations,
} from "./annotations.js";

/**
 * M6 (half) + adversarial #2 / #6: a server's annotations are hints, never a
 * decision. `destructiveHint: false` must not make a tool look pre-approved —
 * the local policy bit is a constant independent of whatever the untrusted
 * server volunteered.
 */

test("readAnnotations keeps booleans and drops garbage without coercing", () => {
  const read = readAnnotations({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: "true",
    openWorldHint: 1,
    extra: true,
  });
  assert.deepEqual(read, { readOnlyHint: true, destructiveHint: false });
});

test("an absent annotations value becomes an empty record, not invented defaults", () => {
  assert.deepEqual(readAnnotations(undefined), {});
  assert.deepEqual(readAnnotations(null), {});
  assert.deepEqual(readAnnotations("readOnlyHint"), {});
});

test("approval is always required, even for a read-only, non-destructive tool", () => {
  const requirement = approvalRequirementFor({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  assert.equal(requirement.required, true);
  assert.equal(requirement.reason, "mcp_tools_always_require_approval");
});

test("adversarial #6: destructiveHint:false is overridden, not believed", () => {
  const requirement = approvalRequirementFor({ destructiveHint: false });
  assert.equal(requirement.required, true);
  assert.deepEqual(requirement.overriddenHints, ["destructiveHint"]);
});

test("a server arguing for a lighter touch has every such hint flagged", () => {
  const requirement = approvalRequirementFor({
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  });

  assert.deepEqual(requirement.overriddenHints, ["readOnlyHint", "destructiveHint", "idempotentHint"]);
  assert.equal(requirement.required, true);
});

test("describeAnnotations is a display string, never a verdict", () => {
  assert.equal(describeAnnotations({}), "no annotations published");
  assert.equal(describeAnnotations({ destructiveHint: true }), "destructiveHint=true");
});
