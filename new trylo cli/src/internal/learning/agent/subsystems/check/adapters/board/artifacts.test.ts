import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter, type LogAppender } from "../../../../../../adapters/learning-store/file-event-store.js";
import { canonicalJson, sha256Hex } from "../../../../../control/hash.js";
import { resolveProfile } from "../../../../../profile/resolver.js";
import { isCheckAssetAvailable, readCheckArtifacts, writeCheckArtifact, type CheckArtifactInput } from "./artifacts.js";

const AT = "2026-11-03T00:00:00.000Z";
const input = (versionId = "check:contract:v1"): CheckArtifactInput => ({ versionId, kind: "verification_recipe",
  scope: "project:board-contract", source: "inferred", sourceRefs: ["execution:source-task"],
  content: { schemaVersion: 1, type: "test_only_contract_payload", sample: "zero" }, issuedAt: AT,
  hypothesis: "TEST ONLY: Board persistence contract without a verification claim" });

async function fixture(t: TestContext) {
  const base = testScratchPath("check-board-contract-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function failOnAppend(target: number): LogAppender {
  let attempts = 0;
  return (file, body, encoding) => {
    attempts += 1;
    if (attempts === target) throw new Error("TEST ONLY: injected Board append failure");
    appendFileSync(file, body, encoding);
  };
}

test("empty legacy Board loads, immutable retry is idempotent, and data gains no activation", async t => {
  const root = await fixture(t);
  const empty = await readCheckArtifacts(root);
  assert.ok(empty.ok);
  assert.equal(empty.state.assets.length, 0);
  const first = await writeCheckArtifact(root, input());
  assert.ok(first.ok);
  assert.equal(first.idempotent, false);
  const before = await readCheckArtifacts(root);
  assert.ok(before.ok);
  const again = await writeCheckArtifact(root, { ...input(), issuedAt: "2026-11-03T01:00:00.000Z" });

  assert.ok(again.ok);
  assert.equal(again.idempotent, true);
  const reopened = await readCheckArtifacts(root);
  assert.ok(reopened.ok);
  assert.equal(reopened.state.sequence, before.state.sequence);
  assert.equal(reopened.state.assets.length, 1);
  assert.equal(reopened.state.proposals[0]?.lifecycle, "evaluating");
  assert.equal(isCheckAssetAvailable(reopened.state, reopened.state.assets[0]!), true);
  assert.deepEqual(reopened.state.activations, []);
  assert.deepEqual(reopened.state.approvals, []);
  assert.deepEqual(resolveProfile(reopened.state, { scope: input().scope }).requiredCheckRefs, []);
  const wideScope = await writeCheckArtifact(root, { ...input("check:wide-scope"), scope: "s".repeat(512) });

  assert.ok(wideScope.ok);
  const invalidDate = await writeCheckArtifact(root, { ...input("check:bad-date"), issuedAt: "2026-02-30T00:00:00.000Z" });

  assert.ok(!invalidDate.ok && invalidDate.code === "check_artifact_invalid");
});

test("same committed or pending identity cannot be rebound to a different payload", async t => {
  const root = await fixture(t);

  assert.ok((await writeCheckArtifact(root, input())).ok);
  const changed = await writeCheckArtifact(root, { ...input(), content: { sample: "different" } });

  assert.ok(!changed.ok && changed.code === "check_artifact_conflict");
  const pendingInput = input("check:pending:v1");
  const interrupted = await writeCheckArtifact(root, pendingInput, { logAppender: failOnAppend(2) });

  assert.equal(interrupted.ok, false);
  const pending = await readCheckArtifacts(root);
  assert.ok(pending.ok);
  assert.equal(pending.state.proposals.find(item => item.proposalId.includes(pendingInput.versionId))?.lifecycle, "draft");
  const rebound = await writeCheckArtifact(root, { ...pendingInput, content: { sample: "replacement during recovery" } });

  assert.ok(!rebound.ok && rebound.code === "check_artifact_conflict");
  assert.ok((await writeCheckArtifact(root, pendingInput)).ok);
  const recovered = await readCheckArtifacts(root);
  assert.ok(recovered.ok);
  assert.deepEqual(recovered.state.assets.find(asset => asset.versionId === pendingInput.versionId)?.content, pendingInput.content);
});

test("real partial log append resumes once and preserves another learning domain", async t => {
  const root = await fixture(t);
  const seeded = await withBoardWriter(root, async store => {
    const proposalId = "unrelated-user-proposal";
    const draft = await store.apply({ type: "submit_proposal", commandId: "unrelated-submit", issuedAt: AT,
      proposal: { proposalId, domain: "user", scope: "user:contract", assetKind: "user_rule", candidateRef: "unrelated-user-asset",
        hypothesis: "preserve unrelated work", observationRefs: ["user_explicit:unrelated"], risk: "low",
        requiredVerifiers: [], requestedAuthorities: [], source: "user_explicit" } });

    assert.ok(draft.ok);

    return store.apply({ type: "commit_asset", commandId: "unrelated-commit", issuedAt: AT, proposalId,
      versionId: "unrelated-user-asset", content: { text: "retain this existing user rule" }, schemaVersion: 1 });
  });

  assert.ok(seeded.ok);
  const before = await readCheckArtifacts(root);
  assert.ok(before.ok);
  const unrelated = before.state.assets[0];
  const interrupted = await writeCheckArtifact(root, input(), { logAppender: failOnAppend(3) });

  assert.ok(!interrupted.ok && interrupted.code === "board_unavailable");
  const partial = await readCheckArtifacts(root);
  assert.ok(partial.ok);
  assert.equal(partial.state.assets.some(asset => asset.versionId === input().versionId), false);
  assert.equal(partial.state.proposals.find(item => item.domain === "verifier")?.lifecycle, "quarantined");
  const retry = await writeCheckArtifact(root, input());
  assert.ok(retry.ok);
  const reopened = await readCheckArtifacts(root);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.state.assets.find(asset => asset.versionId === "unrelated-user-asset"), unrelated);
  assert.equal(reopened.state.assets.filter(asset => asset.versionId === input().versionId).length, 1);
  assert.equal(reopened.state.proposals.filter(item => item.domain === "verifier").length, 1);
  const log = await readFile(path.join(root, "board-events.ndjson"), "utf8");

  assert.equal(log.trim().split("\n").length, 6, "two unrelated commands plus exactly four check commands");
});

test("withdrawal keeps intact history but rejects reuse or descendant admission", async t => {
  const root = await fixture(t);

  assert.ok((await writeCheckArtifact(root, input())).ok);
  const withdrawn = await withBoardWriter(root, store => store.apply({ type: "tombstone", commandId: "withdraw-check",
    issuedAt: AT, entityId: input().versionId, entityType: "asset", reason: "explicit correction withdrew this version" }));

  assert.ok(withdrawn.ok);
  const loaded = await readCheckArtifacts(root);
  assert.ok(loaded.ok, "withdrawal is availability, not corrupt data");
  assert.equal(loaded.state.assets.length, 1);
  assert.equal(isCheckAssetAvailable(loaded.state, loaded.state.assets[0]!), false);
  const retry = await writeCheckArtifact(root, input());

  assert.ok(!retry.ok && retry.code === "check_artifact_unavailable");
  const child = await writeCheckArtifact(root, { ...input("check:child:v2"), parentVersionId: input().versionId });

  assert.ok(!child.ok && child.code === "check_artifact_parent_invalid");
});

test("checksum-valid snapshot with a bad asset hash fails the check reader closed", async t => {
  const root = await fixture(t);

  assert.ok((await writeCheckArtifact(root, input())).ok);
  const snap = await withBoardWriter(root, store => store.snapshot(0));
  assert.ok(snap.ok);
  const snapshotFile = path.join(root, "board-snapshot.json");
  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));

  snapshot.state.assets[0].contentHash = "0".repeat(64);
  snapshot.checksum = sha256Hex(canonicalJson({ generation: snapshot.generation, sequence: snapshot.sequence, state: snapshot.state }));
  await writeFile(snapshotFile, JSON.stringify(snapshot) + "\n", "utf8");
  const generic = await createBoardReader(root).load();
  assert.ok(generic.ok, "the generic Board accepts the complete snapshot checksum");
  assert.equal(generic.state.assets[0]?.contentHash, "0".repeat(64));
  const guarded = await readCheckArtifacts(root);

  assert.ok(!guarded.ok && guarded.code === "check_artifact_corrupt", "an invalid feedback or recipe hash cannot silently disappear");
});
