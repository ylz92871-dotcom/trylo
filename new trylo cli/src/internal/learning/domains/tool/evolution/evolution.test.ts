import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_EVOLUTION_MAX_ATTEMPTS,
  TOOL_EVOLUTION_MAX_CANDIDATE_BYTES,
  TOOL_EVOLUTION_MAX_JSON_DEPTH,
  TOOL_EVOLUTION_MAX_MASTERY_ITEMS,
  TOOL_EVOLUTION_MAX_PREVIOUS_FAILURE_CHARS,
  TOOL_EVOLUTION_MAX_SAMPLE_BYTES,
  TOOL_EVOLUTION_MAX_SOURCE_BYTES,
  type ToolEvolutionCandidate,
  type ToolEvolutionRequest,
} from "./contracts.js";
import { parseToolEvolutionCandidate, parseToolEvolutionRequest } from "./parse.js";
import { evolutionPrompt } from "./prompt.js";

const REQUEST: ToolEvolutionRequest = {
  schemaVersion: 1,
  requestId: "sum-fixture",
  scope: "project:fixture",
  capability: "sum a bounded list of numbers",
  operation: "create",
  evidence: [
    { sampleId: "source-1", role: "source", input: [1, 2], expected: { kind: "value", value: 3 } },
    { sampleId: "source-2", role: "source", input: [3, 4], expected: { kind: "value", value: 7 } },
    { sampleId: "variation", role: "variation", input: [], expected: { kind: "value", value: 0 } },
    { sampleId: "counterexample", role: "counterexample", input: ["bad"], expected: { kind: "error", code: "invalid_input" } },
  ],
};

const CANDIDATE: ToolEvolutionCandidate = {
  identity: "sum_numbers",
  description: "Sums a list of finite numbers.",
  source: "module.exports = function(input) { return input.reduce((a, b) => a + b, 0); };",
  inputSchema: { type: "array", items: { type: "number" } },
  mastery: {
    whenToUse: ["A sum of numeric values is required."],
    preconditions: ["Every element is a finite number."],
    pitfalls: ["Numeric strings are invalid; do not coerce them."],
  },
};

function request(over: Readonly<Record<string, unknown>>): unknown {
  return { ...REQUEST, ...over };
}

function candidate(over: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ ...CANDIDATE, ...over });
}

test("request accepts two source successes, a variation and a counterexample without changing their oracle", () => {
  const parsed = parseToolEvolutionRequest(REQUEST);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, REQUEST);
});

test("request rejects unsupported versions and unknown authority fields", () => {
  assert.equal(parseToolEvolutionRequest(request({ schemaVersion: 2 })).ok, false);
  assert.equal(parseToolEvolutionRequest(request({ permissions: ["shell"] })).ok, false);
});

test("request requires two successful source samples and both boundary roles", () => {
  for (const evidence of [REQUEST.evidence.slice(1), REQUEST.evidence.slice(0, 3), REQUEST.evidence.filter(s => s.role !== "variation")]) {
    const parsed = parseToolEvolutionRequest(request({ evidence }));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.code, "insufficient_samples");
  }
  const failedSource = REQUEST.evidence.map(s => s.sampleId === "source-1" ? { ...s, expected: { kind: "error", code: "no" } } : s);
  assert.equal(parseToolEvolutionRequest(request({ evidence: failedSource })).ok, false);
});

test("request rejects repeated sample identities even when their inputs differ", () => {
  const evidence = REQUEST.evidence.map(s => s.sampleId === "source-2" ? { ...s, sampleId: "source-1" } : s);
  const parsed = parseToolEvolutionRequest(request({ evidence }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, "duplicate_sample_id");
});

test("request validates sample role, expected result discriminant and exact fields", () => {
  const first = REQUEST.evidence[0];
  for (const sample of [
    { ...first, role: "training" },
    { ...first, expected: { kind: "error", code: "" } },
    { ...first, expected: { kind: "value", value: 3, code: "invented" } },
    { ...first, skipValidation: true },
    { ...first, sampleId: "" },
  ]) {
    assert.equal(parseToolEvolutionRequest(request({ evidence: [sample, ...REQUEST.evidence.slice(1)] })).ok, false);
  }
});

test("improve requires the exact prior version and source; create leaves prior absent", () => {
  const missing = parseToolEvolutionRequest(request({ operation: "improve" }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "invalid_prior");
  const prior = { versionId: "tool-v1", source: CANDIDATE.source };
  const parsed = parseToolEvolutionRequest(request({ operation: "improve", prior }));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value.prior, prior);
  assert.equal(parseToolEvolutionRequest(request({ prior: { ...prior, versionId: "" } })).ok, false);
});

test("request bounds explicit attempts without inventing a default", () => {
  for (const maxAttempts of [0, -1, 1.5, TOOL_EVOLUTION_MAX_ATTEMPTS + 1, "2"]) {
    const parsed = parseToolEvolutionRequest(request({ maxAttempts }));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.code, "invalid_attempts");
  }
  const accepted = parseToolEvolutionRequest(request({ maxAttempts: TOOL_EVOLUTION_MAX_ATTEMPTS }));
  assert.equal(accepted.ok, true);
});

test("request rejects non-JSON values and cyclic or excessively nested samples", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = 0;
  for (let n = 0; n <= TOOL_EVOLUTION_MAX_JSON_DEPTH; n += 1) deep = { nested: deep };
  for (const input of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 3, cycle, deep, new Date(0)]) {
    const evidence = REQUEST.evidence.map((s, i) => i === 0 ? { ...s, input } : s);
    assert.equal(parseToolEvolutionRequest(request({ evidence })).ok, false);
  }
});

test("request refuses array accessors without evaluating untrusted getters", () => {
  let reads = 0;
  const input = [1, 2];
  Object.defineProperty(input, "0", { enumerable: true, get: () => { reads += 1; return 1; } });
  const evidence = REQUEST.evidence.map((sample, index) => index === 0 ? { ...sample, input } : sample);
  const parsed = parseToolEvolutionRequest(request({ evidence }));
  assert.equal(reads, 0, "JSON validation must inspect the descriptor rather than run its getter");
  assert.equal(parsed.ok, false);
});

test("request bounds each sample by UTF-8 bytes rather than accepting oversized text", () => {
  const evidence = REQUEST.evidence.map((s, i) => i === 0 ? { ...s, input: "汉".repeat(TOOL_EVOLUTION_MAX_SAMPLE_BYTES / 2) } : s);
  const parsed = parseToolEvolutionRequest(request({ evidence }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.code, "payload_too_large");
});

test("request detaches parsed evidence from the caller's mutable input", () => {
  const input = structuredClone(REQUEST);
  const parsed = parseToolEvolutionRequest(input);
  assert.equal(parsed.ok, true);
  Object.defineProperty(input.evidence[0]?.expected, "value", { value: 99 });
  if (parsed.ok) assert.deepEqual(parsed.value.evidence[0]?.expected, { kind: "value", value: 3 });
});

test("candidate parses a complete candidate JSON object and an exact JSON fence", () => {
  for (const text of [JSON.stringify(CANDIDATE), `\u0060\u0060\u0060json\n${JSON.stringify(CANDIDATE)}\n\u0060\u0060\u0060`]) {
    const parsed = parseToolEvolutionCandidate(text);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value, CANDIDATE);
  }
});

test("candidate rejects ambiguous or malformed model responses", () => {
  for (const text of ["", "not-json", JSON.stringify(CANDIDATE) + JSON.stringify(CANDIDATE), `Explanation: ${JSON.stringify(CANDIDATE)}`, "null", "[]"]) {
    assert.equal(parseToolEvolutionCandidate(text).ok, false);
  }
});

test("candidate cannot change expected outcomes, request authority or approval state", () => {
  for (const extra of [{ evidence: [] }, { expected: 99 }, { permissions: ["shell"] }, { approved: true }]) {
    const parsed = parseToolEvolutionCandidate(candidate(extra));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.code, "invalid_candidate");
  }
});

test("candidate requires a safe identity, bounded source and a JSON object schema", () => {
  for (const over of [{ identity: "../../escape" }, { description: "" }, { source: " " }, { inputSchema: [] }, { inputSchema: null }]) {
    assert.equal(parseToolEvolutionCandidate(candidate(over)).ok, false);
  }
  const huge = parseToolEvolutionCandidate(candidate({ source: "a".repeat(TOOL_EVOLUTION_MAX_SOURCE_BYTES + 1) }));
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.code, "payload_too_large");
});

test("candidate requires bounded applicability guidance and rejects extra mastery capabilities", () => {
  for (const mastery of [
    { ...CANDIDATE.mastery, whenToUse: [] },
    { ...CANDIDATE.mastery, pitfalls: [""] },
    { ...CANDIDATE.mastery, whenToUse: Array.from({ length: TOOL_EVOLUTION_MAX_MASTERY_ITEMS + 1 }, () => "use") },
    { ...CANDIDATE.mastery, allowNetwork: true },
  ]) {
    assert.equal(parseToolEvolutionCandidate(candidate({ mastery })).ok, false);
  }
});

test("candidate input and schema JSON have total size and depth bounds", () => {
  assert.equal(parseToolEvolutionCandidate(" ".repeat(TOOL_EVOLUTION_MAX_CANDIDATE_BYTES + 1)).ok, false);
  let inputSchema: unknown = { type: "number" };
  for (let n = 0; n <= TOOL_EVOLUTION_MAX_JSON_DEPTH; n += 1) inputSchema = { properties: { input: inputSchema } };
  assert.equal(parseToolEvolutionCandidate(candidate({ inputSchema })).ok, false);
});

test("prompt carries complete source examples and keeps the generation contract deterministic", () => {
  const prompt = evolutionPrompt(REQUEST);
  for (const sample of REQUEST.evidence.filter(item => item.role === "source")) {
    assert.equal(prompt.includes(JSON.stringify(sample)), true);
  }
  assert.equal(prompt.includes("module.exports"), true);
  assert.equal(prompt.includes("expected"), true);
  assert.equal(prompt.includes("mastery"), true);
  assert.equal(prompt.includes("inputSchema"), true);
  assert.equal(prompt, evolutionPrompt(REQUEST));
});

test("prompt withholds variation and counterexample inputs, oracle values and sample identities", () => {
  const hiddenRequest: ToolEvolutionRequest = {
    ...REQUEST,
    evidence: [
      ...REQUEST.evidence.filter(sample => sample.role === "source"),
      { sampleId: "hidden-variation-74", role: "variation", input: { secret: "variation-input-secret-61" },
        expected: { kind: "value", value: "variation-oracle-secret-83" } },
      { sampleId: "hidden-counterexample-92", role: "counterexample", input: { secret: "counterexample-input-secret-25" },
        expected: { kind: "error", code: "invalid_input" } },
    ],
  };
  const prompt = evolutionPrompt(hiddenRequest);
  for (const secret of ["hidden-variation-74", "variation-input-secret-61", "variation-oracle-secret-83",
    "hidden-counterexample-92", "counterexample-input-secret-25"]) {
    assert.equal(prompt.includes(secret), false, `hidden verification data leaked: ${secret}`);
  }
  assert.equal(prompt.includes('"hiddenSampleCounts":{"variation":1,"counterexample":1}'), true);
  assert.equal(prompt.includes('"errorCodes":["invalid_input"]'), true);
});

test("prompt carries prior code and bounded failure feedback as data", () => {
  const prior = { versionId: "old-v1", source: "module.exports = () => 42;" };
  const prompt = evolutionPrompt({ ...REQUEST, operation: "improve", prior }, "unexpected result");
  assert.equal(prompt.includes(JSON.stringify(prior)), true);
  assert.equal(prompt.includes("unexpected result"), true);
  const marker = "outside-the-budget";
  assert.equal(evolutionPrompt(REQUEST, "x".repeat(TOOL_EVOLUTION_MAX_PREVIOUS_FAILURE_CHARS) + marker).includes(marker), false);
});
