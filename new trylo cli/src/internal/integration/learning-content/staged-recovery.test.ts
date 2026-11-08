import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { contentStageRecords } from "./staged-records.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";

const at = "2026-11-04T16:00:00Z", scope = "repo:stage-recovery";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function clean(root: string) {
  const absolute = resolve(root);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith("trylo-content-stage-recovery-"));
  await rm(absolute, { recursive: true, force: true });
}

async function start(root: string, sessionId: string, turnId: string) {
  const session = createNdjsonSessionStore({ path: join(root, `${sessionId}.ndjson`) });
  assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-contract",
    model: "stage-recovery-contract", toolCatalogHash: "catalog", workspaceId: "workspace:stage-recovery" } })).ok);
  assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at,
    payload: { kind: "user", sequence: 0, text: "Use the original identified request and complete its supported learning review." } })).ok);
  return session;
}

test("two real begins with empty before snapshots cannot create two roots when the later preparation observes the first saved prefix", { timeout: 10000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-stage-recovery-")), sessionId = "race-session", turnId = "race-turn";
  const session = await start(root, sessionId, turnId), boardRoot = join(root, "board");
  const bothEntered = gate(), firstSaved = gate();

  try {
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId, turnId, enabled: () => true, now: () => Date.parse(at) };
    const actualA = createNormalTaskContentRuntime(options), actualB = createNormalTaskContentRuntime(options);
    const observedPrefixes: number[] = [];
    const first = createStagedContentSession({ enabled: options.enabled, runtime: { ...actualA, async prepare(input, signal) {
      await bothEntered.promise;
      const prepared = await actualA.prepare(input, signal);
      assert.ok(prepared.ok);
      observedPrefixes.push(prepared.value.packet.boardSequence);
      return prepared;
    } } });
    const second = createStagedContentSession({ enabled: options.enabled, runtime: { ...actualB, async prepare(input, signal) {
      bothEntered.release();
      await firstSaved.promise;
      const prepared = await actualB.prepare(input, signal);
      assert.ok(prepared.ok);
      observedPrefixes.push(prepared.value.packet.boardSequence);
      return prepared;
    } } });
    const firstBegin = first.begin({ requestId: "same-normal-request", maximumPromptChars: 100000 }, context.signal);
    const secondBegin = second.begin({ requestId: "same-normal-request", maximumPromptChars: 100000 }, context.signal);
    const winner = await firstBegin;
    assert.equal(winner.status, "apply_known");
    firstSaved.release();
    const loser = await secondBegin;
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    const roots = contentStageRecords(loaded.state.rewardV2Facts ?? [], scope, loaded.state.sequence).filter(row => row.body.kind === "prepared"
      && row.body.sessionId === sessionId && row.body.turnId === turnId && row.body.requestId === "same-normal-request" && row.body.extendsStageRef === undefined);

    assert.deepEqual(observedPrefixes, [0, 1], "both before snapshots were empty, but B's real prepare must observe A's saved Board prefix");
    assert.deepEqual([loser.status, roots.length], ["stale", 1], "a second before-empty begin cannot mint a new root after another root was saved");
  } finally {
    bothEntered.release();
    firstSaved.release();
    await session.release();
    await clean(root);
  }
});

test("foreign session and turn cannot read or apply another stage while the original identity still recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-stage-recovery-")), boardRoot = join(root, "board");
  const session = await start(root, "owner-session", "owner-turn"), foreignSession = await start(root, "other-session", "other-turn");

  try {
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId: "owner-session", turnId: "owner-turn",
      enabled: () => true, now: () => Date.parse(at) };
    const original = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const begun = await original.begin({ requestId: "owner-request", maximumPromptChars: 100000 }, new AbortController().signal);

    assert.equal(begun.status, "apply_known");
    if (begun.status !== "apply_known") assert.fail("owner stage was not created");

    const packet = (JSON.parse(begun.request.materialJson) as { readonly packet: ContentPacket }).packet;
    const sourceRef = packet.records.find(row => row.origin === "user_statement")?.ref;
    assert.ok(sourceRef);
    assert.ok((await session.append({ type: "transcript_item", sessionId: options.sessionId, turnId: "other-turn", at,
      payload: { kind: "user", sequence: 0, text: "A separate task in the same session." } })).ok);
    const outsiders = [
      createStagedContentSession({ runtime: createNormalTaskContentRuntime({ ...options, session: foreignSession, sessionId: "other-session", turnId: "other-turn" }), enabled: options.enabled }),
      createStagedContentSession({ runtime: createNormalTaskContentRuntime({ ...options, turnId: "other-turn" }), enabled: options.enabled }),
    ];
    const applicationJson = JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [], preparations: [] });
    const results = await Promise.all(outsiders.map(async staged => {
      const applied = await staged.applyKnown({ stageRef: begun.stageRef, inputHash: begun.request.inputHash, applicationJson }, new AbortController().signal);
      const page = await staged.readMaterial({ stageRef: begun.stageRef, evidenceRef: sourceRef }, new AbortController().signal);
      return [applied.status, page.ok] as const;
    }));

    assert.deepEqual(results, [["rejected", false], ["rejected", false]], "a stage reference is not authority to cross a session or task owner");
    const restored = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const recovered = await restored.begin({ requestId: "owner-request", maximumPromptChars: 100000 }, new AbortController().signal);

    assert.equal(recovered.status, "apply_known");
    if (recovered.status !== "apply_known") assert.fail("owner recovery changed its phase");

    assert.equal(recovered.stageRef, begun.stageRef);
    assert.equal(recovered.request.inputHash, begun.request.inputHash);
  } finally {
    await session.release();
    await foreignSession.release();
    await clean(root);
  }
});
