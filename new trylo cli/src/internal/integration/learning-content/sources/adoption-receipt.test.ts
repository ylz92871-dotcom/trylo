import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPort, SessionRecord } from "../../../ports/session.js";
import { emptyBoardState } from "../../../learning/control/state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { recordContentContextDelivery } from "./adoption-receipt.js";
import { projectContentAdoptions } from "./adoption.js";

test("real accepted context delivery uses the sole session writer and replays as display only", async () => {
  const records: SessionRecord[] = [];
  const session: Pick<SessionPort, "append"> = { async append(record) {
    records.push({ formatVersion: "1", sequence: records.length, ...record });
    return { ok: true, sequence: records.length - 1 };
  } };
  const receipt = await recordContentContextDelivery({ session, sessionId: "session", turnId: "turn", attemptId: "attempt",
    refs: [{ contentFactId: "content-fact", processId: "process", questionRefs: ["question"], answerRefs: ["answer"] }],
    materialHash: contentHashOf("frozen actual request material"), now: () => 0 });

  assert.equal(receipt.status, "recorded");
  assert.equal(records[0]!.type, "execution_extension");
  const metadata = records[0]!.payload;

  assert.equal(metadata.owner, "learning-content");
  const mapping = { ref: "content-fact", version: "process", domain: "prompt" as const, subsystem: "method" as const,
    issueIds: ["issue"], topicIds: ["topic"], contentFactIds: ["content-fact"], sourceRefs: ["content-fact"] };
  const replay = projectContentAdoptions({ board: emptyBoardState(), scope: "scope", sessionId: "session",
    records: [records[0]!, { ...records[0]!, sequence: 1 }], bindings: [], artifacts: [mapping] });

  assert.equal(replay.adoptions.length, 1, "duplicate immutable delivery is not a second adoption");
  assert.equal(replay.adoptions[0]!.exposure, "displayed");
  assert.equal(replay.adoptions[0]!.toolUnitId, undefined);
  assert.ok(replay.adoptions[0]!.details.includes("not_proof_of_benefit"));
});

test("asset-only context works and unknown append never becomes a successful receipt", async () => {
  let written = 0;
  const input = { session: { async append() {
    written++;
    throw new Error("write outcome unknown");
  } },
    sessionId: "session", turnId: "turn", attemptId: "attempt", refs: [], artifactRefs: [{ ref: "version", version: "version" }],
    materialHash: contentHashOf("material"), now: () => 0 };

  assert.deepEqual(await recordContentContextDelivery(input), { status: "unconfirmed", reason: "content_delivery_append_unconfirmed" });
  assert.equal(written, 1);
  assert.deepEqual(await recordContentContextDelivery({ ...input, artifactRefs: [] }), { status: "rejected", reason: "content_delivery_invalid" });
  assert.equal(written, 1);
});
