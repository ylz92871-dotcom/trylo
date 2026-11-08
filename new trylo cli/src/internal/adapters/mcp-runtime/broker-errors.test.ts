import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerRequestError, McpBrokerTransportError } from "./broker-errors.js";

function fetchFailure(code: string, syscall: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("native connection error"), { code, syscall }) });
}

for (const [code, syscall] of [["ECONNREFUSED", "connect"], ["ENETUNREACH", "connect"], ["ENOTFOUND", "getaddrinfo"]] as const) {
  test(`broker ${code} during ${syscall} proves the operation was not dispatched`, () => {
    const cause = fetchFailure(code, syscall);
    const error = brokerRequestError(cause);
    assert.ok(error instanceof McpBrokerTransportError);
    assert.equal(error.delivery, "not_dispatched");
    assert.equal(error.code, "mcp_broker_unavailable");
    assert.equal(error.connectionCode, code);
    assert.equal(error.cause, cause);
    assert.match(error.message, /did not execute/u);
    assert.match(error.message, /Reconnect/u);
  });
}

test("broker delivery stays unknown without both native connection code and phase", () => {
  const failures: unknown[] = [
    new TypeError("fetch failed: ECONNREFUSED connect"),
    new TypeError("fetch failed", { cause: Object.assign(new Error("code only"), { code: "ECONNREFUSED" }) }),
    fetchFailure("ECONNREFUSED", "write"),
    fetchFailure("ECONNRESET", "connect"),
    fetchFailure("ECONNRESET", "read"),
    fetchFailure("ETIMEDOUT", "connect"),
    fetchFailure("UND_ERR_CONNECT_TIMEOUT", "connect"),
    new TypeError("fetch failed", { cause: { code: "ECONNREFUSED", syscall: "connect" } }),
    new TypeError("fetch failed", { cause: new AggregateError([fetchFailure("ECONNREFUSED", "connect"), fetchFailure("ECONNRESET", "read")]) }),
  ];
  for (const failure of failures) {
    const error = brokerRequestError(failure);
    assert.equal(error.delivery, "unknown");
    assert.equal(error.code, "mcp_broker_delivery_unknown");
    assert.equal(error.cause, failure);
    assert.match(error.message, /may have executed/u);
    assert.match(error.message, /do not repeat/u);
  }
});

test("broker transport errors retain their trusted delivery identity across wrappers", () => {
  const original = brokerRequestError(fetchFailure("ECONNREFUSED", "connect"));
  assert.equal(brokerRequestError(original), original);
});
