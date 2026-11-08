import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { buildContentPacket } from "../../learning/central/content/material.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import { buildContentRecord } from "./records.js";
import { createAutomaticBoardContentSource } from "./sources/board.js";
import { selectContentFeedbackMaterial } from "./sources/feedback-paging.js";
import { readSessionContent, sessionContentAddress, sessionContentRecordRef } from "./sources/session.js";
import { createTaskSourcePageReader } from "./task-source-pages.js";

const scope = "repo:a", signal = new AbortController().signal;

async function sources() {
  const userText = "😀Original user input; complete text stays at the source.";
  const session = await readSessionContent({ scope, subsystem: "tool", sessionId: "session", turnId: "turn", enabled: () => true,
    session: { async readRecords() { return { ok: true, view: { tornTail: false, records: [
      { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "session", at: "2026-11-04T12:00:00Z",
        payload: { fingerprint: { schemaVersion: "1", workspaceId: "workspace", model: "local", providerId: "local", toolCatalogHash: "tools" } } },
      { formatVersion: "1", sequence: 1, type: "turn_input", sessionId: "session", turnId: "turn", at: "2026-11-04T12:00:00Z", payload: { text: userText } },
    ] } }; } } }, signal);

  assert.ok(session.ok);
  const packet = buildContentPacket({ scope, domain: "tool", boardSequence: 0, records: [
    { ref: "archived-user-source", runId: "original-remote-session", sequence: 17, scope, origin: "user_statement", text: "Original archived user requirement." },
  ], materials: [], requirements: [], answers: [] });
  assert.ok(packet.ok);
  const output = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [{ id: "known",
    statement: "A recorded conditional answer.", conditions: "Only the original requirement and support.",
    citations: [{ evidenceRef: "archived-user-source", quote: "Original archived user requirement." }] }], applications: [], relations: [], preparations: [] }),
    JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "undetermined", reason: "No semantic claim is certified by this page reader.", citations: [] } }));
  assert.ok(output.ok);
  const fact = { ...buildContentRecord(packet.value, output.value), sequence: 1 };
  const board = createAutomaticBoardContentSource({ scope, domain: "tool", taskPurpose: "Inspect source", enabled: () => true,
    board: { async load() { return { ok: true, state: { ...emptyBoardState(), sequence: 1, rewardV2Facts: [fact] }, generation: 0 }; } } });
  const recalled = await board.readTaskReferences(signal);
  assert.ok(recalled.ok);
  const generatedRef = recalled.value.batch.records.find(record => record.ref.startsWith("content-answer:"))?.ref;

  assert.ok(generatedRef);
  const feedbackText = "😀Late user feedback with original source identity.";
  const feedback = selectContentFeedbackMaterial({ scope, batches: [{ records: [
    { ref: "feedback-original", runId: "old-feedback-owner", sequence: 9, scope, origin: "user_statement", text: feedbackText },
  ], materials: [], requirements: [], answers: [] }] });

  return { session: session.value.source, board, feedback, userText, feedbackText, generatedRef };
}

test("unified exact pages retain requested aliases, full-source hashes, real origins and original coordinates", async () => {
  const input = await sources(), reader = createTaskSourcePageReader(input);
  const alias = sessionContentAddress({ sessionId: "session", journalSequence: 1 });
  const session = await reader.read(alias, signal, 0, 4);
  assert.ok(session.ok);
  assert.deepEqual(session.value, { ref: alias, originalRef: sessionContentRecordRef("session", 1), origin: "user_statement", originalScope: scope,
    start: 0, end: 4, totalChars: input.userText.length, text: input.userText.slice(0, 4), sourceHash: contentHashOf(input.userText),
    coordinate: { runId: "session", sequence: 1 }, owner: "session" });
  const board = await reader.read("archived-user-source", signal, 1, 8);
  assert.ok(board.ok);
  assert.equal(board.value.owner, "board");
  assert.equal(board.value.origin, "user_statement", "source_record admissibility is not a checker verdict");
  assert.deepEqual(board.value.coordinate, { runId: "original-remote-session", sequence: 17 });
  assert.equal(board.value.sourceHash, contentHashOf("Original archived user requirement."));
  const generated = await reader.read(input.generatedRef, signal, 0, 100);
  assert.ok(generated.ok,
    "the normal recall-advertised public answer must be exactly page-readable, even when omitted from the current packet");
  assert.equal(generated.value.owner, "board");
  assert.equal(generated.value.origin, "model_proposal");
  const feedback = await reader.read("feedback-original", signal, 2, 8);
  assert.ok(feedback.ok);
  assert.equal(feedback.value.owner, "feedback");
  assert.equal(feedback.value.origin, "user_statement");
  assert.equal(feedback.value.sourceHash, contentHashOf(input.feedbackText));
  assert.deepEqual(feedback.value.coordinate, { runId: "old-feedback-owner", sequence: 9 });
  assert.equal(feedback.value.text, input.feedbackText.slice(2, 10));
});

test("only an explicit missing can change source owner; ambiguity, scope and cancellation stay terminal", async () => {
  const input = await sources();
  let laterReads = 0;

  for (const reason of ["content_material_ambiguous", "content_material_scope", "content_material_range_invalid"]) {
    const reader = createTaskSourcePageReader({ session: { async readMaterial() { return { ok: false, reason }; } },
      board: { async readMaterial() {
        laterReads++;
        return { ok: false, reason: "content_material_missing" };
      } }, feedback: input.feedback });
    assert.deepEqual(await reader.read("feedback-original", signal), { ok: false, reason });
  }

  assert.equal(laterReads, 0);
  const controller = new AbortController();
  const cancelled = createTaskSourcePageReader({ session: { async readMaterial() {
    controller.abort();
    return { ok: false, reason: "content_material_missing" };
  } },
    board: { async readMaterial() {
      laterReads++;
      return { ok: false, reason: "content_material_missing" };
    } }, feedback: input.feedback });

  assert.deepEqual(await cancelled.read("feedback-original", controller.signal), { ok: false, reason: "content_material_cancelled" });
  assert.equal(laterReads, 0);
});

test("one-character surrogate budgets and exhausted pages fail explicitly instead of producing a zero-progress successor", async () => {
  const input = await sources(), reader = createTaskSourcePageReader(input);
  assert.deepEqual(await reader.read(sessionContentRecordRef("session", 1), signal, 0, 1), { ok: false, reason: "content_material_range_invalid" });
  assert.deepEqual(await reader.read("feedback-original", signal, 0, 1), { ok: false, reason: "content_feedback_page_invalid" });
  assert.deepEqual(await reader.read("feedback-original", signal, 1, 4), { ok: false, reason: "content_feedback_page_invalid" });
  assert.deepEqual(await reader.read("feedback-original", signal, input.feedbackText.length, 4), { ok: false, reason: "content_material_no_progress" });
});
