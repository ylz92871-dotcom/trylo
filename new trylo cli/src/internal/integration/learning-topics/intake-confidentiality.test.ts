import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createPersistentTopicIntake } from "./intake.js";
import { topicDomainCandidates } from "./domain-candidates.js";

const scope = "intake-confidentiality", algorithmVersion = "intake-confidentiality-v1";
// Invented literal deliberately has no generic credential shape: only the host knows it is sensitive.
const TEST_SECRET = "fixture-value-Q7m2V8n4";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-intake-confidentiality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function input(question = "Which input condition should influence the next read choice?", otherText = "The next input has not been checked.") {
  const quoted = "read_file reported failure for the bounded input.";
  const window = { schemaVersion: 1, domain: "prompt", scope, boardSequence: 0,
    watermarks: [{ runId: "execution:local-fixture", throughSequence: 2 }], records: [
      { ref: "quoted-source", runId: "execution:local-fixture", sequence: 1, scope, origin: "execution_result", text: quoted },
      { ref: "uncited-source", runId: "execution:local-fixture", sequence: 2, scope, origin: "user_statement", text: otherText },
    ] };
  const proposal = { schemaVersion: 2, question, whenRelevant: "When choosing a later bounded read",
    expectedChange: "Use the observed condition before changing the reader", citations: [{ evidenceRef: "quoted-source", quote: quoted }] };

  return { proposal, window, proposalJson: JSON.stringify(proposal), windowJson: JSON.stringify(window) };
}

function generatorDraft(proposal: ReturnType<typeof input>["proposal"]) {
  const { question, whenRelevant, expectedChange, citations } = proposal;
  return { kind: "topic" as const, question, whenRelevant, expectedChange, citations };
}

function intake(boardRoot: string, secrets: readonly string[] = [], enabled = true) {
  return createPersistentTopicIntake({ boardRoot, scope, domain: "prompt", algorithmVersion, enabled: () => enabled, ...{ secrets } });
}

async function assertEmptyBoard(boardRoot: string): Promise<void> {
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.state.sequence, 0);
  assert.equal(loaded.state.rewardV2Facts?.length ?? 0, 0);
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.jobs.length, 0);
}

test("host-known sensitive literals are rejected in free questions, escaped JSON and uncited window text before any Board fact", async t => {
  const root = await temporary(t), boardRoot = path.join(root, "board"), port = intake(boardRoot, [TEST_SECRET]);
  const literal = input(`Which condition applies to ${TEST_SECRET}?`);
  const encodedSecret = [...TEST_SECRET].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const escapedProposal = literal.proposalJson.replace(TEST_SECRET, encodedSecret);
  const escapedDraft = JSON.stringify(generatorDraft(literal.proposal)).replace(TEST_SECRET, encodedSecret);

  assert.equal(escapedProposal.includes(TEST_SECRET), false);
  assert.equal(JSON.parse(escapedProposal).question, literal.proposal.question);
  assert.equal(escapedDraft.includes(TEST_SECRET), false);
  assert.equal(JSON.parse(escapedDraft).question, literal.proposal.question);
  const uncited = input(undefined, `The unrelated note contains ${TEST_SECRET}.`);

  for (const [proposalJson, windowJson] of [
    [literal.proposalJson, literal.windowJson], [escapedProposal, literal.windowJson], [uncited.proposalJson, uncited.windowJson],
    [escapedDraft, literal.windowJson],
  ]) {
    assert.deepEqual(await port.ingest(proposalJson!, windowJson!), { status: "rejected", reason: "topic_sensitive_content" });
    assert.equal(port.inspect().suspended, false);
    await assertEmptyBoard(boardRoot);
  }

  assert.deepEqual(await port.ingest(JSON.stringify({ kind: "no_topic", reason: `No question about ${TEST_SECRET}` }), literal.windowJson),
    { status: "rejected", reason: "topic_sensitive_content" });
  await assertEmptyBoard(boardRoot);
});

test("existing generic absolute-path and credential-shape rules reject both proposal and uncited evidence without host secrets", async t => {
  const root = await temporary(t), boardRoot = path.join(root, "board"), port = intake(boardRoot);
  const windowsPath = input("Which condition applies at D:\\intake-fixture\\private.txt?");
  const posixPath = input(undefined, "The local note mentions /home/intake-fixture/private.txt.");
  const credential = input();
  credential.proposal.whenRelevant = "When token=fixture-shape-value is supplied";

  for (const candidate of [windowsPath, posixPath, credential]) {
    assert.deepEqual(await port.ingest(JSON.stringify(candidate.proposal), candidate.windowJson),
      { status: "rejected", reason: "topic_sensitive_content" });
    await assertEmptyBoard(boardRoot);
  }
});

test("safe generator drafts persist unchanged and reconstruct with the same citations, canonical identity and deduplication", async t => {
  const root = await temporary(t), boardRoot = path.join(root, "board"), original = input();
  const experiment = { ref: "prompt.existing-observation", version: "1", domain: "prompt", purpose: "Observe a current permitted input condition" };
  const window = { ...original.window, experiments: [experiment] }, draft = { ...generatorDraft(original.proposal), experimentRef: experiment.ref };
  const proposalJson = JSON.stringify(draft), windowJson = JSON.stringify(window);
  const parsed = readTopicSubmission(proposalJson, windowJson);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;

  assert.equal(parsed.value.kind, "topic");
  if (parsed.value.kind !== "topic") return;

  const legacy = readTopicSubmission(JSON.stringify({ ...original.proposal, schemaVersion: 3, experimentRef: experiment.ref }), windowJson);

  assert.ok(legacy.ok);
  if (!legacy.ok) return;

  assert.equal(legacy.value.kind, "topic");
  if (legacy.value.kind !== "topic") return;

  assert.deepEqual(parsed.value.topic, legacy.value.topic, "versionless adaptation preserves the existing grounded topic/citation identity");
  const result = await intake(boardRoot, [TEST_SECRET]).ingest(proposalJson, windowJson);

  assert.equal(result.status, "persisted", JSON.stringify(result));
  if (result.status !== "persisted") return;

  assert.deepEqual(result.topic, parsed.value.topic);
  assert.equal(result.revision, 1);
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.state.rewardV2Facts?.length, 1);
  const fact = loaded.state.rewardV2Facts![0]!, expectedPayload = canonicalJson({ schemaVersion: 1, type: "ws1_topic_candidate",
    proposal: draft, evidenceWindow: window });

  assert.equal(fact.payloadJson, expectedPayload);
  assert.equal(fact.id, `ws1:${contentHashOf({ scope, algorithmVersion, payloadJson: expectedPayload })}`);
  const saved = JSON.parse(fact.payloadJson);

  assert.deepEqual(saved.proposal, draft);
  assert.equal(saved.proposal.kind, "topic");
  assert.equal(Object.hasOwn(saved.proposal, "schemaVersion"), false);
  assert.deepEqual(saved.evidenceWindow, window);
  assert.equal(saved.evidenceWindow.experiments[0].ref, experiment.ref);
  const replayed = readTopicSubmission(JSON.stringify(JSON.parse(fact.payloadJson).proposal), JSON.stringify(JSON.parse(fact.payloadJson).evidenceWindow));

  assert.ok(replayed.ok);
  if (!replayed.ok) return;

  assert.equal(replayed.value.kind, "topic");
  if (replayed.value.kind !== "topic") return;

  assert.deepEqual(replayed.value.topic, result.topic);
  const restarted = intake(boardRoot, [TEST_SECRET]);
  const retried = await restarted.ingest(JSON.stringify(draft, null, 2), JSON.stringify(window, null, 2));

  assert.equal(retried.status, "persisted", JSON.stringify(retried));
  if (retried.status !== "persisted") return;

  assert.equal(retried.idempotent, true);
  assert.equal(retried.revision, 1);
  assert.deepEqual(retried.topic, result.topic);
  const reread = await createBoardReader(boardRoot).load();
  assert.ok(reread.ok, JSON.stringify(reread));
  assert.equal(reread.state.sequence, 1);
  assert.deepEqual(reread.state.rewardV2Facts, loaded.state.rewardV2Facts);
  const candidates = topicDomainCandidates(reread.state.rewardV2Facts ?? [], scope, "prompt", reread.state.sequence);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.topic, result.topic);
  assert.equal(candidates[0]!.proposalJson, canonicalJson(draft));
  assert.equal(candidates[0]!.windowJson, canonicalJson(window));
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.jobs.length, 0);
  const disabledRoot = path.join(root, "disabled-board"), disabled = intake(disabledRoot, [TEST_SECRET], false);

  assert.deepEqual(await disabled.ingest(`not JSON ${TEST_SECRET}`, "not JSON"), { status: "disabled" });
  await assert.rejects(access(disabledRoot));
});
