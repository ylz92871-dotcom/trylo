import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "../../loop/scenarios.js";
import {
  CLI_STREAM_EVENT_TYPES,
  EXIT_CODES,
  isCliRunResult,
  isCliStreamEventType,
} from "../../protocol/cli-stream.js";
import { exitCodeForResult, terminalStatusOf, usageToCli } from "./host.js";
import { projectRun } from "./projection.js";
import { createProjection, type CliSink } from "./render.js";

/**
 * The event sequence contract (WP C 波 §4.3, 反方 #14/#15).
 *
 * `run --format stream-json` is a wire format somebody else's code parses, so
 * its shape is a promise: one `run_start`, a bounded set of event types in the
 * middle, exactly one `run_result` at the end, and — the case that is easiest to
 * get wrong — a `run_result` even when the run was cancelled. A stream that just
 * stops leaves the parent process holding a half-parsed turn.
 *
 * Both projections are driven from the same event list, because the text
 * renderer is what a human sees and it must not disagree with the JSON one.
 */

const META = {
  sessionId: "ses-seq",
  turnId: "trn-seq",
  providerId: "fixture",
  model: "fixture-model",
  iterations: 1,
  durationMs: 0,
};

async function eventsFor(scenario: Parameters<typeof runScenario>[0]) {
  const result = await runScenario(scenario);
  const events = projectRun(
    result.envelopes,
    result.transcript,
    usageToCli(result.usage),
    META,
    { status: terminalStatusOf(result), finishReason: result.state.finishReason },
  );
  return { result, events };
}

/** The text renderer puts every human byte on stderr; only deltas hit stdout. */
function sink(): { readonly out: string[]; readonly err: string[]; readonly sink: CliSink } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
}

const SCENARIOS = ["ordinary-stream", "tool-approve", "streaming-cancel"] as const;

for (const scenario of SCENARIOS) {
  test(`${scenario}: run_start opens, exactly one run_result closes, every type is known`, async () => {
    const { events } = await eventsFor(scenario);
    assert.equal(events.length > 1, true, "a run emits more than a bracket");
    assert.equal(events[0]?.type, "run_start");
    assert.equal(events.at(-1)?.type, "run_result");
    const terminals = events.filter((event) => event.type === "run_result");
    assert.equal(terminals.length, 1, "exactly one terminal event");
    for (const event of events) {
      assert.equal(isCliStreamEventType(event.type), true, `${event.type} is not in the closed set`);
    }
    assert.deepEqual([...new Set(events.map((e) => e.type))].every(isCliStreamEventType), true);
  });

  test(`${scenario}: the terminal event carries usage and a finish reason`, async () => {
    const { events } = await eventsFor(scenario);
    const last = events.at(-1);
    assert.equal(isCliRunResult(last), true, "the terminal event must satisfy the wire contract");
    if (!isCliRunResult(last)) {
      return;
    }
    assert.equal(typeof last.usage.inputTokens, "number");
    assert.equal(typeof last.usage.outputTokens, "number");
    assert.equal(typeof last.usage.totalTokens, "number");
    assert.equal(typeof last.finishReason, "string");
    assert.equal(typeof last.lastMessage, "string");
  });
}

test("the middle of the stream is only message, tool and diagnostic events", async () => {
  const { events } = await eventsFor("tool-approve");
  const allowed = new Set([
    "message_start",
    "message_delta",
    "message_end",
    "reasoning_start",
    "reasoning_delta",
    "reasoning_end",
    "tool_use",
    "tool_result",
    "warning",
    "usage",
  ]);
  const middle = events.slice(1, -1);
  for (const event of middle) {
    assert.equal(allowed.has(event.type), true, `${event.type} is not a legal middle event`);
  }
});

test("every tool_use is followed by a tool_result with the same id before the run closes", async () => {
  const { events } = await eventsFor("tool-approve");
  const uses = events.filter((event) => event.type === "tool_use");
  assert.equal(uses.length > 0, true, "the scenario must actually call a tool");
  for (const use of uses) {
    if (use.type !== "tool_use") {
      continue;
    }
    const at = events.indexOf(use);
    const result = events
      .slice(at + 1)
      .find((event) => event.type === "tool_result" && event.toolCallId === use.toolCallId);
    assert.notEqual(result, undefined, `tool_use ${use.toolCallId} never resolved`);
  }
});

test("attack #14: a cancelled run still closes with a run_result", async () => {
  const { result, events } = await eventsFor("streaming-cancel");
  const last = events.at(-1);
  assert.equal(last?.type, "run_result");
  if (last?.type === "run_result") {
    assert.equal(last.status, "cancelled");
    assert.equal(typeof last.finishReason, "string");
  }
  assert.equal(exitCodeForResult(result), EXIT_CODES.CANCELLED);
});

test("the text projection shows the same terminal state exactly once", async () => {
  for (const scenario of SCENARIOS) {
    const { events } = await eventsFor(scenario);
    const captured = sink();
    const projection = createProjection("text", captured.sink);
    for (const event of events) {
      projection.onEvent(event);
    }
    const results = captured.err.filter((line) => line.includes("result status="));
    assert.equal(results.length, 1, `${scenario}: the text renderer emitted ${results.length} results`);
    // The deltas are the only thing text mode writes to stdout, so a parent
    // piping stdout gets the assistant's words and nothing else.
    const stray = captured.out.filter((line) => line.includes("run_result"));
    assert.equal(stray.length, 0);
  }
});

/**
 * A usage line must never run into the answer's last line.
 *
 * The answer streams to stdout in pieces with no newline of its own, while
 * every diagnostic goes to stderr — so if `usage` arrives before `message_end`
 * (which it does: usage is reported as soon as the provider reports it), the
 * two streams interleave and the screen shows
 * `The package name is @trylo/cli.usage in=32 out=12 total=44`.
 *
 * Both streams are captured into one log here on purpose: the bug is a fact
 * about the interleaving, and two separate arrays cannot see it.
 */
test("a diagnostic line never lands on the same line as the answer", () => {
  const log: string[] = [];
  const projection = createProjection("text", {
    stdout: (text) => log.push(text),
    stderr: (text) => log.push(text),
  });
  projection.onEvent({ type: "message_start" });
  projection.onEvent({ type: "message_delta", text: "The package name is @trylo/cli." });
  projection.onEvent({
    type: "usage",
    usage: { inputTokens: 32, outputTokens: 12, totalTokens: 44 },
  });
  projection.onEvent({ type: "message_end" });
  const flat = log.join("");
  assert.match(
    flat,
    /cli\.\nusage in=32/,
    "the usage line ran straight into the answer instead of starting a line",
  );
});

test("a tool call mid-answer also starts on its own line", () => {
  const log: string[] = [];
  const projection = createProjection("text", {
    stdout: (text) => log.push(text),
    stderr: (text) => log.push(text),
  });
  projection.onEvent({ type: "message_start" });
  projection.onEvent({ type: "message_delta", text: "let me check" });
  projection.onEvent({ type: "tool_use", toolCallId: "c1", name: "read_file" });
  assert.match(log.join(""), /check\n-> read_file/);
});

test("the json projection emits one line per event and nothing that is not JSON", async () => {
  const { events } = await eventsFor("ordinary-stream");
  const stdout: string[] = [];
  const projection = createProjection("stream-json", {
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
  });
  for (const event of events) {
    projection.onEvent(event);
  }
  const text = stdout.join("");
  const lines = text.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, events.length);
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    assert.equal(typeof parsed === "object" && parsed !== null, true);
  }
  assert.equal(CLI_STREAM_EVENT_TYPES.length, 14, "the closed set includes compact and subagent lifecycle events");
  assert.ok(CLI_STREAM_EVENT_TYPES.includes("compact"));
});
