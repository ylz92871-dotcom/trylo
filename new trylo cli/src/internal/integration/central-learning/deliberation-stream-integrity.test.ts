import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { translateBody } from "../../adapters/provider/openai-stream.js";
import { readCentralDeliberationStream, type CentralDeliberationStreamResult } from "./deliberation-stream.js";
import { isCentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";

const DECISION = "submit_learning_change", LEGACY_DECISION = "submit_central_deliberation";
const usageFrame = JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } });
const finishFrame = (reason: "stop" | "tool_calls" | "length") => JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
const textFrame = (content: string) => JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] });

function toolFrames(argumentsText: string, name = DECISION): readonly string[] {
  const pieces = [argumentsText.slice(0, 17), argumentsText.slice(17, 43), argumentsText.slice(43)];
  return pieces.map((argumentsPart, index) => JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
    ...(index === 0 ? { id: "decision:integrity", type: "function" } : {}),
    function: { ...(index === 0 ? { name } : {}), arguments: argumentsPart } }] }, finish_reason: null }] }));
}

function fixtureBody(frames: readonly string[], mixedLineEndings: boolean): ReadableStream<Uint8Array> {
  const separators = mixedLineEndings ? ["\n\r\n", "\r\n\n", "\r\n\r\n", "\n\n"] : ["\n\n"];
  const wire = [...frames, "[DONE]"].map((data, index) => `data: ${data}${separators[index % separators.length]}`).join("");
  const bytes = new TextEncoder().encode(wire), widths = [1, 2, 5, 3, 8];
  let offset = 0, chunk = 0;

  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) {
      controller.close();
      return;
    }
    const end = Math.min(bytes.length, offset + widths[chunk++ % widths.length]!);
    controller.enqueue(bytes.slice(offset, end));
    offset = end;
  } });
}

async function read(frames: readonly string[], mode: "tool" | "json_object", mixedLineEndings = false,
  toolName = DECISION): Promise<CentralDeliberationStreamResult> {
  const request: ProviderRequest = { attemptId: "attempt:memory-stream-integrity", model: "local-stream-fixture", messages: [],
    tools: mode === "tool" ? [{ name: toolName, description: "One public result envelope", parameters: { type: "object" } }] : [],
    maxOutputTokens: 512, ...(mode === "json_object" ? { responseFormat: { type: "json_object" as const } } : {}) };
  const provider: ProviderPort = { responseFormats: ["json_object"], stream(actual, signal) {
    assert.equal(actual, request);
    if (mode === "json_object") {
      assert.deepEqual(actual.tools, []);
      assert.deepEqual(actual.responseFormat, { type: "json_object" });
    }
    else assert.equal(actual.responseFormat, undefined);
    return translateBody(fixtureBody(frames, mixedLineEndings), signal);
  } };

  return readCentralDeliberationStream({ provider, request, signal: new AbortController().signal,
    enabled: () => true, maxTokens: 1000, timeoutMs: 10000 });
}

function knownUsage(result: CentralDeliberationStreamResult): void {
  assert.equal(result.boundary.kind, "complete");
  assert.equal(result.reported, true);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 40);
  assert.equal(result.usage.totalTokens, 160);
}

function jsonRejected(result: CentralDeliberationStreamResult): void {
  assert.equal(result.output, undefined);
  assert.equal(typeof result.reason, "string");
  knownUsage(result);
  const diagnostic = result.diagnostics;
  assert.ok(diagnostic);
  assert.ok(isCentralDeliberationOutputDiagnostics(diagnostic));
  assert.equal(diagnostic.schemaVersion, 2);
  assert.equal("mode" in diagnostic ? diagnostic.mode : undefined, "json_object");
  assert.equal(diagnostic.usageObserved, true);
  assert.equal(diagnostic.streamExhausted, true);
  assert.equal("unparseableSseFrames" in diagnostic ? diagnostic.unparseableSseFrames : undefined, 0);
}

test("the actual SSE translator preserves fragmented JSON and accounts for rejected protocol gaps and JSON content without accepting tools", async () => {
  const object = { schemaVersion: 1, explanation: "边界🍃保留原文", escaped: 'line one\n"quoted"\\tail',
    nested: { conditions: ["原单位", "receiver conversion"] } };
  const argumentsText = JSON.stringify(object), tools = toolFrames(argumentsText);

  for (const mixedLineEndings of [false, true]) {
    const result = await read([...tools, finishFrame("tool_calls"), usageFrame], "tool", mixedLineEndings);
    assert.equal(result.reason, undefined);
    assert.deepEqual(result.output, object);
    knownUsage(result);
    assert.equal(result.diagnostics, undefined, "legal line endings and byte boundaries do not allege a malformed frame");
  }

  const gap = await read([tools[0]!, "{ genuinely invalid outer JSON", ...tools.slice(1), finishFrame("tool_calls"), usageFrame], "tool", true);

  assert.equal(gap.reason, "central_deliberation_stream_protocol_gap");
  assert.equal(gap.output, undefined);
  knownUsage(gap);
  const gapDiagnostic = gap.diagnostics;
  assert.ok(gapDiagnostic);
  assert.ok(isCentralDeliberationOutputDiagnostics(gapDiagnostic));
  assert.equal(gapDiagnostic.schemaVersion, 2);
  assert.equal(gapDiagnostic.cause, "wire_frame_invalid");
  assert.equal("mode" in gapDiagnostic ? gapDiagnostic.mode : undefined, "tool");
  assert.equal("unparseableSseFrames" in gapDiagnostic ? gapDiagnostic.unparseableSseFrames : undefined, 1);
  assert.equal(gapDiagnostic.usageObserved, true);
  assert.equal(gapDiagnostic.streamExhausted, true);
  assert.equal(gapDiagnostic.usageTailComplete, true, "the same rejected stream retains its real complete usage tail");

  const postFinishGap = await read([...tools, finishFrame("tool_calls"), "{ invalid outer JSON after finish", usageFrame], "tool", true);

  assert.equal(postFinishGap.reason, "central_deliberation_stream_protocol_gap");
  assert.equal(postFinishGap.output, undefined);
  knownUsage(postFinishGap);
  const postFinishDiagnostic = postFinishGap.diagnostics;
  assert.ok(postFinishDiagnostic);
  assert.ok(isCentralDeliberationOutputDiagnostics(postFinishDiagnostic));
  assert.equal(postFinishDiagnostic.schemaVersion, 2);
  assert.equal("unparseableSseFrames" in postFinishDiagnostic ? postFinishDiagnostic.unparseableSseFrames : undefined, 1,
    "holding finish for usage must not discard a later safe malformed-frame marker");

  const json = await read([textFrame(argumentsText.slice(0, 23)), textFrame(argumentsText.slice(23)), finishFrame("stop"), usageFrame], "json_object", true);

  assert.equal(json.reason, undefined);
  assert.deepEqual(json.output, object);
  knownUsage(json);

  for (const [content, finish] of [["", "stop"], [argumentsText, "length"], ["[]", "stop"]] as const) {
    jsonRejected(await read([textFrame(content), finishFrame(finish), usageFrame], "json_object"));
  }

  for (const forbiddenName of [LEGACY_DECISION, DECISION]) {
    jsonRejected(await read([...toolFrames(argumentsText, forbiddenName), finishFrame("tool_calls"), usageFrame], "json_object"));
  }

  jsonRejected(await read([textFrame(argumentsText), ...tools, finishFrame("tool_calls"), usageFrame], "json_object"));

  const invalidArguments = "{]";
  const legacy = await read([...toolFrames(invalidArguments, LEGACY_DECISION), finishFrame("tool_calls"), usageFrame], "tool", false, LEGACY_DECISION);

  assert.equal(legacy.reason, "central_deliberation_tool_invalid");
  assert.equal(legacy.output, undefined);
  knownUsage(legacy);
  assert.deepEqual(legacy.diagnostics, { schemaVersion: 1, rejectionReason: "central_deliberation_tool_invalid", cause: "invalid_json",
    argumentChars: invalidArguments.length, toolStarts: 1, invalidTools: 1, requestedOutputTokens: 512, finishReason: "tool_calls",
    usageObserved: true, streamExhausted: true, usageTailComplete: true });
  assert.ok(isCentralDeliberationOutputDiagnostics(JSON.parse(JSON.stringify(legacy.diagnostics))), "the original safe v1 diagnostic remains readable");
});
