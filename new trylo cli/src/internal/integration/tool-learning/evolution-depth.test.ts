import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { normalizeBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { ToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";
import type { ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import { evolutionPrompt } from "../../learning/domains/tool/evolution/prompt.js";
import { MAX_TOOL_TRIALS, type ToolTrialRecord } from "../../learning/domains/tool/evolution/trial.js";
import type { ToolEvolutionVerifier } from "../../learning/domains/tool/evolution/verification.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { candidateFromBoard, readToolEvolutionCandidate } from "./evolution-reader.js";
import { prepareToolImprovement, readToolEvolutionTrials, runToolEvolutionTrial } from "./evolution-trials.js";

const request: ToolEvolutionRequest = { schemaVersion: 1, requestId: "seed", scope: "lab:double", capability: "Double finite numbers",
  operation: "create", evidence: [
    { sampleId: "source-1", role: "source", input: 2, expected: { kind: "value", value: 4 } },
    { sampleId: "source-2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
    { sampleId: "hidden", role: "variation", input: 9, expected: { kind: "value", value: 18 } },
    { sampleId: "error", role: "counterexample", input: "bad", expected: { kind: "error", code: "invalid_input" } },
  ] };
const candidate = { identity: "double", description: "Double numbers", source: "module.exports = input => input * 2;",
  inputSchema: { type: "number" }, mastery: { whenToUse: ["Double a finite number"], preconditions: [], pitfalls: [] } };
const passed: ToolEvolutionVerifier = { verify: async (value, input) => ({ verdict: "pass",
  candidateHash: sha256Hex(canonicalJson(value)), samplesHash: sha256Hex(canonicalJson(input.evidence)),
  checks: input.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "TEST ONLY" })) }) };
const failed: ToolEvolutionVerifier = { verify: async (value, input, signal) => {
  const report = await passed.verify(value, input, signal);
  return { ...report, verdict: "fail", checks: report.checks.map(check => check.role === "variation"
    ? { ...check, outcome: "wrong_result", detail: "HIDDEN_EXPECTED_ANSWER must not reach the generator" } : check) };
} };
const signal = new AbortController().signal;

async function seed(t: TestContext) {
  // The managed Windows tool sandbox refuses rename in its redirected OS temp.
  // Use an owned workspace fixture so compaction exercises the product store.
  const base = path.resolve("Temp/tool-evolution-depth-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact: ToolEvolutionArtifact = { schemaVersion: 1, request, candidate, generatedAt: new Date(0).toISOString(),
    verification: await passed.verify(candidate, request, signal) };
  const saved = await createToolEvolutionArchive(root).save(artifact);
  assert.ok(saved.ok);
  return { root, artifact, versionId: saved.versionId };
}

test("candidate reader validates content and verification before returning executable source", async t => {
  const fx = await seed(t);
  const read = await readToolEvolutionCandidate(fx.root, fx.versionId);
  assert.ok(read.ok);
  assert.deepEqual(read.artifact, fx.artifact);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  const altered = { ...loaded.state, assets: loaded.state.assets.map(asset => ({ ...asset, content: {
    type: "tool_evolution_candidate", ...fx.artifact, candidate: { ...candidate, source: "module.exports = () => 0" },
  } })) };
  assert.equal(candidateFromBoard(altered, fx.versionId).ok, false);
  const invalid = { ...loaded.state, assets: loaded.state.assets.map(asset => ({ ...asset, content: { type: "tool_evolution_candidate" } })) };
  assert.equal(candidateFromBoard(invalid, fx.versionId).ok, false);
  const legacyVersion = `tool-evolution_${sha256Hex(canonicalJson({ request, candidate, verification: fx.artifact.verification }))}`;
  assert.equal(candidateFromBoard({ ...loaded.state, assets: loaded.state.assets.map(asset => ({ ...asset, versionId: legacyVersion })) }, legacyVersion).ok, true);
});

test("archive resumes an interrupted command sequence without duplicate assets or activation", async t => {
  const fx = await seed(t);
  const artifact = { ...fx.artifact, generatedAt: new Date(1).toISOString() };
  let appends = 0;
  const interrupted = await createToolEvolutionArchive(fx.root, { logAppender: (file, data, encoding) => {
    appends += 1;
    if (appends === 2) throw new Error("TEST injected append failure");
    appendFileSync(file, data, encoding);
  } }).save(artifact);
  assert.equal(interrupted.ok, false);
  const recovered = await createToolEvolutionArchive(fx.root).save(artifact);
  assert.ok(recovered.ok);
  assert.ok((await readToolEvolutionCandidate(fx.root, recovered.versionId)).ok);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.assets.length, 2);
  assert.equal(loaded.state.proposals.length, 2);
  assert.equal(loaded.state.activations.length, 0);
});

test("improvement binds exact source and scope and records immutable parent lineage", async t => {
  const fx = await seed(t);
  const prepared = await prepareToolImprovement(fx.root, fx.versionId, { ...request, requestId: "improvement" });
  assert.ok(prepared.ok);
  assert.equal(prepared.request.prior.source, candidate.source);
  const child: ToolEvolutionArtifact = { ...fx.artifact, request: prepared.request, generatedAt: new Date(2).toISOString() };
  for (const invalidRequest of [{ ...prepared.request, scope: "another-scope" },
    { ...prepared.request, prior: { versionId: fx.versionId, source: "pretend parent" } }]) {
    assert.equal((await createToolEvolutionArchive(fx.root).save({ ...child, request: invalidRequest })).ok, false);
  }
  const saved = await createToolEvolutionArchive(fx.root).save(child);
  assert.ok(saved.ok);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.assets.find(asset => asset.versionId === saved.versionId)?.parentVersionId, fx.versionId);
  assert.equal(loaded.state.proposals.find(proposal => proposal.proposalId === saved.proposalId)?.baseVersionId, fx.versionId);
  assert.equal(loaded.state.assets.length, 2);
});

test("failed frozen-version trials survive reopening and same-ID retry avoids another execution", async t => {
  const fx = await seed(t);
  let calls = 0;
  const verifier: ToolEvolutionVerifier = { verify: async (...args) => { calls += 1; return failed.verify(...args); } };
  const options = { boardRoot: fx.root, verifier, now: () => 1000 };
  const input = { ...request, requestId: "new-trial" };
  const first = await runToolEvolutionTrial(options, fx.versionId, input, signal);
  assert.ok("kind" in first && first.kind === "trial");
  assert.equal(first.record.verification.verdict, "fail");
  assert.equal(first.source, "executed");
  const second = await runToolEvolutionTrial(options, fx.versionId, input, signal);
  assert.ok("kind" in second && second.kind === "trial");
  assert.equal(second.source, "replayed");
  assert.equal(calls, 1);
  const conflict = await runToolEvolutionTrial(options, fx.versionId, { ...input, capability: "different work" }, signal);
  assert.ok("ok" in conflict && !conflict.ok);
  assert.equal(conflict.code, "tool_trial_conflict");
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.toolTrials?.length, 1);
  assert.equal(loaded.state.evidence.length, 0);
  assert.equal(loaded.state.activations.length, 0);
});

test("unavailable, cancelled, stale, and throwing trials create no tool failure or quality evidence", async t => {
  const fx = await seed(t);
  const cases: ToolEvolutionVerifier[] = [
    { verify: async () => { throw new Error("TEST disconnected verifier"); } },
    { verify: async (...args) => ({ ...await passed.verify(...args), verdict: "unavailable", checks: [] }) },
    { verify: async (...args) => ({ ...await passed.verify(...args), verdict: "cancelled", checks: [] }) },
    { verify: async (...args) => ({ ...await passed.verify(...args), samplesHash: "0".repeat(64) }) },
  ];
  for (const verifier of cases) {
    const result = await runToolEvolutionTrial({ boardRoot: fx.root, verifier, now: () => 0 }, fx.versionId, request, signal);
    assert.ok(("kind" in result && result.kind === "cancelled") || ("ok" in result && !result.ok));
  }
  const history = await readToolEvolutionTrials(fx.root, fx.versionId);
  assert.ok(history.ok);
  assert.deepEqual(history.records, []);
});

test("a lost write acknowledgement is recovered from the durable trial before re-executing", async t => {
  const fx = await seed(t);
  let calls = 0;
  const verifier: ToolEvolutionVerifier = { verify: async (...args) => { calls += 1; return passed.verify(...args); } };
  const first = await runToolEvolutionTrial({ boardRoot: fx.root, verifier, now: () => 0,
    storeOptions: { logAppender: (file, data, encoding) => { appendFileSync(file, data, encoding); throw new Error("TEST lost acknowledgement"); } },
  }, fx.versionId, request, signal);
  assert.ok("ok" in first && !first.ok);
  const replay = await runToolEvolutionTrial({ boardRoot: fx.root, verifier, now: () => 1000 }, fx.versionId, request, signal);
  assert.ok("kind" in replay && replay.kind === "trial");
  assert.equal(replay.source, "replayed");
  assert.equal(calls, 1);
});

test("feedback reaches improvement as bounded diagnostic identities without hidden answers", async t => {
  const fx = await seed(t);
  await runToolEvolutionTrial({ boardRoot: fx.root, verifier: failed, now: () => 1000 }, fx.versionId, { ...request, requestId: "failure" }, signal);
  const prepared = await prepareToolImprovement(fx.root, fx.versionId, { ...request, requestId: "repair" });
  assert.ok(prepared.ok);
  assert.match(prepared.feedback ?? "", /wrong_result/);
  const prompt = evolutionPrompt(prepared.request, prepared.feedback);
  assert.doesNotMatch(prompt, /HIDDEN_EXPECTED_ANSWER/);
  assert.match(prompt, /上次真实检查/);
});

test("trial snapshots and compaction preserve facts; malformed optional records fail closed", async t => {
  const fx = await seed(t);
  await runToolEvolutionTrial({ boardRoot: fx.root, verifier: passed, now: () => 1000 }, fx.versionId, request, signal);
  const compacted = await withBoardWriter(fx.root, async store => {
    const loaded = await store.load();
    assert.ok(loaded.ok);
    return store.compact(loaded.generation);
  });
  assert.ok(compacted.ok, "reason" in compacted ? `${compacted.reason}: ${compacted.detail}` : "compaction failed");
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.toolTrials?.length, 1);
  const { toolTrials: _records, ...legacy } = loaded.state;
  assert.deepEqual(normalizeBoardState(legacy)?.toolTrials, []);
  assert.equal(normalizeBoardState({ ...loaded.state, toolTrials: [{ broken: true } as unknown as ToolTrialRecord] }), undefined);
  const record = loaded.state.toolTrials?.[0];
  assert.ok(record);
  const conflict = reduce(loaded.state, { type: "record_tool_trial", commandId: "different-command", issuedAt: record.occurredAt,
    record: { ...record, scope: "another-scope" } });
  assert.equal(conflict.ok, false);
  const full = { ...loaded.state, toolTrials: Array.from({ length: MAX_TOOL_TRIALS }, (_, index) => ({ ...record, trialId: `trial-${index}` })) };
  const capped = reduce(full, { type: "record_tool_trial", commandId: "capacity-check", issuedAt: record.occurredAt, record });
  assert.ok(!capped.ok);
  assert.equal(capped.reason, "tool_trial_capacity");
});

test("new trial facts remain readable after compaction and a second compaction", async t => {
  const fx = await seed(t);
  const options = { boardRoot: fx.root, verifier: passed, now: () => 1000 };
  for (const requestId of ["before-compaction", "after-compaction"]) {
    const result = await runToolEvolutionTrial(options, fx.versionId, { ...request, requestId }, signal);
    assert.ok("kind" in result && result.kind === "trial");
    const compacted = await withBoardWriter(fx.root, async store => {
      const loaded = await store.load();
      assert.ok(loaded.ok, "reason" in loaded ? loaded.reason : "load failed");
      return store.compact(loaded.generation);
    });
    assert.ok(compacted.ok, "reason" in compacted ? `${compacted.reason}: ${compacted.detail}` : "compaction failed");
  }
  const history = await readToolEvolutionTrials(fx.root, fx.versionId);
  assert.ok(history.ok);
  assert.equal(history.records.length, 2);
});

test("a corrupt compacted trial snapshot cannot silently turn a nonempty Board into empty", async t => {
  const fx = await seed(t);
  await runToolEvolutionTrial({ boardRoot: fx.root, verifier: passed, now: () => 1000 }, fx.versionId, request, signal);
  await withBoardWriter(fx.root, async store => {
    const loaded = await store.load();
    assert.ok(loaded.ok);
    return store.compact(loaded.generation);
  });
  const file = path.join(fx.root, "board-snapshot.json");
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  snapshot.state.toolTrials = [{ broken: true }];
  snapshot.checksum = sha256Hex(canonicalJson({ generation: snapshot.generation, sequence: snapshot.sequence, state: snapshot.state }));
  await writeFile(file, JSON.stringify(snapshot));
  const loaded = await createBoardReader(fx.root).load();
  assert.equal(loaded.ok, false, "a compacted history has no complete log to rebuild this malformed snapshot");
});
