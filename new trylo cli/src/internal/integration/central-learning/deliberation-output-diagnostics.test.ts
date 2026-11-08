import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_FINISH_REASONS } from "../../ports/provider.js";
import { classifyCentralToolArguments, isCentralDeliberationOutputDiagnostics,
  type CentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";

const safe: CentralDeliberationOutputDiagnostics = { schemaVersion: 1, rejectionReason: "central_deliberation_tool_invalid",
  cause: "open_json", argumentChars: 27, toolStarts: 1, invalidTools: 1, requestedOutputTokens: 8192, finishReason: "length",
  usageObserved: true, streamExhausted: true, usageTailComplete: true };

test("argument syntax is classified without returning malformed input or inferring truncation cause", () => {
  for (const text of ['{"key":', '{"key":"unfinished', '[{"key":1}', '{"escaped":"value\\']) {
    assert.equal(classifyCentralToolArguments(text), "open_json");
  }

  for (const text of ["null", "[]", "[1]", "1", "true", '"a scalar"']) {
    assert.equal(classifyCentralToolArguments(text), "non_object_json");
  }

  for (const text of ["", " ", "not JSON", "{]", '{"key":1,}']) {
    assert.equal(classifyCentralToolArguments(text), "invalid_json");
  }

  for (const text of ["{}", '{"nested":{"list":[1,2]},"text":"valid"}']) {
    assert.equal(classifyCentralToolArguments(text), "unknown", "a valid object does not establish semantic schema validity");
  }
});

test("the diagnostics contract rejects extra body fields, unknown enums and unsafe counters", () => {
  assert.ok(isCentralDeliberationOutputDiagnostics(safe));

  for (const requestedOutputTokens of [null, 1, 8192, Number.MAX_SAFE_INTEGER]) {
    assert.ok(isCentralDeliberationOutputDiagnostics({ ...safe, requestedOutputTokens }));
  }

  for (const requestedOutputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "8192", undefined]) {
    assert.equal(isCentralDeliberationOutputDiagnostics({ ...safe, requestedOutputTokens }), false);
  }

  const missingOutputLimit = Object.fromEntries(Object.entries(safe).filter(([key]) => key !== "requestedOutputTokens"));

  assert.equal(isCentralDeliberationOutputDiagnostics(missingOutputLimit), false, "the actual request output limit is a required field");

  for (const finishReason of [...PROVIDER_FINISH_REASONS, null]) assert.ok(isCentralDeliberationOutputDiagnostics({ ...safe, finishReason }));

  for (const cause of ["open_json", "non_object_json", "invalid_json", "tool_id_mismatch", "unexpected_tool", "mixed_output",
    "missing_output", "length_termination", "unknown"]) assert.ok(isCentralDeliberationOutputDiagnostics({ ...safe, cause }));

  for (const rejectionReason of ["central_deliberation_tool_invalid", "central_deliberation_tool_forbidden",
    "central_deliberation_mixed_output", "central_deliberation_json_invalid", "central_deliberation_incomplete"]) {
    assert.ok(isCentralDeliberationOutputDiagnostics({ ...safe, rejectionReason }));
  }

  for (const extra of [{ arguments: "private arguments" }, { reasoning: "private reasoning" }, { toolName: "private tool" },
    { error: "raw parser error" }]) assert.equal(isCentralDeliberationOutputDiagnostics({ ...safe, ...extra }), false);

  for (const invalid of [null, [], {}, { ...safe, schemaVersion: 2 }, { ...safe, cause: "raw parser text" },
    { ...safe, rejectionReason: "central_deliberation_timeout" }, { ...safe, finishReason: "truncated" },
    { ...safe, usageObserved: 1 }, { ...safe, streamExhausted: "true" }, { ...safe, usageTailComplete: null }]) {
    assert.equal(isCentralDeliberationOutputDiagnostics(invalid), false);
  }

  for (const key of ["argumentChars", "toolStarts", "invalidTools"]) {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
      assert.equal(isCentralDeliberationOutputDiagnostics({ ...safe, [key]: value }), false);
    }
    assert.ok(isCentralDeliberationOutputDiagnostics({ ...safe, [key]: 0 }));
  }
});

test("serialization preserves only safe metadata and never includes rejected arguments", () => {
  const privateInput = '{"private":"private-input-must-not-be-persisted';
  const cause = classifyCentralToolArguments(privateInput);

  assert.ok(cause !== "wire_frame_invalid", "a v1 argument-syntax fixture cannot classify an SSE frame gap");
  const diagnostic: Extract<CentralDeliberationOutputDiagnostics, { schemaVersion: 1 }> = {
    ...safe, cause, argumentChars: privateInput.length };
  const serialized = JSON.stringify(diagnostic), restored: unknown = JSON.parse(serialized);

  assert.ok(isCentralDeliberationOutputDiagnostics(restored));
  assert.deepEqual(restored, diagnostic);
  assert.equal(serialized.includes(privateInput), false);
  assert.equal(serialized.includes("private-input-must-not-be-persisted"), false);
  assert.deepEqual(Object.keys(restored).sort(), ["schemaVersion", "rejectionReason", "cause", "argumentChars", "toolStarts", "invalidTools",
    "requestedOutputTokens", "finishReason", "usageObserved", "streamExhausted", "usageTailComplete"].sort());
});
