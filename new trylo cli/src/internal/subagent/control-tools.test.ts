import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Message } from "../contract/execution.js";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../ports/provider.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolPort } from "../ports/tools.js";
import {
  CLOSE_AGENT_TOOL,
  SPAWN_AGENT_BINDING,
  RESUME_AGENT_TOOL,
  SEND_INPUT_TOOL,
  SPAWN_AGENT_TOOL,
  WAIT_AGENT_TOOL,
} from "./control-bindings.js";
import { createSubagentControlTool } from "./control-tools.js";
import type { SubagentRole } from "./role.js";
import { SubagentRuntime } from "./runtime.js";

/**
 * What the control plane has to make true (WP22.2 / C43, L29).
 *
 * The evidence is the **number of provider requests**: one subagent turn is
 * one request, so "the parent gave it another instruction and it acted on it"
 * is only observable as a second request. A test that asserted on ids or tool
 * results would pass against an implementation that spawned and forgot.
 */

function noTools(): ToolPort {
  return {
    snapshot: () => [],
    execute: async () => ({ outcome: "result", value: {}, output: "ok", truncated: false }),
    cancel: async () => {},
  };
}

function scriptedProvider(answers: ReadonlyArray<string>): {
  readonly port: ProviderPort;
  readonly requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  let index = 0;
  return {
    requests,
    port: {
      async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        requests.push(request);
        const text = answers[index] ?? `answer-${index}`;
        index += 1;
        const blockId = `blk-${index}`;
        yield { type: "text_start", blockId };
        yield { type: "text_delta", blockId, text };
        yield { type: "text_end", blockId };
        yield { type: "usage", usage: emptyUsage() };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  };
}

type Harness = ReturnType<typeof harness>;

const runtimes: SubagentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cancelAll();
});

function harness(
  options: {
    readonly parentMessages?: ReadonlyArray<Message>;
    readonly roles?: ReadonlyArray<SubagentRole>;
    readonly allowedTools?: ReadonlyArray<string>;
  } = {},
) {
  const provider = scriptedProvider(["round one", "round two", "round three", "round four"]);
  let counter = 0;
  const runtime = new SubagentRuntime({
    tools: noTools(),
    idGenerator: (name) => `${name}-${++counter}`,
  });
  runtimes.push(runtime);
  const control = createSubagentControlTool({
    runtime,
    provider: provider.port,
    permission: {
      request: async () => {
        throw new Error("this subagent is read-only; no permission was expected");
      },
      awaitDecision: async () => {
        throw new Error("no decision was expected");
      },
    },
    allowedTools: options.allowedTools ?? ["read_file"],
    ...(options.parentMessages === undefined
      ? {}
      : { parentMessages: options.parentMessages }),
    ...(options.roles === undefined ? {} : { roles: options.roles }),
  });
  const call = async (name: string, args: JsonObject): Promise<{ code?: string; value?: JsonObject }> => {
    const outcome = await control.execute(
      { toolCallId: `tc-${name}-${++counter}`, name, arguments: args },
      new AbortController().signal,
    );
    return outcome.outcome === "result"
      ? { value: outcome.value }
      : { code: outcome.outcome === "error" ? outcome.code : outcome.outcome };
  };
  return { provider, control, call };
}

const agentIdOf = (value: { value?: JsonObject } | undefined): string => {
  const id = value?.value?.["agent_id"];
  assert.equal(typeof id, "string", "expected an agent_id");
  return id as string;
};

/** Lets the spawned worker's first round get going before the next move. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a spawned agent keeps running instead of finishing, and closing it ends the run", async () => {
  const { call, provider } = harness();
  const agentId = agentIdOf(await call(SPAWN_AGENT_TOOL, { message: "look around" }));
  await settle();

  const before = await call(WAIT_AGENT_TOOL, { targets: [agentId], timeout_ms: 10 });
  // A round answer is available while the lifecycle stays open for follow-up.
  assert.equal(before.value?.["timed_out"], false);
  const report = (before.value?.["results"] as JsonObject)[agentId] as JsonObject;
  assert.equal(report["output"], "round one");
  assert.equal(report["phase"], "awaiting_input");
  assert.equal(report["status"], "running");
  assert.equal(provider.requests.length, 1, "the first round ran");

  await call(CLOSE_AGENT_TOOL, { target: agentId });
  const after = await call(WAIT_AGENT_TOOL, { targets: [agentId], timeout_ms: 500 });
  assert.equal((after.value?.["status"] as Record<string, string>)[agentId], "completed");
});

test("send_input makes the same agent run another round", async () => {
  const { call, provider } = harness();
  const agentId = agentIdOf(await call(SPAWN_AGENT_TOOL, { message: "first" }));
  await settle();

  const queued = await call(SEND_INPUT_TOOL, { target: agentId, message: "second" });
  assert.equal(typeof queued.value?.["submission_id"], "string");
  await settle();
  await call(CLOSE_AGENT_TOOL, { target: agentId });

  assert.equal(provider.requests.length, 2, "one agent, two instructions, two provider rounds");
  // The second round has to carry the first one's answer, or "continue" is a lie.
  const second = provider.requests[1];
  const carried = (second?.messages ?? []).map((m) => m.content).join(" ");
  assert.match(carried, /round one/, "the continuation must carry what came before");
  assert.match(carried, /second/, "and the new instruction");
});

test("fork_context hands the parent conversation to the child", async () => {
  const { call, provider } = harness({
    parentMessages: [
      { role: "user", content: "the parent said this" },
      { role: "assistant", content: "the parent replied that" },
    ],
  });
  await call(SPAWN_AGENT_TOOL, { message: "carry on", fork_context: true });
  await settle();

  const carried = (provider.requests[0]?.messages ?? []).map((m) => m.content).join(" ");
  assert.match(carried, /the parent said this/);
  assert.match(carried, /the parent replied that/);
});

test("fork_context with no parent conversation is refused rather than silently ignored", async () => {
  const { call } = harness();
  const outcome = await call(SPAWN_AGENT_TOOL, { message: "carry on", fork_context: true });
  assert.equal(outcome.code, "fork_context_unavailable");
});

test("an unknown agent id is refused by name, not answered optimistically", async () => {
  const { call } = harness();
  assert.equal((await call(SEND_INPUT_TOOL, { target: "nope", message: "x" })).code, "unknown_agent");
  assert.equal((await call(CLOSE_AGENT_TOOL, { target: "nope" })).code, "unknown_agent");
  assert.equal((await call(RESUME_AGENT_TOOL, { target: "nope" })).code, "unknown_agent");
});

test("a closed agent takes no more input", async () => {
  const { call } = harness();
  const agentId = agentIdOf(await call(SPAWN_AGENT_TOOL, { message: "first" }));
  await settle();
  await call(CLOSE_AGENT_TOOL, { target: agentId });

  const outcome = await call(SEND_INPUT_TOOL, { target: agentId, message: "more" });
  assert.equal(outcome.code, "agent_closed");
});

test("resume starts a new agent that carries the finished one's transcript", async () => {
  const { call, provider } = harness();
  const agentId = agentIdOf(await call(SPAWN_AGENT_TOOL, { message: "remember alpha" }));
  await settle();
  await call(CLOSE_AGENT_TOOL, { target: agentId });
  await call(WAIT_AGENT_TOOL, { targets: [agentId], timeout_ms: 500 });
  await settle();

  const resumed = agentIdOf(await call(RESUME_AGENT_TOOL, { target: agentId }));
  assert.notEqual(resumed, agentId, "resume must be a new run, not the same one reopened");
  await settle();

  const carried = (provider.requests[provider.requests.length - 1]?.messages ?? [])
    .map((m) => m.content)
    .join(" ");
  assert.match(carried, /round one/, "the resumed agent must know what came before");
});

test("resume refuses an agent that is still running", async () => {
  const { call } = harness();
  const agentId = agentIdOf(await call(SPAWN_AGENT_TOOL, { message: "still working" }));
  await settle();

  assert.equal((await call(RESUME_AGENT_TOOL, { target: agentId })).code, "agent_still_running");
  await call(CLOSE_AGENT_TOOL, { target: agentId });
});

test("a forced close reports cancelled rather than completed", async () => {
  const { call } = harness();
  const agentId = agentIdOf(await call(SPAWN_AGENT_TOOL, { message: "long job" }));
  await settle();

  const closed = await call(CLOSE_AGENT_TOOL, { target: agentId, force: true });
  assert.equal(closed.value?.["forced"], true);
  const after = await call(WAIT_AGENT_TOOL, { targets: [agentId], timeout_ms: 500 });
  // A run cut short is not a run that finished. Reporting it as `completed`
  // would be the one lie the status field exists to prevent.
  assert.equal((after.value?.["status"] as Record<string, string>)[agentId], "cancelled");
});

test("a role narrows the child's tools and reports what it could not have", async () => {
  const { call } = harness({
    allowedTools: ["read_file", "search_text"],
    roles: [
      { name: "reader", description: "only reads", allowedTools: ["read_file", "run_shell"] },
    ],
  });

  const outcome = await call(SPAWN_AGENT_TOOL, { message: "go", agent_type: "reader" });
  assert.equal(outcome.value?.["role"], "reader");
  assert.deepEqual(outcome.value?.["allowed_tools"], ["read_file"]);
  // The role asked for a tool this run cannot grant. It is named in the result
  // rather than swallowed: a role file that silently asks for too much is how
  // a subagent ends up mysteriously unable to do its job.
  assert.deepEqual(outcome.value?.["withheld"], ["run_shell"]);
});

test("the spawn tool tells the model which roles this run has", () => {
  const { control } = harness({ roles: [{ name: "reader", description: "only reads" }] });
  const spawn = control.snapshot().find((binding) => binding.name === SPAWN_AGENT_TOOL);
  const properties = (
    spawn?.parameters as { readonly properties: Record<string, { readonly enum?: ReadonlyArray<string> }> }
  ).properties;
  assert.deepEqual(properties["agent_type"]?.enum, ["reader"]);
  assert.match(spawn?.description ?? "", /reader: only reads/);
});

test("with no roles configured the spawn tool reads exactly as it did before", () => {
  const { control } = harness();
  const spawn = control.snapshot().find((binding) => binding.name === SPAWN_AGENT_TOOL);
  assert.equal(spawn?.description, SPAWN_AGENT_BINDING.description);
});

test("every control tool is advertised to the model", async () => {
  const { control } = harness();
  assert.deepEqual(
    control.snapshot().map((binding) => binding.name).sort(),
    [CLOSE_AGENT_TOOL, RESUME_AGENT_TOOL, SEND_INPUT_TOOL, SPAWN_AGENT_TOOL, WAIT_AGENT_TOOL].sort(),
  );
});

/** Type-only guard: the harness must stay callable from the tests above. */
export type { Harness };
