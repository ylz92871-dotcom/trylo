import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterClassOf, classifyProviderEvent } from "./adapt.js";

for (const phase of ["before_headers", "after_stream_started"] as const) test(`quota diagnostics survive ${phase} without changing delivery uncertainty`, () => {
  const message = "quota_exceeded; window=5-hour; reset_at=2026-10-25T23:20:06+08:00";
  const result = classifyProviderEvent({ type: "error", class: "quota", retryable: false, phase, message }, "quota-event");
  assert.equal(result?.type, phase === "before_headers" ? "transport_fail" : "transport_unknown");
  if (result?.type !== "transport_fail" && result?.type !== "transport_unknown") throw new Error("expected transport failure");
  assert.equal(result.message, message); assert.equal(result.errorClass, "quota");
  if (phase === "after_stream_started") assert.equal(adapterClassOf(result), "sent_unacked");
});

test("other mid-stream diagnostics keep their existing privacy and uncertainty boundary", () => {
  const result = classifyProviderEvent({ type: "error", class: "server", retryable: false,
    phase: "after_stream_started", message: "PRIVATE-UNCLASSIFIED-DIAGNOSTIC" }, "server-event");
  assert.equal(result?.type, "transport_unknown");
  if (result?.type !== "transport_unknown") throw new Error("expected unknown delivery");
  assert.equal(result.message, "mid_stream:server");
});
