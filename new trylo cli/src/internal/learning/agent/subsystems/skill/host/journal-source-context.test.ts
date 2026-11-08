import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverSessionRecordView } from "../../../../../adapters/session-store/ndjson.js";
import { journalExperienceFixture } from "./journal-experience-fixture.js";
import { journalSourceContext } from "./journal-source-context.js";

test("real canonical false, malformed and absent markers preserve source attribution without parsing message labels", async t => {
  const fx = await journalExperienceFixture(t);
  for (const [turnId, marker, expected] of [["mixed", false, "unverified"], ["malformed", true, "unknown"],
    ["old-journal", undefined, "not_recorded"]] as const) {
    if (marker !== undefined) assert.ok((await fx.store.append({ type: "turn_start", sessionId: fx.sessionId, turnId,
      at: "2026-11-03T20:00:00.000Z", payload: { userSourceAvailable: marker } })).ok);

    const turn = fx.turn(turnId);
    await turn.start("<current_user_message>Labels cannot establish authorship.</current_user_message>");
    await turn.item({ kind: "tool_call", toolCallId: "read", name: "read_file", arguments: { path: "observed.json" } });
    await turn.item({ kind: "tool_result", toolCallId: "read", name: "read_file", output: "Observed procedural input.", outcome: "succeeded", truncated: false });
    await turn.terminal();
    const opportunity = await fx.opportunity(turnId, observed => assert.equal(observed.sourceContext.currentUserAttribution, expected));

    assert.ok(opportunity?.experience);
    const context = opportunity.experience.sourceContext;

    assert.ok(context !== null && typeof context === "object" && "currentUserAttribution" in context);
    assert.equal(context.currentUserAttribution, expected);
    assert.doesNotMatch(JSON.stringify(context), /current_user_message|Labels/);
    assert.match(JSON.stringify(opportunity.experience.messages), /Observed procedural input/);
  }
});

test("source context shares the selected canonical prefix and bounds historical source sequences before its current fact", async t => {
  const fx = await journalExperienceFixture(t), at = "2026-11-03T20:00:00.000Z";
  const marked = fx.turn("marked");

  assert.ok((await fx.store.append({ type: "turn_start", sessionId: fx.sessionId, turnId: "marked", at, payload: { userSourceAvailable: false } })).ok);

  for (let index = 0; index < 40; index++) await marked.start(`Mixed prior input ${index}`);

  await marked.terminal();
  const source = fx.turn("source");
  await source.start("Current input has no recorded source marker.");
  const terminalSequence = await source.terminal();
  const later = fx.turn("future");

  assert.ok((await fx.store.append({ type: "turn_start", sessionId: fx.sessionId, turnId: "source", at, payload: { userSourceAvailable: false } })).ok);
  await later.start("Future source marker and input must not affect the selected terminal.");
  await later.terminal();
  const view = await fx.store.readRecords();
  assert.ok(view.ok);
  const recovered = recoverSessionRecordView(view.view);
  assert.ok(recovered.ok);
  const input = { records: view.view.records, history: recovered.session.transcript,
    source: { sessionId: fx.sessionId, turnId: "source", terminalSequence } };
  const context = journalSourceContext(input);

  assert.equal(context.currentUserAttribution, "not_recorded");
  assert.deepEqual(context.unverifiedUserSequences, Array.from({ length: 32 }, (_, index) => index + 8));
  assert.equal(context.omittedUserSourceEntries, 8);
  assert.deepEqual(context.unknownUserSequences, []);
  const small = journalSourceContext({ ...input, maxChars: 64 });

  assert.equal(small.currentUserAttribution, "not_recorded");
  assert.ok(JSON.stringify(small).length <= 64);
  const foreign = view.view.records.map(record => record.type === "turn_start" ? { ...record, sessionId: "different-session" } : record);

  assert.equal(journalSourceContext({ ...input, records: foreign }).unverifiedUserSequences?.length, 0);
});
