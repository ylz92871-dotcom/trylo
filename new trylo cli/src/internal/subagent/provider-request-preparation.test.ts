import assert from "node:assert/strict";
import test from "node:test";
import { withImageReferences } from "../adapters/media/image-reference-provider.js";
import { emptyProfileLoader } from "../loop/fakes.js";
import type { ProviderPort, ProviderRequest, ProviderRequestPreparation } from "../ports/provider.js";
import { createGovernedChildProvider } from "./child-provider.js";
import { createChildProviderSession } from "./child-provider-session.js";
import { SubagentGovernanceError } from "./governance.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import type { SubagentContext } from "./types.js";

const MARKER = "SYNTHETIC_PREPARED_VIEW_ONLY";
const signal = new AbortController().signal;
const request = (scope: string | undefined): ProviderRequest => ({
  attemptId: "attempt:" + (scope ?? "unscoped"), model: "synthetic-preparation", tools: [],
  ...(scope === undefined ? {} : { continuationScope: scope }),
  messages: [{ role: "user", content: "Continue from the public history." }],
});
const closed = (error: unknown): boolean => error instanceof SubagentGovernanceError && error.code === "agent_closed";

function context(charges: number[][] = []): SubagentContext {
  return {
    subagentId: "member:preparation", name: "preparation-boundary",
    lineage: { parentAgentId: "parent", rootAttemptId: "attempt:parent" }, signal,
    tools: { snapshot: () => [], execute: async () => ({ outcome: "cancelled" }), cancel: async () => {} },
    reportProgress: () => {}, recordUsage: (input, output) => { charges.push([input, output]); },
  };
}

function preparationFixture() {
  const preparations: ProviderRequest[] = [], applications: ProviderRequest[] = [], sends: ProviderRequest[] = [];
  const signals: AbortSignal[] = [];
  let parentPreparations = 0;
  const transport: ProviderPort = {
    async prepareRequest(input, currentSignal) {
      preparations.push(structuredClone(input)); signals.push(currentSignal);
      return { apply: current => {
        applications.push(structuredClone(current));
        return { ...current, messages: [...current.messages, { role: "system", content: MARKER }] };
      } };
    },
    async *stream(input) {
      sends.push(structuredClone(input));
      yield { type: "stream_start", providerId: "synthetic-only", model: input.model, warnings: [] };
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 7, outputTokens: 3, totalTokens: 10,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: "Synthetic member completed." };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const source: ProviderPort = {
    fork: () => transport,
    async prepareRequest() {
      parentPreparations++;
      throw new Error("A child must prepare through its fork-owned transport.");
    },
    async *stream() { throw new Error("A child must send through its fork-owned transport."); },
  };
  return { source, transport, preparations, applications, sends, signals, parentPreparations: () => parentPreparations };
}

async function prepareAndSend(provider: ProviderPort, input: ProviderRequest): Promise<ProviderRequest> {
  assert.ok(provider.prepareRequest, "the wrapper must preserve the existing optional preparation capability");
  const snapshot = await provider.prepareRequest(input, signal);
  const prepared = snapshot.apply(input);
  for await (const _event of provider.stream(prepared, signal)) { /* Local synthetic transport only. */ }
  return prepared;
}

test("text-only image wrapper preserves preparation and sends the prepared view without image reads", async () => {
  const fixture = preparationFixture(), input = request("image-scope");
  const provider = withImageReferences(fixture.transport, "C:/synthetic-unused-workspace");
  const prepared = await prepareAndSend(provider, input);

  assert.equal(fixture.preparations.length, 1);
  assert.equal(fixture.signals[0], signal);
  assert.deepEqual(fixture.sends, [prepared]);
  assert.equal(prepared.messages.filter(message => message.content === MARKER).length, 1);
  assert.equal(input.messages.some(message => message.content === MARKER), false);
});

test("governed child preparation is not usage and the actual response is still charged once", async () => {
  const fixture = preparationFixture(), charges: number[][] = [], input = request("governed-scope");
  const provider = createGovernedChildProvider(fixture.transport, context(charges));
  assert.ok(provider.prepareRequest);
  const snapshot = await provider.prepareRequest(input, signal);
  const prepared = snapshot.apply(input);
  assert.deepEqual(charges, [], "preparing or applying a public view must not charge a response");

  for await (const _event of provider.stream(prepared, signal)) { /* Local synthetic transport only. */ }

  assert.deepEqual(charges, [[7, 3]]);
  assert.deepEqual(fixture.sends, [prepared]);
  assert.equal(fixture.preparations.length, 1);
});

test("wrappers do not invent a preparation capability when the underlying provider has none", () => {
  const provider: ProviderPort = { async *stream() {} };
  const session = createChildProviderSession(provider);

  assert.equal(withImageReferences(provider, "C:/synthetic-unused-workspace").prepareRequest, undefined);
  assert.equal(createGovernedChildProvider(provider, context()).prepareRequest, undefined);
  assert.equal(session.provider.prepareRequest, undefined);
  session.close();
});

test("retained child previews use the fork owner and do not lock the first actual task scope", async () => {
  const fixture = preparationFixture(), session = createChildProviderSession(fixture.source);
  const a = request("preview:A"), b = request("actual:B");
  assert.ok(session.provider.prepareRequest);
  const preview = await session.provider.prepareRequest(a, signal);
  preview.apply(a);
  const prepared = await session.provider.prepareRequest(b, signal);
  for await (const _event of session.provider.stream(prepared.apply(b), signal)) { /* Local transport only. */ }

  assert.deepEqual(fixture.preparations.map(input => input.continuationScope), ["preview:A", "actual:B"]);
  assert.equal(fixture.sends[0]?.continuationScope, "actual:B");
  assert.equal(fixture.parentPreparations(), 0);
  assert.equal(a.continuationScope, "preview:A");
  session.close();
});

test("a prepared child snapshot applies to the current rebuilt request rather than its preview base", async () => {
  const fixture = preparationFixture(), session = createChildProviderSession(fixture.source);
  const a = request("preview:A"), b = { ...request("actual:B"), messages: [{ role: "user" as const, content: "Rebuilt after compaction." }] };
  assert.ok(session.provider.prepareRequest);
  const snapshot = await session.provider.prepareRequest(a, signal);
  const prepared = snapshot.apply(b);
  for await (const _event of session.provider.stream(prepared, signal)) { /* Local transport only. */ }

  assert.equal(fixture.applications[0]?.continuationScope, "actual:B");
  assert.equal(fixture.applications[0]?.messages[0]?.content, "Rebuilt after compaction.");
  assert.equal(fixture.sends[0]?.continuationScope, "actual:B");
  assert.equal(a.messages[0]?.content, "Continue from the public history.");
  session.close();
});

test("later child prepare and returned apply use the same retained task scope as stream", async () => {
  const fixture = preparationFixture(), session = createChildProviderSession(fixture.source);
  await prepareAndSend(session.provider, request("task:B"));
  assert.ok(session.provider.prepareRequest);
  const current = request("physical:A");
  const snapshot = await session.provider.prepareRequest(current, signal);
  const prepared = snapshot.apply(request("physical:C"));
  for await (const _event of session.provider.stream(prepared, signal)) { /* Local transport only. */ }

  assert.deepEqual(fixture.preparations.map(input => input.continuationScope), ["task:B", "task:B"]);
  assert.deepEqual(fixture.applications.map(input => input.continuationScope), ["task:B", "task:B"]);
  assert.deepEqual(fixture.sends.map(input => input.continuationScope), ["task:B", "task:B"]);
  assert.equal(current.continuationScope, "physical:A");
  session.close();
});

test("an empty retained child scope remains a defined scope during preparation and sending", async () => {
  const fixture = preparationFixture(), session = createChildProviderSession(fixture.source);
  await prepareAndSend(session.provider, request(""));
  await prepareAndSend(session.provider, request("later-physical-scope"));

  assert.deepEqual(fixture.preparations.map(input => input.continuationScope), ["", ""]);
  assert.deepEqual(fixture.applications.map(input => input.continuationScope), ["", ""]);
  assert.deepEqual(fixture.sends.map(input => input.continuationScope), ["", ""]);
  session.close();
});

function scopeRewritingFixture() {
  const preparations: ProviderRequest[] = [], applications: ProviderRequest[] = [], sends: ProviderRequest[] = [];
  const transport: ProviderPort = {
    async prepareRequest(input) {
      preparations.push(input);
      return { apply: current => {
        applications.push(current);
        return { ...current, continuationScope: "scope:C" };
      } };
    },
    async *stream(input) {
      sends.push(input);
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const session = createChildProviderSession({ fork: () => transport, async *stream() {} });
  return { session, preparations, applications, sends };
}

test("a locked child maps an upstream apply scope rewrite back to the actual retained send scope", async () => {
  const fixture = scopeRewritingFixture(), provider = fixture.session.provider;
  for await (const _event of provider.stream(request("task:B"), signal)) { /* Establish the actual task scope. */ }
  assert.ok(provider.prepareRequest);
  const input = request("physical:A"), snapshot = await provider.prepareRequest(input, signal);
  const prepared = snapshot.apply(input);
  for await (const _event of provider.stream(prepared, signal)) { /* Local transport only. */ }

  assert.equal(fixture.preparations[0]?.continuationScope, "task:B");
  assert.equal(fixture.applications[0]?.continuationScope, "task:B");
  assert.equal(prepared.continuationScope, "task:B", "the budgeted view must use the same scope as stream");
  assert.deepEqual(fixture.sends.map(value => value.continuationScope), ["task:B", "task:B"]);
  assert.equal(input.continuationScope, "physical:A");
  fixture.session.close();
});

test("an unlocked child preserves an upstream apply scope rewrite until the first actual stream locks it", async () => {
  const fixture = scopeRewritingFixture(), provider = fixture.session.provider;
  assert.ok(provider.prepareRequest);
  const snapshot = await provider.prepareRequest(request("preview:A"), signal);
  const prepared = snapshot.apply(request("physical:B"));
  assert.equal(prepared.continuationScope, "scope:C");
  for await (const _event of provider.stream(prepared, signal)) { /* Only sending may lock the task scope. */ }
  await prepareAndSend(provider, request("later:D"));

  assert.deepEqual(fixture.preparations.map(value => value.continuationScope), ["preview:A", "scope:C"]);
  assert.deepEqual(fixture.applications.map(value => value.continuationScope), ["physical:B", "scope:C"]);
  assert.deepEqual(fixture.sends.map(value => value.continuationScope), ["scope:C", "scope:C"]);
  fixture.session.close();
});

test("a closed retained child rejects new preparation and held apply before reaching the upstream owner", async () => {
  const fixture = preparationFixture(), session = createChildProviderSession(fixture.source), input = request("closed");
  assert.ok(session.provider.prepareRequest);
  const snapshot = await session.provider.prepareRequest(input, signal);
  session.close();

  await assert.rejects(session.provider.prepareRequest(input, signal), closed);
  assert.throws(() => snapshot.apply(input), closed);
  assert.equal(fixture.preparations.length, 1);
  assert.equal(fixture.applications.length, 0);
  assert.equal(fixture.sends.length, 0);
});

test("closing a retained child during asynchronous preparation refuses the completed snapshot", async () => {
  let entered!: () => void, release!: (snapshot: ProviderRequestPreparation) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<ProviderRequestPreparation>(resolve => { release = resolve; });
  let preparations = 0, applications = 0, sends = 0;
  const transport: ProviderPort = {
    async prepareRequest() { preparations++; entered(); return pending; },
    async *stream() { sends++; },
  };
  const session = createChildProviderSession({ fork: () => transport, async *stream() {} });
  assert.ok(session.provider.prepareRequest);
  const result = session.provider.prepareRequest(request("pending"), signal);
  await started;
  session.close();
  release({ apply: input => { applications++; return input; } });

  await assert.rejects(result, closed);
  assert.equal(preparations, 1);
  assert.equal(applications, 0);
  assert.equal(sends, 0);
});

const permission = {
  request: async () => { throw new Error("No business tool or approval is expected."); },
  awaitDecision: async () => { throw new Error("No business tool or approval is expected."); },
};

test("interactive child callback boundary and governed session deliver the actual prepared request", async () => {
  const fixture = preparationFixture(), charges: number[][] = [], dispatched: ProviderRequest[] = [];
  const worker = createInteractiveChildWorker({ provider: fixture.source, permission, profile: emptyProfileLoader(),
    message: "Complete the synthetic member task.", onRequestDispatched: async (_round, _id, input) => { dispatched.push(input); } });
  const result = await worker(context(charges));

  assert.equal(result.status, "completed");
  assert.equal(fixture.preparations.length, 1);
  assert.equal(fixture.applications.length, 1);
  assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0]?.messages.filter(message => message.content === MARKER).length, 1);
  assert.deepEqual(dispatched, fixture.sends);
  assert.deepEqual(charges, [[7, 3]]);
  assert.equal(fixture.parentPreparations(), 0);
});

test("interactive child callback boundary keeps legacy providers without preparation usable", async () => {
  const fixture = preparationFixture(), dispatched: ProviderRequest[] = [];
  const legacy: ProviderPort = { stream: fixture.transport.stream };
  const worker = createInteractiveChildWorker({ provider: legacy, permission, profile: emptyProfileLoader(),
    message: "Complete the synthetic legacy task.", onRequestDispatched: async (_round, _id, input) => { dispatched.push(input); } });
  const result = await worker(context());

  assert.equal(result.status, "completed");
  assert.equal(fixture.preparations.length, 0);
  assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0]?.messages.some(message => message.content === MARKER), false);
  assert.deepEqual(dispatched, fixture.sends);
});
