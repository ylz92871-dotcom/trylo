import assert from "node:assert/strict";
import test from "node:test";
import { centralRuntimeFailure, centralRuntimeFailureError, isCentralRuntimeFailure, markCentralRuntimeFailure } from "./failure-contract.js";

test("failure projection accepts exact own code, reason or message and never promotes text fragments", () => {
  const expected = { stage: "drive", code: "organization_sensitive_content" };

  for (const error of [{ code: "organization_sensitive_content" }, { reason: "organization_sensitive_content" }, new Error("organization_sensitive_content")]) {
    assert.deepEqual(centralRuntimeFailure(error, "drive"), expected);
  }

  assert.deepEqual(centralRuntimeFailure({ reason: "learning_budget_binding" }, "metadata"), { stage: "metadata", code: "learning_budget_binding" });

  for (const error of [null, "organization_sensitive_content", new Error("organization_sensitive_content: fixture-secret"),
    { code: "organization_sensitive_content fixture-secret", message: "fixture-secret:/private/home" },
    { code: "future_arbitrary_code", cause: new Error("organization_sensitive_content"), stack: "organization_sensitive_content fixture-secret" }]) {
    const failure = centralRuntimeFailure(error, "drive");
    assert.deepEqual(failure, { stage: "drive", code: "unclassified" });
    assert.equal(JSON.stringify(failure).includes("fixture-secret"), false);
  }
});

test("failure projection never invokes inherited fields, accessors, coercion or a throwing proxy", () => {
  let invoked = 0;
  const forbidden = () => {
    invoked++;
    throw new Error("fixture-secret");
  };
  const accessor = Object.defineProperties({}, Object.fromEntries(["code", "reason", "message", "name", "stack", "cause", "toJSON", "toString"]
    .map(key => [key, { get: forbidden }])));

  for (const error of [accessor, Object.create({ reason: "organization_sensitive_content" }),
    new Proxy({}, { getOwnPropertyDescriptor: forbidden })]) {
    assert.deepEqual(centralRuntimeFailure(error, "initialization"), { stage: "initialization", code: "unclassified" });
  }

  assert.equal(invoked, 1, "only the proxy descriptor trap runs; no exception getter or coercion executes");
  assert.equal(isCentralRuntimeFailure(Object.defineProperties({}, { stage: { value: "drive" }, code: { get: forbidden } })), false);
  assert.equal(invoked, 1);
});

test("thread-local marks retain the first cause and stage without mutating a frozen original exception", () => {
  const original = Object.freeze(new Error("organization_sensitive_content")), before = Object.getOwnPropertyDescriptors(original);

  assert.equal(markCentralRuntimeFailure(original, "initialization"), original);
  assert.equal(markCentralRuntimeFailure(original, "drive"), original);
  assert.deepEqual(centralRuntimeFailure(original, "transport"), { stage: "initialization", code: "organization_sensitive_content" });
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), before);
  const cleanup = Object.freeze(new AggregateError([original, new Error("fixture-secret")], "runtime_initialization_cleanup_failed"));

  assert.equal(markCentralRuntimeFailure(cleanup, "metadata", original), cleanup);
  assert.deepEqual(centralRuntimeFailure(cleanup, "persistence"), { stage: "initialization", code: "organization_sensitive_content" });
  assert.deepEqual(centralRuntimeFailure(markCentralRuntimeFailure("fixture-secret", "metadata"), "drive"), { stage: "metadata", code: "unclassified" });
});

test("IPC failure guard and reconstruction accept only a canonical two-field payload and copy its safe values", () => {
  const payload = { stage: "drive", code: "organization_sensitive_content" };

  assert.ok(isCentralRuntimeFailure(payload));
  assert.ok(isCentralRuntimeFailure({ stage: "persistence", code: "unclassified" }));
  const restored = centralRuntimeFailureError("runtime_worker_drive_failed", payload, "transport");

  assert.ok(Reflect.set(payload, "code", "fixture-secret"));
  assert.equal(restored.message, "runtime_worker_drive_failed");
  assert.deepEqual(centralRuntimeFailure(restored, "persistence"), { stage: "drive", code: "organization_sensitive_content" });

  for (const invalid of [{ stage: "future", code: "organization_sensitive_content" }, { stage: "drive", code: "fixture-secret" },
    { stage: "drive" }, { stage: "drive", code: "organization_sensitive_content", message: "fixture-secret" },
    { stage: "drive", code: "organization_sensitive_content", [Symbol("private")]: "fixture-secret" }]) {
    assert.equal(isCentralRuntimeFailure(invalid), false);
    const failure = centralRuntimeFailure(centralRuntimeFailureError("runtime_worker_drive_failed", invalid, "transport"), "drive");
    assert.deepEqual(failure, { stage: "transport", code: "unclassified" });
  }
});
