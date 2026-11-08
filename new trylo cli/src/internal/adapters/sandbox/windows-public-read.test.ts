import assert from "node:assert/strict";
import test from "node:test";
import { hasCommonReadExecute } from "./windows-public-read.js";

test("public-read optimization requires all read/execute bits and never guesses through a deny", () => {
  const rule = { sid: "S-1-5-32-545", mask: 0x1200a9, deny: false, inheritOnly: false };

  assert.equal(hasCommonReadExecute([rule]), true);
  assert.equal(hasCommonReadExecute([{ ...rule, mask: 1 }]), false);
  assert.equal(hasCommonReadExecute([{ ...rule, sid: "S-1-5-21-private" }]), false);
  assert.equal(hasCommonReadExecute([{ ...rule, inheritOnly: true }]), false);
  assert.equal(hasCommonReadExecute([rule, { ...rule, sid: "S-1-5-21-unknown-group", deny: true }]), false);
  assert.equal(hasCommonReadExecute([]), false);
});
