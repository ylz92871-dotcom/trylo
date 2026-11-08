import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import { MAX_PAYLOAD_BYTES } from "../protocol/envelope.js";
import { parseEnvelope } from "../protocol/validate.js";
import { createPublicToolResultReader } from "../protocol/public-tool-result.js";
import { createFakePermission, emptyProfileLoader } from "./fakes.js";
import { runTurn } from "./runner.js";

async function toolTurn(value: JsonObject, output: string, truncated = false) {
  let calls = 0;
  return runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: { snapshot: () => [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} },
      sideEffect: "read_only", needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 65536, maxLines: 1000 } }],
      execute: async () => ({ outcome: "result", value, output, truncated }), cancel: async () => {} },
    provider: { async *stream(request) {
      if (calls++ === 0) {
        yield { type: "tool_call", toolCallId: "real-shaped-public-result", name: "read_file", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        assert.equal(request.messages.find(message => message.role === "tool")?.content, output,
          "the next model request receives the original adapter output independently of its structured value");
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } } }, { sessionId: "source-producer", turnId: "turn-producer", correlationId: "producer", text: "Read the original source" });
}

test("a distinct structured value and output retain their complete logical payload across strict public frames", async () => {
  // Both fields fit their own contracts; their combined serialization needs
  // lossless transport rather than an additional model-visible text cut.
  const value = { path: "source.ts", content: "v".repeat(32000), truncated: false, startLine: 1, endLine: 244 };
  const output = `HEAD-ORIGINAL\n${'汉😀"\\\n'.repeat(4000)}\nTAIL-RESULT`;
  const unbounded = { toolCallId: "real-shaped-public-result", status: "succeeded", value, output, truncated: false };

  assert.ok(Buffer.byteLength(JSON.stringify(unbounded)) > MAX_PAYLOAD_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < MAX_PAYLOAD_BYTES);
  const result = await toolTurn(value, output);

  assert.equal(result.state.terminalReason, "completed");
  assert.ok(result.envelopes.every(event => parseEnvelope(event).ok), "physical frames retain the unchanged protocol limit");
  const reader = createPublicToolResultReader();
  const logical = result.envelopes.map(event => reader.push(event)).find(event => event.kind === "result");
  reader.close();
  assert.ok(logical?.kind === "result");
  assert.deepEqual(logical.value.payload.value, value, "nonidentical structured fields remain intact");
  const text = result.transcript.find(row => row.kind === "tool_result");
  assert.ok(text?.kind === "tool_result");
  assert.equal(text.truncated, false);
  assert.equal(logical.value.payload.truncated, false);
  assert.equal(text.output, output);
  assert.equal(logical.value.payload.output, output);
  assert.ok(text.output.startsWith("HEAD-ORIGINAL"));
  assert.ok(text.output.endsWith("TAIL-RESULT"));
  assert.equal(text.output.includes("\uFFFD"), false);
});

test("an adapter's existing truncation flag and range output remain authoritative", async () => {
  const output = '{"startLine":40,"endLine":45,"truncatedLines":true}\nSelected adapter range';
  const value = { content: "Selected adapter range", truncated: true, startLine: 40, endLine: 45 };
  const result = await toolTurn(value, output, true);
  const text = result.transcript.find(row => row.kind === "tool_result");
  assert.ok(text?.kind === "tool_result");
  assert.equal(text.output, output);
  assert.equal(text.truncated, true);
});

test("a complete small tool result retains all original fields without claiming truncation", async () => {
  const value = { path: "small.ts", content: "different structured content" }, output = "Small visible result";
  const result = await toolTurn(value, output), event = result.envelopes.find(row => row.kind === "tool_result");
  assert.ok(event);
  assert.deepEqual(event.payload, { toolCallId: "real-shaped-public-result", status: "succeeded", value, output, truncated: false });
  assert.equal(parseEnvelope(event).ok, true);
});
