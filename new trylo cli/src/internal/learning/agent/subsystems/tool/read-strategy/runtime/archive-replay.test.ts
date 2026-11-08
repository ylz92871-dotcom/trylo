import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf, sha256Hex } from "../../../../../control/hash.js";
import { object } from "../../../../../reward/validate.js";
import { createReadStrategyRuntime, READ_STRATEGY_DECISION_POINT } from "../index.js";

test("same-request replay refuses a stored strategy with a mismatched asset hash without publishing again", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-read-replay-corrupt-")), boardRoot = path.join(root, "board");

  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = "replay-contract", requestId = "existing-checked-pair", issuedAt = "2026-11-03T00:00:00.000Z";
  const versionId = `tool-read-policy:${contentHashOf([scope, requestId]).slice(0, 32)}`, proposalId = `proposal:${versionId}`;
  const content = JSON.stringify({ schemaVersion: 2, owner: "tool.read-strategy", decisionPoint: READ_STRATEGY_DECISION_POINT,
    scope, requestId, issuedAt, basedOnSequence: 0, rules: [{ conditions: { schemaVersion: 1, fileSize: "small", range: "bounded", streaming: true },
      path: "whole", evidenceIds: ["external-check"], feedbackIds: ["checked-feedback"],
      statistics: { whole: { samples: 2, meanCost: 10 }, stream: { samples: 2, meanCost: 100 } } }] });

  await withBoardWriter(boardRoot, async store => {
    assert.equal((await store.apply({ type: "submit_proposal", commandId: "replay:submit", issuedAt, proposal: {
      proposalId, domain: "tool", assetKind: "routing_policy", scope, candidateRef: versionId, hypothesis: "Stored checked read strategy",
      observationRefs: [], requiredVerifiers: [], requestedAuthorities: [], risk: "low", source: "inferred" } })).ok, true);
    assert.equal((await store.apply({ type: "quarantine", commandId: "replay:quarantine", issuedAt, proposalId })).ok, true);
    assert.equal((await store.apply({ type: "start_evaluation", commandId: "replay:evaluate", issuedAt, proposalId })).ok, true);
    assert.equal((await store.apply({ type: "commit_asset", commandId: "replay:commit", issuedAt, proposalId, versionId, schemaVersion: 2, content })).ok, true);
    const loaded = await store.load();
    assert.ok(loaded.ok);
    assert.equal((await store.snapshot(loaded.generation)).ok, true);
  });
  const runtime = createReadStrategyRuntime({ boardRoot, scope, sessionId: "session", turnId: "turn", enabled: true });
  const request = { domain: "tool", scope, requestId, issuedAt, budget: { maxObservations: 100 } };
  const validReplay = await runtime.learn(request);

  assert.equal(validReplay.status, "learned");
  assert.equal("versionId" in validReplay && validReplay.versionId, versionId);
  const file = path.join(boardRoot, "board-snapshot.json"), snapshot: unknown = JSON.parse(await readFile(file, "utf8"));

  assert.ok(object(snapshot) && object(snapshot.state));
  const state = snapshot.state;
  assert.ok(Array.isArray(state.assets));
  const stored: unknown = state.assets.find((value: unknown) => object(value) && value.versionId === versionId);
  assert.ok(object(stored));
  // A logically corrupt asset inside a structurally valid Board checkpoint, not a torn-file fixture.
  stored.contentHash = "0".repeat(64);
  snapshot.checksum = sha256Hex(canonicalJson({ generation: snapshot.generation, sequence: snapshot.sequence, state }));
  await writeFile(file, JSON.stringify(snapshot), "utf8");
  const before = await createBoardReader(boardRoot).load();
  assert.ok(before.ok);
  assert.equal(before.state.assets[0]!.contentHash, "0".repeat(64), "the real reader must reach the corrupt asset fixture");
  const result = await runtime.learn(request);

  assert.equal(result.status, "disabled", JSON.stringify(result));
  assert.equal(result.reason, "read_strategy_request_conflict");
  const after = await createBoardReader(boardRoot).load();
  assert.ok(after.ok);
  assert.equal(after.state.sequence, before.state.sequence);
  assert.equal(after.state.assets.length, 1);
});
