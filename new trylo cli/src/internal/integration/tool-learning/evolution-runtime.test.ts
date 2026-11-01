import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import type { ToolEvolutionVerifier } from "../../learning/domains/tool/evolution/verification.js";
import type { ToolRunnerPort } from "../../ports/tool-runner-port.js";
import { createToolEvolutionArchive, listToolEvolutionCandidates } from "./evolution-archive.js";
import { createToolEvolutionRuntime } from "./evolution-runtime.js";

const request: ToolEvolutionRequest = {
  schemaVersion: 1, requestId: "sum-test", scope: "workspace:test", capability: "Sum a list of finite numbers", operation: "create",
  evidence: [
    { sampleId: "execution:one", role: "source", input: [1, 2], expected: { kind: "value", value: 3 } },
    { sampleId: "execution:two", role: "source", input: [4, 5], expected: { kind: "value", value: 9 } },
    { sampleId: "variation:negative", role: "variation", input: [-2, 5], expected: { kind: "value", value: 3 } },
    { sampleId: "counterexample:string", role: "counterexample", input: "bad", expected: { kind: "error", code: "invalid_input" } },
  ],
};
const candidate: ToolEvolutionCandidate = {
  identity: "sum_numbers", description: "Sums finite numbers; rejects non-array input.",
  source: "module.exports = input => { if (!Array.isArray(input)) throw Object.assign(new Error('invalid'), {code:'invalid_input'}); return input.reduce((a,b)=>a+b,0); };",
  inputSchema: { type: "array", items: { type: "number" } },
  mastery: { whenToUse: ["Sum a numeric list"], preconditions: ["All items are finite numbers"], pitfalls: ["Text must be parsed before calling"] },
};

function runner(output: string = JSON.stringify(candidate)): ToolRunnerPort {
  return { submit: async task => ({ taskId: task.taskId }), onProgress: () => () => {}, cancel: async () => true,
    status: async () => "completed", wait: async taskId => ({ taskId, status: "completed", observed: "terminal", output }) };
}
const passing: ToolEvolutionVerifier = { verify: async (value, input) => ({ verdict: "pass",
  candidateHash: sha256Hex(canonicalJson(value)), samplesHash: sha256Hex(canonicalJson(input.evidence)),
  checks: input.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "checked" })) }) };
const archive = { save: async () => ({ ok: true as const, proposalId: "p", versionId: "v" }) };

test("generation deadline refuses unbounded or invalid configuration", () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 300001]) {
    assert.throws(() => createToolEvolutionRuntime({ runner: runner(), verifier: passing, archive, now: () => 0, timeoutMs }), /timeout/);
  }
});

test("tool evolution checks externally supplied examples before returning a candidate", async () => {
  const result = await createToolEvolutionRuntime({ runner: runner(), verifier: passing, archive, now: () => 0 }).evolve(request, new AbortController().signal);
  assert.equal(result.kind, "candidate");
  if (result.kind === "candidate") assert.equal(result.artifact.verification.checks.length, 4);
});

test("tool evolution rejects stale candidate verification", async () => {
  const verifier: ToolEvolutionVerifier = { verify: async (value, input, signal) => ({ ...await passing.verify(value, input, signal), candidateHash: "old-bytes" }) };
  const result = await createToolEvolutionRuntime({ runner: runner(), verifier, archive, now: () => 0 }).evolve(request, new AbortController().signal);
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.code, "verification_binding_mismatch");
});

test("tool evolution rejects duplicate check identities pretending to cover every sample", async () => {
  const verifier: ToolEvolutionVerifier = { verify: async (value, input, signal) => ({ ...await passing.verify(value, input, signal),
    checks: input.evidence.map(() => ({ sampleId: "execution:one", role: "source", outcome: "passed", detail: "same sample" })) }) };
  const result = await createToolEvolutionRuntime({ runner: runner(), verifier, archive, now: () => 0 }).evolve(request, new AbortController().signal);
  assert.equal(result.kind, "failed");
});

test("tool evolution cancels a background task after an observation timeout", async () => {
  let cancelled = 0;
  const worker: ToolRunnerPort = { ...runner(), cancel: async () => { cancelled += 1; return true; },
    wait: async taskId => ({ taskId, observed: "timeout", status: "running" }) };
  const result = await createToolEvolutionRuntime({ runner: worker, verifier: passing, archive, now: () => 0 }).evolve(request, new AbortController().signal);
  assert.equal(result.kind, "failed");
  assert.equal(cancelled, 1);
});

test("tool evolution never archives a failed generalization", async () => {
  let saved = 0;
  const verifier: ToolEvolutionVerifier = { verify: async (value, input, signal) => ({ ...await passing.verify(value, input, signal), verdict: "fail" }) };
  const result = await createToolEvolutionRuntime({ runner: runner(), verifier,
    archive: { save: async () => { saved += 1; return { ok: true, proposalId: "p", versionId: "v" }; } }, now: () => 0 }).evolve(request, new AbortController().signal);
  assert.equal(result.kind, "failed");
  assert.equal(saved, 0);
});

test("tool evolution reports a throwing verifier or archive as a typed failure", async () => {
  const badVerifier: ToolEvolutionVerifier = { verify: async () => { throw new Error("verifier disconnected"); } };
  const badArchive = { save: async () => { throw new Error("disk refused"); } };
  for (const options of [{ verifier: badVerifier, archive }, { verifier: passing, archive: badArchive }]) {
    const result = await createToolEvolutionRuntime({ runner: runner(), ...options, now: () => 0 }).evolve(request, new AbortController().signal);
    assert.equal(result.kind, "failed");
  }
});

test("tool evolution archive survives reopening without an active pointer or second catalog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-evolution-"));
  try {
    const create = () => createToolEvolutionRuntime({ runner: runner(), verifier: passing, archive: createToolEvolutionArchive(directory), now: () => 0 });
    const first = await create().evolve(request, new AbortController().signal);
    const second = await create().evolve(request, new AbortController().signal);
    assert.equal(first.kind, "candidate");
    assert.equal(second.kind, "candidate");
    const loaded = await createBoardReader(directory).load();
    assert.equal(loaded.ok, true);
    if (loaded.ok) { assert.equal(loaded.state.assets.length, 1); assert.equal(loaded.state.activations.length, 0); }
    const view = await listToolEvolutionCandidates(directory);
    assert.equal(view.ok, true);
    if (view.ok) assert.equal(view.candidates.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("archive refuses an artifact whose claimed pass does not match its candidate bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-binding-"));
  try {
    const verification = await passing.verify(candidate, request, new AbortController().signal);
    const saved = await createToolEvolutionArchive(directory).save({ schemaVersion: 1, request, candidate,
      verification: { ...verification, candidateHash: "0".repeat(64) }, generatedAt: new Date(0).toISOString() });
    assert.equal(saved.ok, false);
    const loaded = await createBoardReader(directory).load();
    assert.equal(loaded.ok && loaded.state.assets.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("different generation provenance cannot silently return a previously stored artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-provenance-"));
  try {
    const archive = createToolEvolutionArchive(directory);
    const verification = await passing.verify(candidate, request, new AbortController().signal);
    const first = await archive.save({ schemaVersion: 1, request, candidate, verification, generatedAt: new Date(0).toISOString() });
    const second = await archive.save({ schemaVersion: 1, request, candidate, verification, generatedAt: new Date(1000).toISOString() });
    assert.equal(first.ok && second.ok && first.versionId !== second.versionId, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("improvement cannot claim an absent archived parent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trylo-tool-parent-"));
  try {
    const improved: ToolEvolutionRequest = { ...request, operation: "improve", prior: { versionId: "missing", source: candidate.source } };
    const verification = await passing.verify(candidate, improved, new AbortController().signal);
    const saved = await createToolEvolutionArchive(directory).save({ schemaVersion: 1, request: improved, candidate, verification, generatedAt: new Date(0).toISOString() });
    assert.equal(saved.ok, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
