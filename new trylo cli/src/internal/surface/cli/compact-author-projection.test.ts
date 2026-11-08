import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { createStreamTranslator, projectEnvelopeSequence } from "./stream-projection.js";

function envelope(kind: string, payload: JsonObject, sequence: number): Envelope {
  return { protocolVersion: "0.0", eventId: `compact-author-${sequence}`, sequence,
    timestamp: "2026-11-08T00:00:00.000Z", kind, payload, producerId: "fixture", producerSequence: sequence };
}

test("a model author is not a failed or completed window before the real compact event", () => {
  const translator = createStreamTranslator();

  assert.deepEqual(translator.push(envelope("observation", { component: "compaction", status: "started", tokensBefore: 1_200 }, 1)),
    [{ type: "compact", status: "started", reason: "auto", tokensBefore: 1_200 }]);
  assert.deepEqual(translator.push(envelope("observation", { component: "compaction", author: "model", summary: "BODY_MUST_NOT_REACH_CLI" }, 2)), []);
  const completed = translator.push(envelope("compact", { tokensBefore: 1_200, tokensAfter: 400 }, 3));

  assert.deepEqual(completed, [{ type: "compact", status: "completed", reason: "auto", tokensBefore: 1_200, tokensAfter: 400,
    summaryAuthor: { author: "model" } }]);
  assert.equal(JSON.stringify(completed).includes("BODY_MUST_NOT_REACH_CLI"), false);
});

test("a successful extractive fallback exposes its actual author without claiming a window failure", () => {
  const translator = createStreamTranslator();
  assert.deepEqual(translator.push(envelope("observation", { component: "compaction", author: "extractive", reason: "provider_error", degraded: true }, 1)), []);
  assert.deepEqual(translator.push(envelope("compact", {}, 2)), [{ type: "compact", status: "completed", reason: "auto",
    summaryAuthor: { author: "extractive", reason: "provider_error" } }]);
});

test("a cancelled author remains attached to the real cancellation rather than creating a second failure", () => {
  const events = projectEnvelopeSequence([
    envelope("observation", { component: "compaction", author: "extractive", reason: "cancelled", degraded: true }, 1),
    envelope("observation", { component: "compaction", reason: "cancelled", degraded: true }, 2),
  ]);
  assert.deepEqual(events, [{ type: "compact", status: "failed", reason: "cancelled",
    summaryAuthor: { author: "extractive", reason: "cancelled" } }]);
});

test("a new compaction start clears an older uncommitted author selection", () => {
  const translator = createStreamTranslator();
  translator.push(envelope("observation", { component: "compaction", author: "model" }, 1));
  translator.push(envelope("observation", { component: "compaction", status: "started" }, 2));
  assert.deepEqual(translator.push(envelope("compact", {}, 3)), [{ type: "compact", status: "completed", reason: "auto" }]);
});

test("unknown authors and reasons are not accepted as reports or turned into window failures", () => {
  for (const payload of [
    { component: "compaction", author: "foreign_author" },
    { component: "compaction", author: "model", reason: "foreign_reason" },
    { component: "compaction", author: 7 },
  ]) {
    const translator = createStreamTranslator();
    assert.deepEqual(translator.push(envelope("observation", payload, 1)), []);
    assert.deepEqual(translator.push(envelope("compact", {}, 2)), [{ type: "compact", status: "completed", reason: "auto" }]);
  }
});

test("an invalid author cannot hide a real degradation carried by the same observation", () => {
  const events = projectEnvelopeSequence([
    envelope("observation", { component: "compaction", author: "foreign_author", reason: "summary_unsafe", degraded: true }, 1),
  ]);
  assert.deepEqual(events, [{ type: "compact", status: "failed", reason: "summary_unsafe" }]);
});

test("legacy compaction events without author reports keep their exact JSON shape", () => {
  const events = projectEnvelopeSequence([
    envelope("observation", { component: "compaction", status: "started", tokensBefore: 90 }, 1),
    envelope("compact", { tokensBefore: 90, tokensAfter: 20 }, 2),
    envelope("observation", { component: "compaction", degraded: true, reason: "summary_unsafe" }, 3),
  ]);
  assert.equal(JSON.stringify(events), JSON.stringify([
    { type: "compact", status: "started", reason: "auto", tokensBefore: 90 },
    { type: "compact", status: "completed", reason: "auto", tokensBefore: 90, tokensAfter: 20 },
    { type: "compact", status: "failed", reason: "summary_unsafe" },
  ]));
});

test("batch and incremental projections attach each author to only its actual window result", () => {
  const envelopes = [
    envelope("observation", { component: "compaction", status: "started" }, 1),
    envelope("observation", { component: "compaction", author: "model" }, 2),
    envelope("compact", {}, 3),
    envelope("observation", { component: "compaction", status: "started" }, 4),
    envelope("observation", { component: "compaction", author: "extractive", reason: "summary_unsafe", degraded: true }, 5),
    envelope("compact", {}, 6),
  ];
  const translator = createStreamTranslator();
  const incremental = envelopes.flatMap(item => translator.push(item));

  incremental.push(...translator.finish());
  assert.deepEqual(incremental, projectEnvelopeSequence(envelopes));
  assert.equal(incremental.filter(event => event.type === "compact" && event.status === "failed").length, 0);
});
