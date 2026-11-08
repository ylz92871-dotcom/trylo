import assert from "node:assert/strict";
import test from "node:test";
import { toolProductionSampleFailure } from "./production-check.js";

test("outcome attribution separates real frozen-oracle mismatch from backend failure and never exposes sample contents", () => {
  const sample = { sampleId: "private-case", role: "variation" as const, input: "private-input", expected: { kind: "value" as const, value: 7 } };

  assert.equal(toolProductionSampleFailure(sample, { kind: "value", value: 7 }, "heldout"), undefined);
  const wrong = toolProductionSampleFailure(sample, { kind: "value", value: 9 }, "heldout");

  assert.deepEqual(wrong, { caseSet: "heldout", executionKind: "value", cause: "sample_mismatch" });
  assert.equal(toolProductionSampleFailure(sample, { kind: "tool_error", code: "private-code", message: "private-stderr" }, "heldout")?.cause, "sample_mismatch");
  assert.equal(toolProductionSampleFailure(sample, { kind: "timeout", detail: "private-detail" }, "heldout")?.cause, "execution_timeout");
  assert.equal(toolProductionSampleFailure(sample, { kind: "unavailable", detail: "private-detail" }, "heldout")?.cause, "execution_unavailable");
  assert.equal(toolProductionSampleFailure(sample, { kind: "protocol_error", detail: "private-detail" }, "heldout")?.cause, "execution_protocol");
  assert.equal(JSON.stringify(wrong).includes("private"), false);
});
