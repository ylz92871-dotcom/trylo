import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessagesTokens, estimateToolSpecsTokens } from "../../compaction/token-estimate.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { createPersonalAgentProvider } from "./collaboration-parent-context.js";
import { compactionWiring } from "./compaction-wiring.js";

const pendingMarker = "pending:budget-visible-original";
const userText = "Inspect the specified synthetic file using only read_file.";

function fixture(pendingText = pendingMarker, toolNames: readonly string[] = ["read_file"]) {
  const requests: ProviderRequest[] = [];
  const measurements: (readonly ProviderMessage[])[] = [];
  let pendingReads = 0;
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "stream_start", providerId: "local-no-network", model: request.model, warnings: [] };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const parent = createPersonalAgentProvider({ provider, scope: "workspace:prompt-budget", turnId: "turn:prompt-budget",
    now: () => "2026-11-08T00:00:00.000Z", warn: reason => { throw new Error(reason); },
    experience: {
      async prepareExperience() { return { ok: true as const, text: "", versionIds: [], selectionId: "none" }; },
      async recordLoad() { throw new Error("No experience version was selected."); },
      async recordDispatch() { throw new Error("No experience version was selected."); },
    },
    inspect: async () => ({ ok: true, state: { issues: [] } }), recentFacts: () => [],

    readSkillPending: async () => {
      pendingReads++;
      return { text: pendingText, sourceRefs: ["native:pending-budget"] };
    },
  });
  const tools = createFakeTools([], toolNames.map(name => echoBinding({ name, needsApproval: false })));
  const ports = { provider: parent, tools, permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: messages => {
      measurements.push(messages);
      return estimateMessagesTokens(messages);
    } }) };

  return { requests, measurements, parent, pendingReads: () => pendingReads, run: (contextTokenLimit: number) => runTurn(ports, {
    sessionId: "session:prompt-budget", turnId: "turn:prompt-budget", correlationId: "correlation:prompt-budget",
    model: "local-no-network", text: userText, budget: { contextTokenLimit },
  }) };
}

test("the exact PA messages sent to the provider are included in the final context measurement", async () => {
  const h = fixture();

  await h.run(100_000);
  assert.equal(h.requests.length, 1);
  const sent = h.requests[0]!;

  assert.match(sent.messages.map(message => message.content).join("\n"), new RegExp(pendingMarker));
  assert.deepEqual(h.measurements.at(-1), sent.messages,
    "the final gate must measure the PA system context, not only the undecorated history");
  assert.equal(sent.maxOutputTokens, undefined, "an omitted generation allowance remains omitted");
  assert.deepEqual(sent.tools.map(tool => tool.name), ["read_file"]);
});

test("an unprepared PA stream never changes messages or reads dynamic context", async () => {
  const h = fixture();
  const request: ProviderRequest = { attemptId: "unprepared", model: "local-no-network", messages: [{ role: "user", content: userText }], tools: [] };
  for await (const event of h.parent.stream(request, new AbortController().signal)) assert.ok(event.type === "stream_start" || event.type === "finish");
  assert.equal(h.pendingReads(), 0);
  assert.equal(h.requests[0], request);
  assert.deepEqual(h.requests[0]!.messages, request.messages);
});

test("a PA preparation snapshot survives history rebuilding without rereading its context", async () => {
  const h = fixture();
  const request: ProviderRequest = { attemptId: "snapshot", model: "local-no-network", messages: [{ role: "user", content: userText }], tools: [] };
  const signal = new AbortController().signal;
  const preparation = await h.parent.prepareRequest?.(request, signal);

  assert.ok(preparation);
  const first = preparation.apply(request);
  const rebuilt = preparation.apply({ ...request, messages: [{ role: "user", content: "The compacted original task is still active." }] });

  assert.equal(h.pendingReads(), 1);
  assert.equal(first.messages.at(-1), rebuilt.messages.at(-1), "the original immutable exposure object survives a gate rebuild");
  assert.equal(rebuilt.messages.filter(message => message.content.includes(pendingMarker)).length, 1);
  assert.equal(rebuilt.messages.some(message => message.content === userText), false);

  for await (const event of h.parent.stream(rebuilt, signal)) assert.ok(event.type === "stream_start" || event.type === "finish");

  assert.equal(h.pendingReads(), 1);
});

test("a partial collaboration catalog advertises its mounted inspector without inventing decision tools", async () => {
  const h = fixture(pendingMarker, ["collaboration_inspect"]);

  await h.run(100_000);
  assert.equal(h.requests.length, 1);
  const system = h.requests[0]!.messages.filter(message => message.role === "system").map(message => message.content).join("\n");

  assert.match(system, /\bcollaboration_inspect\b/);
  assert.doesNotMatch(system, /\bcollaboration_(?:decide|capability|resume|report|feedback)\b/);
  assert.doesNotMatch(system, /\b(?:spawn_agent|send_input|reconfigure_agent|report_progress)\b/);
});

test("a caller context ceiling is enforced after PA context is assembled", async () => {
  const h = fixture(`${pendingMarker} ${"genuine pending evidence ".repeat(120)}`);
  const limit = 1_000;

  await h.run(limit);

  for (const sent of h.requests) {
    const size = estimateMessagesTokens(sent.messages) + estimateToolSpecsTokens(sent.tools);
    assert.ok(size < limit, `the provider received ${size} estimated tokens beyond caller limit ${limit}`);
  }
});

test("a read_file-only PA request never advertises unavailable collaboration or dispatch tools", async () => {
  const h = fixture();

  await h.run(100_000);
  assert.equal(h.requests.length, 1);
  const system = h.requests[0]!.messages.filter(message => message.role === "system").map(message => message.content).join("\n");

  assert.doesNotMatch(system, /\bcollaboration_(?:inspect|decide|capability|resume|report|feedback)\b/);
  assert.doesNotMatch(system, /\b(?:spawn_agent|send_input|reconfigure_agent|report_progress)\b/);
  assert.match(system, /Personal Agent/);
  assert.match(system, new RegExp(pendingMarker), "read-only pending evidence remains available without inventing tools");
});
