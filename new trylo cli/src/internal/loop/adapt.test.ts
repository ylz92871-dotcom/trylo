import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterClassOf, classifyProviderEvent } from "./adapt.js";

test("timeout process_exit and sent_unacked are distinct classes", () => {
  const timeout = classifyProviderEvent({ type: "error", class: "timeout", retryable: false, phase: "before_headers", message: "timeout" }, "e1");
  const exitUnsent = classifyProviderEvent({ type: "error", class: "network", retryable: false, phase: "before_headers", message: "process_exit" }, "e2");
  const unacked = classifyProviderEvent({ type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "sent_unacked" }, "e3");

  assert.equal(timeout?.type, "transport_fail");
  assert.equal(timeout && adapterClassOf(timeout), "timeout");
  assert.equal(exitUnsent?.type, "transport_fail");
  assert.equal(exitUnsent && adapterClassOf(exitUnsent), "process_exit");
  assert.equal(unacked?.type, "transport_unknown");
  assert.equal(unacked && adapterClassOf(unacked), "sent_unacked");
  assert.notEqual(timeout && adapterClassOf(timeout), unacked && adapterClassOf(unacked));
});

test("a classified provider error keeps its own detail (P0-6: http status must survive)", () => {
  const invalid = classifyProviderEvent({ type: "error", class: "invalid_request", retryable: false, phase: "before_headers", message: "http_400" }, "e4");

  assert.equal(invalid?.type, "transport_fail");

  if (invalid?.type !== "transport_fail") throw new Error("expected transport_fail");

  // The head of the diagnosis survives; the class still travels separately.
  assert.equal(invalid.message, "http_400");
  assert.equal(invalid.errorClass, "invalid_request");
  // …and classification follows the stable class, not the detail text.
  assert.equal(adapterClassOf(invalid), "invalid_request");
  const authed = classifyProviderEvent({ type: "error", class: "auth", retryable: false, phase: "before_headers", message: "http_401" }, "e5");
  if (authed?.type !== "transport_fail") throw new Error("expected transport_fail");

  assert.equal(authed.message, "http_401");
  assert.equal(adapterClassOf(authed), "auth");
});

test("an empty provider message still falls back to the bare class", () => {
  const bare = classifyProviderEvent({ type: "error", class: "rate_limit", retryable: true, phase: "before_headers", message: "" }, "e6");
  if (bare?.type !== "transport_fail") throw new Error("expected transport_fail");
  assert.equal(bare.message, "rate_limit");
  assert.equal(adapterClassOf(bare), "rate_limit");
});
