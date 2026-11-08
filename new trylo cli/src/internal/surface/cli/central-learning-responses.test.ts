import assert from "node:assert/strict";
import test from "node:test";
import { boundToolOutput, MAX_TOOL_OUTPUT_BYTES } from "../../loop/tool-execution.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { fields } from "../../validation/json-shape.js";
import { createCentralLearningResponses } from "./central-learning-responses.js";
import { centralLearningTools } from "./central-learning-tools.js";
import { toolSuccessPayload } from "../../domain/reduce-tooling.js";
import { parseEnvelope } from "../../protocol/validate.js";
import type { ToolOutcome } from "../../ports/tools.js";

const material = "原条件😀\"\\\n".repeat(10000);
const callId = 'normal:"\\😀'.repeat(20);

function validJournal(output: string, toolCallId = callId) {
  const payload = { toolCallId, status: "succeeded", ...toolSuccessPayload({ type: "tool_succeeded", eventId: "result:1",
    toolCallId, value: { result: JSON.parse(output) }, output, truncated: false }) };
  assert.deepEqual(parseEnvelope({ protocolVersion: "0.0", eventId: "event:1", sequence: 1,
    timestamp: "2026-11-04T14:00:00.000Z", producerId: "normal:host", producerSequence: 1, kind: "tool_result", payload }).ok, true,
  `The actual original tool payload must fit: ${Buffer.byteLength(JSON.stringify(payload))}`);
}

test("large Chinese semantic requests survive the actual frozen loop result limit as exact JSON pages", () => {
  const original = { status: "apply_known", stageRef: "stage:actual", request: { inputHash: "source:actual",
    materialJson: JSON.stringify({ packet: { originalRequirements: material } }) } };
  const responses = createCentralLearningResponses();
  const firstWire = boundToolOutput(responses.render(original, callId), false);

  validJournal(firstWire.output);
  assert.equal(firstWire.truncated, false);
  assert.ok(Buffer.byteLength(firstWire.output) <= MAX_TOOL_OUTPUT_BYTES);
  const first: unknown = JSON.parse(firstWire.output);

  assert.ok(fields(first, ["status", "responseRef", "totalBytes", "instruction", "firstPage"]));
  assert.equal(first.status, "paged_response");
  assert.equal(typeof first.responseRef, "string");

  if (typeof first.responseRef !== "string") throw new Error("response_reference_missing");

  const responseRef = first.responseRef;
  const initial = first.firstPage;

  assert.ok(fields(initial, ["status", "responseRef", "sourceHash", "unit", "start", "end", "totalBytes", "nextStart", "text"]));
  assert.equal(typeof initial.text, "string");
  let reconstructed = String(initial.text), next = initial.nextStart;

  while (next !== null) {
    assert.equal(typeof next, "number");
    if (typeof next !== "number") throw new Error("response_page_cursor_invalid");

    const page = responses.read(responseRef, next, undefined, callId);
    const wire = boundToolOutput(responses.render(page, callId), false);

    validJournal(wire.output);
    assert.equal(wire.truncated, false);
    assert.ok(Buffer.byteLength(wire.output) <= MAX_TOOL_OUTPUT_BYTES);
    assert.doesNotThrow(() => JSON.parse(wire.output));
    reconstructed += page.text;
    next = page.nextStart;
  }

  assert.deepEqual(JSON.parse(reconstructed), original);
  assert.equal(contentHashOf(reconstructed), initial.sourceHash);
  const insideCharacter = Buffer.from(reconstructed, "utf8").indexOf(Buffer.from("😀", "utf8")) + 1;

  assert.throws(() => responses.read(responseRef, insideCharacter), /central_response_range_invalid/);
});

test("a result below the text cap still pages when the actual doubled journal payload exceeds its cap", () => {
  const original = { status: "published", material: '原文\\\"\n😀'.repeat(2500) };
  assert.ok(Buffer.byteLength(JSON.stringify(original)) < MAX_TOOL_OUTPUT_BYTES);
  const output = createCentralLearningResponses().render(original, callId);
  validJournal(output);
  assert.equal(JSON.parse(output).status, "paged_response");
});

test("PA focus and central read_response share one bounded wire cache and preserve exact original JSON", async () => {
  const original = { status: "focused", central: { material } }, output = JSON.stringify(original);
  const fail = async () => assert.fail("transport must not invoke a business operation");
  const transport = centralLearningTools({ command: fail, focus: fail, resume: fail, beforeInspect: fail,
    beforeTask: fail, afterTask: fail, close: fail });
  const controls = transport.wrapControlTools({ snapshot: () => [], cancel: async () => {},
    execute: async () => ({ outcome: "result", value: { result: original }, output, truncated: false }) });
  const read = (outcome: ToolOutcome) => {
    assert.equal(outcome.outcome, "result");
    if (outcome.outcome !== "result") throw new Error("transport_result_missing");
    validJournal(outcome.output);
    return JSON.parse(outcome.output);
  };
  const first = read(await controls.execute({ toolCallId: callId, name: "collaboration_decide", arguments: {} }, new AbortController().signal));

  assert.equal(first.status, "paged_response");
  let page = first.firstPage, reconstructed = page.text;

  while (page.nextStart !== null) {
    const next = read(await transport.tools.execute({ toolCallId: callId, name: "central_learning",
      arguments: { operation: "read_response", responseRef: first.responseRef, start: page.nextStart } }, new AbortController().signal));
    assert.equal(next.status, "response_page", "a page is sized directly, never recursively paged");
    assert.equal(next.start, page.end);
    assert.equal(next.sourceHash, first.firstPage.sourceHash);
    reconstructed += next.text;
    page = next;
  }

  assert.equal(reconstructed, output);
  assert.equal(contentHashOf(reconstructed), first.firstPage.sourceHash);
});

test("expired wire pages are explicit and do not imply permission to repeat a completed action", () => {
  const responses = createCentralLearningResponses();
  let firstRef = "";

  for (let index = 0; index < 9; index += 1) {
    const raw: unknown = JSON.parse(responses.render({ index, material }));
    assert.ok(fields(raw, ["status", "responseRef", "totalBytes", "instruction", "firstPage"]));
    if (index === 0) firstRef = String(raw.responseRef);
  }

  assert.throws(() => responses.read(firstRef), /expired_inspect_original_state_before_retrying/);
});
