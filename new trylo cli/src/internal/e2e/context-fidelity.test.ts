import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "../adapters/provider/openai-compatible.js";
import { createResponsesProvider } from "../adapters/provider/responses.js";
import { createWarmRegistry } from "../adapters/provider/warm.js";
import { createReadOnlyTools } from "../adapters/tools/read-only/index.js";
import { createNodeFileSystemReader } from "../adapters/tools/read-only/node-fs.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { buildProvider } from "../surface/cli/provider-build.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolPort } from "../ports/tools.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const model = "glm-5.3-flash";

type WireMessage = { role: string; content: string | Array<{ type: string; image_url?: { url: string } }>;
  reasoning_content?: string; tool_calls?: Array<{ function: { arguments: string } }> };

type WireBody = { messages: WireMessage[] };

function response(args?: JsonObject, usage?: number, name = "echo"): Response {
  const frames = [
    { choices: [{ delta: { reasoning_content: "ORIGINAL_NATIVE", content: "Checking.",
      ...(args === undefined ? {} : { tool_calls: [{ index: 0, id: `call-${String(args.value ?? 1)}`, function: { name, arguments: JSON.stringify(args) } }] }) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: args === undefined ? "stop" : "tool_calls" }],
      ...(usage === undefined ? {} : { usage: { prompt_tokens: usage, completion_tokens: 10, total_tokens: usage + 10 } }) },
  ];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
}

const permission = createFakePermission("approved");

function echoTools(outputs = ["OK"]): ToolPort {
  let count = 0;
  return { snapshot: () => [echoBinding({ needsApproval: false, parameters: {
    type: "object", properties: { value: { type: "number" } }, required: ["value"],
  } })], execute: async () => toolResult({}, outputs[count++] ?? "OK"), cancel: async () => {} };
}

const input = { sessionId: "s", turnId: "t", correlationId: "c", model, text: "Use echo.", budget: { maxIterations: 5 } };

test("official Volcano GLM aliases retain original native context after tools", async () => {
  for (const requested of ["ark-code-latest", "glm-latest", "glm-5.3"]) {
    const bodies: WireBody[] = [];
    const provider = createOpenAiCompatibleProvider({ endpoint, model: requested, apiKey: "fixture-key",
      fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireBody);
        return bodies.length === 1 ? response({ value: 7 }) : response(); } });
    const result = await runTurn({ provider, permission, profile: emptyProfileLoader(), tools: echoTools() }, { ...input, model: requested });

    assert.equal(result.state.terminalReason, "completed");
    assert.equal(bodies[1]!.messages.find(m => m.role === "assistant")?.reasoning_content, "ORIGINAL_NATIVE", requested);
  }
});

test("native context remains paired with the original call when execution arguments are normalized", async () => {
  const bodies: WireBody[] = [];
  let executed: JsonObject | undefined;
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key",
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireBody);
      return bodies.length === 1 ? response({ arguments: { value: 7 } }) : response(); } });
  const tools = echoTools();
  const result = await runTurn({ provider, permission, profile: emptyProfileLoader(), tools: {
    ...tools, execute: async call => {
      executed = call.arguments;
      return toolResult({});
    },
  } }, input);

  assert.equal(result.state.terminalReason, "completed");
  assert.deepEqual(executed, { value: 7 });
  const assistant = bodies[1]!.messages.find(m => m.role === "assistant")!;

  assert.equal(assistant.reasoning_content, "ORIGINAL_NATIVE");
  assert.deepEqual(JSON.parse(assistant.tool_calls![0]!.function.arguments), { arguments: { value: 7 } });
});

test("the next wire retains a consumed tool result while context budgeting has room", async () => {
  const bodies: WireBody[] = [];
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key",
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireBody);
      return bodies.length <= 2 ? response({ value: bodies.length }) : response(); } });
  const result = await runTurn({ provider, permission, profile: emptyProfileLoader(), tools: echoTools(["A".repeat(25_000), "LATEST"]),
    compaction: compactionWiring({ nowMs: 0 }),
  }, { ...input, budget: { maxIterations: 5, contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "completed");
  const results = bodies[2]!.messages.filter(m => m.role === "tool");

  assert.equal(String(results[0]!.content).length, 25_000);
  assert.ok(results[0]!.content === "A".repeat(25_000));
  assert.equal(results[1]!.content, "LATEST");
  assert.equal(result.transcript.find(i => i.kind === "tool_result")?.output.length, 25_000);
});

test("automatic compaction preserves the complete original user constraint", async () => {
  const marker = "REQUIRED_CONSTRAINT_AT_END", text = "Background ".repeat(50) + marker;
  const bodies: WireBody[] = [];
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key",
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireBody);
      return bodies.length === 1 ? response({ value: 7 }) : response(); } });
  const result = await runTurn({ provider, permission, profile: emptyProfileLoader(), tools: echoTools(),
    compaction: compactionWiring({ nowMs: 0 }),
  }, { ...input, text, resumedTranscript: [
    { kind: "user", sequence: 0, text: "A previous completed task." },
    { kind: "assistant_text", sequence: 1, blockId: "previous-answer", text: "Completed historical answer. ".repeat(2400) },
  ], budget: { maxIterations: 5, contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.compactions.length, 1);
  assert.ok(bodies[0]!.messages.some(m => m.role === "user" && m.content === text));
  assert.ok(bodies[1]!.messages.some(m => m.role === "user" && m.content === text));
});

test("a resumed history with no journaled native source is not reported as lost context", async () => {
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key", fetchImpl: async () => response() });
  const result = await runTurn({ provider, permission, profile: emptyProfileLoader(), tools: echoTools() }, {
    ...input, resumedTranscript: [
      { kind: "user", sequence: 0, text: "Previous input." },
      { kind: "tool_call", sequence: 1, toolCallId: "old", name: "echo", arguments: { value: 1 } },
      { kind: "tool_result", sequence: 2, toolCallId: "old", name: "echo", output: "OK", outcome: "succeeded", truncated: false },
    ],
  });

  assert.equal(result.state.terminalReason, "completed");
  // WP-CL / A04: no journaled source record means "unknown", not "lost". A
  // count here would be an invented number, and repeating it every process is
  // the noise this work package removes.
  assert.equal(result.envelopes.filter(e => e.kind === "observation" && e.payload.code === "native_continuation_unavailable").length, 0);
});

test("an oversized user constraint is refused rather than compacted away", async () => {
  let sent = 0;
  const text = "Required original instruction. ".repeat(2000);
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key",
    fetchImpl: async () => ++sent === 1 ? response({ value: 7 }, 11_000) : response() });
  const result = await runTurn({ provider, permission, profile: emptyProfileLoader(), tools: echoTools(),
    compaction: compactionWiring({ nowMs: 0 }),
  }, { ...input, text, budget: { maxIterations: 5, contextTokenLimit: 10_000 } });

  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.envelopes.some(e => e.kind === "terminal" && e.payload.cause === "context_limit"));
  assert.equal(sent, 0, "the first oversized request is rejected locally before network I/O");
  assert.ok(result.transcript.some(i => i.kind === "user" && i.text === text));
});

test("a real view_image reaches Chat and survives resume without storing image bytes in transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-context-image-"));
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,
    0,0,0,0,73,68,65,84,53,175,6,30,0,0,0,0,73,69,78,68,174,66,96,130]);
  const bodies: WireBody[] = [];
  const originalFetch = globalThis.fetch;

  try {
    writeFileSync(join(root, "image.png"), png);
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireBody);
      return bodies.length === 1 ? response({ path: "image.png" }, undefined, "view_image") : response(); };
    const warm = createWarmRegistry();

    // A transport reused by a REPL must not retain another workspace's image
    // reader, even when endpoint, account and model are identical.
    buildProvider({ providerId: "openai-compatible", model, endpoint, apiKey: "fixture-key", workspaceRoot: join(root, "other"), permission, warm });
    const provider = () => {
      const built = buildProvider({ providerId: "openai-compatible", model, endpoint, apiKey: "fixture-key", workspaceRoot: root, permission, warm });
      if ("code" in built) throw new Error(built.code);
      return built;
    };
    const tools = createReadOnlyTools({ workspaceRoot: root, reader: createNodeFileSystemReader() });
    const first = await runTurn({ provider: provider(), permission, profile: emptyProfileLoader(), tools }, input);

    assert.equal(first.state.terminalReason, "completed", "image reader must belong to this workspace");
    const images = (body: WireBody) => body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === "image_url");

    assert.equal(images(bodies[1]!).length, 1);
    assert.equal(images(bodies[1]!)[0]!.image_url?.url, `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    assert.equal(JSON.stringify(first.transcript).includes(Buffer.from(png).toString("base64")), false);
    assert.equal(JSON.stringify(first.envelopes).includes(Buffer.from(png).toString("base64")), false, "image bytes must not enter durable tool-success envelopes");
    const resumed = JSON.parse(JSON.stringify(first.transcript)) as typeof first.transcript;

    await runTurn({ provider: provider(), permission, profile: emptyProfileLoader(), tools }, { ...input, turnId: "next", resumedTranscript: resumed });
    assert.equal(images(bodies[2]!).length, 1);
    writeFileSync(join(root, "image.png"), "changed");
    const changed = await runTurn({ provider: provider(), permission, profile: emptyProfileLoader(), tools }, { ...input, turnId: "changed", resumedTranscript: resumed });

    assert.equal(bodies.length, 4, "a stale historical image must not permanently block the conversation");
    assert.equal(images(bodies[3]!).length, 0, "changed bytes must never be presented as the old snapshot");
    assert.equal(changed.state.terminalReason, "completed");
    assert.equal(changed.envelopes.some(e => e.kind === "observation" && e.payload.code === "image_reference_changed"), false);
    assert.ok(bodies[3]!.messages.some(m => typeof m.content === "string" && m.content.includes("image_reference_changed")));
    assert.ok(bodies[3]!.messages.some(m => typeof m.content === "string" && m.content.includes("view_image")));
    writeFileSync(join(root, "image.png"), png);
    let freshSent = 0;

    globalThis.fetch = async () => ++freshSent === 1 ? response({ path: "image.png" }, undefined, "view_image") : response();
    const fresh = await runTurn({ provider: provider(), permission, profile: emptyProfileLoader(), tools: {
      ...tools, execute: async (call, signal) => {
        const outcome = await tools.execute(call, signal);
        writeFileSync(join(root, "image.png"), "changed after validation");
        return outcome;
      },
    } }, { ...input, turnId: "fresh" });

    assert.equal(fresh.state.terminalReason, "failed", "a newly requested image must actually reach the model");
    assert.equal(freshSent, 1, "fresh image validation failure must stop before the next send");

    for (const create of [createOpenAiCompatibleProvider, createResponsesProvider]) {
      let sent = 0;
      const direct = create({ endpoint, model, apiKey: "fixture-key", fetchImpl: async () => {
        sent++;
        return response();
      } });
      const unsupported = await runTurn({ provider: direct, permission, profile: emptyProfileLoader(), tools },
        { ...input, turnId: "library", resumedTranscript: resumed });
      assert.equal(sent, 0, "a library adapter without reference hydration must fail before sending");
      assert.equal(unsupported.state.terminalReason, "failed");
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
