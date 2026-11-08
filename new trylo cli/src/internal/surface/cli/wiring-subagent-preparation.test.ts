import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import type { ProviderMessage, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ExperienceReceiptInput } from "../../learning/agent/subsystems/collaboration/experience/store.js";
import { createPersonalAgentProvider } from "./collaboration-parent-context.js";
import { compactionWiring } from "./compaction-wiring.js";
import { buildSubagentPorts } from "./wiring-subagent.js";

const practice = "Carry actual source paths and unresolved assumptions into the receiver handoff.";
const versionId = "local-fixture:parent-trial";

function teamParent(t: TestContext, options: { readonly pendingText?: string; readonly cancelDuringPreparation?: AbortController } = {}) {
  const requests: ProviderRequest[] = [], measurements: (readonly ProviderMessage[])[] = [];
  const loaded: ExperienceReceiptInput[] = [], dispatched: ExperienceReceiptInput[] = [];
  let reads = 0;
  const raw: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "stream_start", providerId: "local-no-network", model: request.model, warnings: [] };
    yield { type: "text_delta", blockId: "answer", text: "Finished the local request." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const parent = createPersonalAgentProvider({ provider: raw, scope: "local:team-preparation", turnId: "local:parent-turn",
    now: () => "2026-11-08T00:00:00.000Z", warn: reason => { throw new Error(reason); },
    experience: {
      async prepareExperience() { return { ok: true, text: practice, versionIds: [versionId], selectionId: "local:selection" }; },

      async recordLoad(input) {
        loaded.push(input);
        return { ok: true };
      },

      async recordDispatch(input) {
        dispatched.push(input);
        return { ok: true };
      },
    }, inspect: async () => ({ ok: true, state: { issues: [] }, resources: {} }), recentFacts: () => [],

    readSkillPending: async signal => {
      reads++;
      options.cancelDuringPreparation?.abort();
      signal.throwIfAborted();
      return { text: options.pendingText ?? "LOCAL_PENDING_PREPARATION", sourceRefs: ["local:pending-source"] };
    },
  });
  const tools = createFakeTools([], []), permission = createFakePermission("approved");
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, parentProvider: parent, childProvider: raw,
    model: "local-no-network", permission, callerMessages: undefined, team: { runId: "local-team-preparation",
      members: ["person", "worker"].map(role => ({ memberId: role, baseRole: role, displayName: role,
        role: { name: role, description: role } })) } });

  t.after(async () => { await built.runtime.cancelAll(); });
  const ports = { provider: built.provider, tools, permission, profile: emptyProfileLoader(),
    compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: messages => {
      measurements.push(messages);
      return messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0);
    } }) };

  return { requests, measurements, loaded, dispatched, reads: () => reads,
    run: (contextTokenLimit: number) => runTurn(ports, { sessionId: "local:team-parent", turnId: "local:parent-turn", correlationId: "local:test",
      text: "Complete this local composition check.", model: "local-no-network", budget: { contextTokenLimit },
      ...(options.cancelDuringPreparation === undefined ? {} : { cancelSignal: options.cancelDuringPreparation.signal }) }) };
}

test("the team parent prepares PA context once before measurement and records the same dispatched trial", async t => {
  const h = teamParent(t);
  const result = await h.run(100_000);

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(h.reads(), 1);
  assert.equal(h.requests.length, 1);
  const sent = h.requests[0]!;

  assert.equal(sent.messages.filter(message => message.content.includes(practice)).length, 1);
  assert.ok(sent.messages.some(message => message.content.includes("LOCAL_PENDING_PREPARATION")));
  assert.deepEqual(h.measurements.at(-1), sent.messages, "quote and send must use the same prepared snapshot");
  assert.equal(sent.maxOutputTokens, undefined);
  assert.equal(h.loaded.length, 1);
  assert.equal(h.dispatched.length, 1);
  assert.deepEqual(h.dispatched[0]!.versionIds, [versionId]);
  assert.equal(h.dispatched[0]!.boundary.requestId, sent.attemptId);
});

test("a team parent cannot send prepared context above the caller ceiling or claim its trial was dispatched", async t => {
  const h = teamParent(t, { pendingText: "actual pending detail ".repeat(300) });
  const result = await h.run(1_000);

  assert.equal(h.reads(), 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.dispatched.length, 0);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "context_limit"));
});

test("cancelling the team parent's preparation reaches the original signal and sends no request or dispatch receipt", async t => {
  const cancellation = new AbortController();
  const h = teamParent(t, { cancelDuringPreparation: cancellation });
  const result = await h.run(100_000);

  assert.equal(h.reads(), 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.dispatched.length, 0);
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
});
