import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import type { CliStreamEvent } from "../../protocol/cli-stream.js";
import { projectEnvelopes } from "./projection.js";
import { createStreamTranslator, projectEnvelopeSequence } from "./stream-projection.js";

/**
 * D2: one mapping, two ways to drain it.
 *
 * The claim that makes streaming safe is that an incremental consumer sees the
 * same events in the same order as the batch projection — earlier, not
 * different. So the assertion is equality against the projection that already
 * exists, over a fixture that opens and closes every kind of block.
 */

function envelope(kind: string, payload: JsonObject, sequence: number): Envelope {
  return {
    protocolVersion: "0.0",
    eventId: `e${sequence}`,
    sequence,
    timestamp: "2026-09-17T00:00:00.000Z",
    kind,
    payload,
    producerId: "fixture",
    producerSequence: sequence,
  };
}

function fixtures(): ReadonlyArray<Envelope> {
  return [
    envelope("thinking", { text: "considering", redacted: false }, 1),
    envelope("text", { text: "hello " }, 2),
    envelope("text", { text: "world" }, 3),
    envelope("tool_use", { toolCallId: "t1", name: "run_shell" }, 4),
    envelope("tool_result", { toolCallId: "t1", status: "ok", output: "v22", truncated: false }, 5),
    envelope("text", { text: "done" }, 6),
    envelope("usage", { inputTokens: 3, outputTokens: 4 }, 7),
    envelope("observation", { component: "learning", reason: "board unavailable" }, 8),
    envelope("error", { code: "rate_limit", message: "slow down" }, 9),
    envelope("terminal", { reason: "failed", errorClass: "rate_limit", message: "rate_limit" }, 10),
  ];
}

test("child round answers and cleanup stay visible before the renderer closes", () => {
  const translator = createStreamTranslator();
  const events = [
    ...translator.push(envelope("subagent_spawn", { subagentId: "a", name: "worker", prompt: "完整任务", canReceiveInput: true }, 1)),
    ...translator.push(envelope("subagent_update", { subagentId: "a", status: "waiting", round: 1, result: "完整答复" }, 2)),
    ...translator.push(envelope("terminal", { reason: "completed" }, 3)),
    ...translator.push(envelope("subagent_end", { subagentId: "a", status: "cancelled" }, 4)),
  ];
  assert.deepEqual(events, [
    { type: "subagent", kind: "spawn", id: "a", status: "running", agentType: "worker", prompt: "完整任务", canReceiveInput: true },
    { type: "subagent", kind: "update", id: "a", status: "waiting", round: 1, result: "完整答复" },
    { type: "subagent", kind: "end", id: "a", status: "cancelled" },
  ]);
  assert.deepEqual(translator.push(envelope("text", { text: "late parent bytes" }, 5)), []);
  translator.finish();
  assert.deepEqual(translator.push(envelope("subagent_spawn", { subagentId: "late" }, 6)), []);
});

test("accepted plain-language namespaces survive the warning projection", () => {
  // A14: the native-continuation diagnostic is additive. A credential problem, a
  // permission refusal or a protocol rejection must still reach the person with
  // its own code — there is no global warning filter just because one warning
  // learned a richer shape.
  const events = projectEnvelopes([
    envelope("observation", { component: "provider", code: "auth", message: "凭据不可用" }, 1),
    envelope("observation", { component: "provider", code: "native_continuation_unavailable",
      message: "部分历史的模型续接数据无法恢复（2 条），本轮将使用可见对话继续。",
      diagnostic: { schemaVersion: 1, cause: "binding_mismatch", affected: 2,
        basis: "native_expected_occurrences", severity: "degraded", noticeId: "n1" } }, 2),
    envelope("error", { code: "permission_denied", message: "denied" }, 3),
  ]);
  const warnings = events.filter((event) => event.type === "warning");
  assert.deepEqual(warnings.map((event) => event.type === "warning" ? event.code : ""),
    ["auth", "native_continuation_unavailable", "permission_denied"]);
  assert.equal(warnings[0]?.type === "warning" ? warnings[0].diagnostic : "absent", undefined,
    "only the diagnosed warning carries a diagnostic");
  assert.equal(warnings[1]?.type === "warning" ? warnings[1].diagnostic?.noticeId : "", "n1");
});

test("an unknown diagnostic shape is dropped, not half-rendered", () => {
  const events = projectEnvelopes([
    envelope("observation", { component: "provider", code: "native_continuation_unavailable",
      message: "x", diagnostic: { schemaVersion: 99, cause: "from_the_future" } }, 1),
  ]);
  const warning = events.find((event) => event.type === "warning");
  assert.equal(warning?.type === "warning" ? warning.diagnostic : "absent", undefined);
  assert.equal(warning?.type === "warning" ? warning.code : "", "native_continuation_unavailable",
    "the warning itself still reaches the user");
});

test("successful checkpoint observations stay in the journal and do not become warnings", () => {
  assert.deepEqual(projectEnvelopeSequence([
    envelope("observation", { component: "checkpoint", status: "ok", checkpointId: "cp-a" }, 1),
  ]), []);
  assert.deepEqual(projectEnvelopeSequence([
    envelope("observation", { component: "checkpoint", status: "failed", code: "checkpoint_io" }, 2),
  ]), [{ type: "warning", code: "checkpoint_io", message: "" }]);
});

function drainIncrementally(envelopes: ReadonlyArray<Envelope>): ReadonlyArray<CliStreamEvent> {
  const translator = createStreamTranslator();
  const events: CliStreamEvent[] = [];
  for (const item of envelopes) {
    events.push(...translator.push(item));
  }
  events.push(...translator.finish());
  return events;
}

test("the batch sequence is identical to the existing projection", () => {
  assert.deepEqual(projectEnvelopeSequence(fixtures()), projectEnvelopes(fixtures()));
});

test("a failed tool result carries why, and a successful one grows no new field", () => {
  const failed = projectEnvelopeSequence([
    envelope("tool_result", { toolCallId: "t1", status: "failed", code: "shell_nonzero_exit", message: "shell_nonzero_exit:1\nboom" }, 1),
  ]);
  assert.deepEqual(failed, [
    {
      type: "tool_result",
      toolCallId: "t1",
      status: "failed",
      output: "",
      truncated: false,
      message: "shell_nonzero_exit:1\nboom",
      code: "shell_nonzero_exit",
    },
  ]);
  // The same envelope shape a success has always had: `output`, no `message`.
  const succeeded = projectEnvelopeSequence([
    envelope("tool_result", { toolCallId: "t2", status: "succeeded", output: "v22", truncated: false }, 1),
  ]);
  assert.deepEqual(succeeded, [
    { type: "tool_result", toolCallId: "t2", status: "succeeded", output: "v22", truncated: false },
  ]);
});

test("draining one envelope at a time produces the same sequence", () => {
  assert.deepEqual(drainIncrementally(fixtures()), projectEnvelopes(fixtures()));
});

test("an unknown envelope kind contributes nothing and changes no state", () => {
  const withUnknown = [...fixtures(), envelope("something_else", { text: "ignored" }, 11)];
  assert.deepEqual(projectEnvelopeSequence(withUnknown), projectEnvelopeSequence(fixtures()));
});

test("finish closes what is open and is safe to call twice", () => {
  const translator = createStreamTranslator();
  translator.push(envelope("text", { text: "unterminated" }, 1));
  assert.deepEqual(translator.push(envelope("thinking", { text: "still open" }, 2)), [
    { type: "message_end" }, { type: "reasoning_start", redacted: false }, { type: "reasoning_delta", text: "still open" },
  ]);
  const closed = translator.finish();
  assert.deepEqual(closed, [{ type: "reasoning_end" }]);
  assert.deepEqual(translator.finish(), []);
});

test("reasoning closes before an answer or tool so each iteration has its own block", () => {
  const events = projectEnvelopeSequence([
    envelope("thinking", { text: "inspect first", redacted: false }, 1),
    envelope("tool_use", { toolCallId: "t", name: "read_file" }, 2),
    envelope("tool_result", { toolCallId: "t", status: "ok", output: "read", truncated: false }, 3),
    envelope("thinking", { text: "summarize result", redacted: false }, 4),
    envelope("text", { text: "answer" }, 5),
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    "reasoning_start", "reasoning_delta", "reasoning_end", "tool_use", "tool_result",
    "reasoning_start", "reasoning_delta", "reasoning_end", "message_start", "message_delta", "message_end",
  ]);
});

test("text closes before reasoning and redaction changes start a separate block", () => {
  assert.deepEqual(projectEnvelopeSequence([
    envelope("text", { text: "progress" }, 1),
    envelope("thinking", { text: "public summary", redacted: false }, 2),
    envelope("thinking", { text: "hidden", redacted: true }, 3),
    envelope("thinking", { text: "next summary", redacted: false }, 4),
  ]), [
    { type: "message_start" }, { type: "message_delta", text: "progress" }, { type: "message_end" },
    { type: "reasoning_start", redacted: false }, { type: "reasoning_delta", text: "public summary" }, { type: "reasoning_end" },
    { type: "reasoning_start", redacted: true }, { type: "reasoning_end" },
    { type: "reasoning_start", redacted: false }, { type: "reasoning_delta", text: "next summary" }, { type: "reasoning_end" },
  ]);
});

test("a message is closed by a tool call and reopened afterwards", () => {
  const events = projectEnvelopeSequence([
    envelope("text", { text: "before" }, 1),
    envelope("tool_use", { toolCallId: "t", name: "run_shell" }, 2),
    envelope("text", { text: "after" }, 3),
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_start", "message_delta", "message_end", "tool_use", "message_start", "message_delta", "message_end"],
  );
});

test("no terminal result is produced early: run_result is not this module's to emit", () => {
  const events = drainIncrementally(fixtures());
  assert.equal(
    events.some((event) => event.type === "run_result"),
    false,
  );
});

test("two translators do not share state", () => {
  const first = createStreamTranslator();
  const second = createStreamTranslator();
  first.push(envelope("text", { text: "one" }, 1));
  assert.deepEqual(second.push(envelope("text", { text: "two" }, 1)), [
    { type: "message_start" },
    { type: "message_delta", text: "two" },
  ]);
});

test("D7: an event_overflow terminal tells the user to split the task", () => {
  const events = drainIncrementally([
    envelope("terminal", { reason: "failed", cause: "event_overflow", limit: 4096 }, 1),
  ]);
  const warning = events.find((event) => event.type === "warning");
  assert.notEqual(warning, undefined);
  if (warning !== undefined && warning.type === "warning") {
    assert.match(warning.message, /split/i);
  }
});

test("P0-6: a failed terminal always leads with the failure code, then detail, then the next step", () => {
  // The observed invalid_request failure: provider detail preserved by the
  // loop adapter, surfaced here as code - detail - action.
  const invalid = drainIncrementally([
    envelope("terminal", { reason: "failed", errorClass: "invalid_request", message: "http_400" }, 1),
  ]);
  const invalidWarning = invalid.find((event) => event.type === "warning");
  assert.notEqual(invalidWarning, undefined);
  if (invalidWarning !== undefined && invalidWarning.type === "warning") {
    assert.equal(invalidWarning.code, "invalid_request");
    assert.match(invalidWarning.message, /^invalid_request - http_400 - /);
    assert.match(invalidWarning.message, /--model/);
  }
  // A bare class with no detail still gets its head: code - action.
  const bare = drainIncrementally([
    envelope("terminal", { reason: "failed", errorClass: "rate_limit", message: "rate_limit" }, 1),
  ]);
  const bareWarning = bare.find((event) => event.type === "warning");
  assert.notEqual(bareWarning, undefined);
  if (bareWarning !== undefined && bareWarning.type === "warning") {
    assert.equal(bareWarning.code, "rate_limit");
    assert.match(bareWarning.message, /^rate_limit - wait and retry/);
  }
});
