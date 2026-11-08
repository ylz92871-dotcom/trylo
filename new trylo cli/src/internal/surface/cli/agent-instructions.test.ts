import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import type { ProviderRequest } from "../../ports/provider.js";
import type { TurnHostInput } from "./host.js";
import { budgetOf, runRecordedTurn } from "./turn-execution.js";
import { turnWiringInput } from "./turn-wiring-input.js";

const INPUT: TurnHostInput = {
  text: "Repair the bug and verify it", sessionId: "s", turnId: "t", correlationId: "c",
  workspaceRoot: "/ws", workspaceId: "w", checkpointRoot: "/undo", providerId: "fixture",
  model: "m", endpoint: "", apiKey: undefined, permission: createFakePermission("approved"),
  format: "stream-json", sink: { stdout: () => undefined, stderr: () => undefined }, now: () => 0,
};
const PROJECT = { role: "system" as const, content: "Keep the public API unchanged." };

async function requestsFor(input: TurnHostInput, count = 1): Promise<readonly ProviderRequest[]> {
  const requests: ProviderRequest[] = [];

  await runRecordedTurn({
    profile: emptyProfileLoader(), permission: input.permission, tools: createFakeTools([], []),
    provider: { async *stream(request) {
      requests.push(request);
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: requests.length < count };
    } },
  }, input, budgetOf(input), undefined, () => undefined);

  return requests;
}

test("every CLI iteration receives the default task guidance alongside project rules", async () => {
  const projectContext = { messages: [PROJECT], sources: [], problems: [] };
  const requests = await requestsFor({ ...INPUT, projectContext }, 3);

  assert.equal(requests.length, 3);

  for (const request of requests) {
    const instructions = request.messages.filter(message => message.role === "system");
    assert.equal(instructions.filter(message => message.content.startsWith("You are Trylo, a coding agent")).length, 1);
    assert.ok(instructions.some(message => message.content === PROJECT.content));
  }

  assert.deepEqual(projectContext.messages, [PROJECT]);
});

test("delegation wiring receives the same default and project instruction basis", () => {
  const wired = turnWiringInput({ ...INPUT, projectContext: { messages: [PROJECT], sources: [], problems: [] } }, undefined, undefined, undefined);
  assert.ok(wired.callerMessages?.some(message => message.content.startsWith("You are Trylo, a coding agent")));
  assert.ok(wired.callerMessages?.some(message => message.content === PROJECT.content));
});

test("an explicit replacement still replaces default and project system seeds", async () => {
  const [request] = await requestsFor({ ...INPUT, maxIterations: 2, maxTokens: 5000, projectContext: { messages: [PROJECT], sources: [], problems: [] },
    systemPrompt: { mode: "replace", text: "Answer as the caller requested." },
  });
  assert.deepEqual(request!.messages.filter(message => message.role === "system").map(message => message.content), ["Answer as the caller requested."]);
});

test("appended caller instructions retain the default task guidance exactly once", async () => {
  const [request] = await requestsFor({ ...INPUT, systemPromptAppend: "Use concise Chinese progress updates." });
  const instructions = request!.messages.filter(message => message.role === "system");
  assert.equal(instructions.filter(message => message.content.startsWith("You are Trylo, a coding agent")).length, 1);
  assert.ok(instructions.some(message => message.content === "Use concise Chinese progress updates."));
});

test("multi-step requests carry public progress guidance before tools and after findings", async () => {
  for (const request of await requestsFor({ ...INPUT, systemPromptAppend: "Use Chinese." }, 2)) {
    const seed = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(seed, /before the first tool/i);
    assert.match(seed, /meaningful findings/i);
    assert.match(seed, /simple questions.*directly/i);
    assert.match(seed, /without private reasoning/i);
  }
});

test("multi-deliverable CLI requests carry the requirements checklist and final delivery audit on follow-up requests", async () => {
  const text = "Repair a calculation, generate its output, write a change report, then run the validator.";
  for (const request of await requestsFor({ ...INPUT, text }, 2)) {
    const instructions = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(instructions, /Before acting on a multi-step or multi-deliverable request/);
    assert.match(instructions, /Before your final response, compare the original user request/);
    assert.ok(request.messages.some(message => message.role === "user" && message.content === text));
  }
});

test("CLI requests state their actual whole-turn limits without inventing limits for absent budgets", async () => {
  for (const request of await requestsFor({ ...INPUT, maxIterations: 6, maxTokens: 5000 }, 2)) {
    const seed = request.messages.find(message => message.content.startsWith("You are Trylo, a coding agent"))!.content;
    assert.match(seed, /Maximum provider requests: 6/);
    assert.match(seed, /Maximum total output tokens: 5000/);
    assert.match(seed, /including retries and final delivery/);
  }

  const [unbounded] = await requestsFor(INPUT);

  assert.equal(unbounded!.messages.some(message => message.content.includes("Maximum total output tokens:")), false);
});

test("continued CLI requests recover missing checklist state instead of resetting completed work", async () => {
  for (const request of await requestsFor({ ...INPUT, text: "Continue the existing repair." }, 2)) {
    const instructions = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(instructions, /current state is missing from context.*todo_read or task_list/i);
    assert.match(instructions, /compaction and tool replies do not reset completed steps/i);
    assert.match(instructions, /update that checklist as results are observed/i);
    assert.match(instructions, /session journals only for a concrete missing fact/i);
    assert.match(instructions, /do not create a chain of probes/i);
  }
});

test("assembled repair guidance connects sufficient evidence to a focused repair and reuses diagnostics", async () => {
  for (const request of await requestsFor(INPUT, 2)) {
    const instructions = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(instructions, /reuse an existing verification script/i);
    assert.match(instructions, /specific missing observation/i);
    assert.match(instructions, /do not create parallel near-duplicate harnesses/i);
    assert.match(instructions, /once available evidence supports a focused repair, make that repair and validate it/i);
  }
});

test("assembled validation guidance reuses declared tooling when a launcher or dependency cannot start", async () => {
  const [request] = await requestsFor(INPUT);
  const instructions = request!.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.match(instructions, /reported launcher or dependency mismatch/i);
  assert.match(instructions, /project's declared and installed toolchain before adding or changing dependencies/i);
});

test("assembled checklist guidance tracks genuinely required derived outputs without inventing deliverables", async () => {
  const [request] = await requestsFor({ ...INPUT, projectContext: { messages: [PROJECT], sources: [], problems: [] } });
  const instructions = request!.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.match(instructions, /when the user or project contract actually requires them/i);
  assert.match(instructions, /do not invent deliverables/i);
  assert.ok(request!.messages.some(message => message.content === PROJECT.content));
});
