import test from "node:test";
import assert from "node:assert/strict";
import { runTurn } from "../../loop/runner.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { createDenyAllPermission } from "./permission.js";
import { wirePorts, type WiringInput } from "./wiring.js";

function pending() {
  let calls = 0;
  const tools: ToolPort = { snapshot: () => [{ name: "skill_proposals", sideEffect: "read_only", needsApproval: false,
    description: "Read the original pending skill proposal", parameters: { type: "object" }, timeoutMs: 1000,
    outputLimits: { maxBytes: 32000, maxLines: 1000 } }],
  async execute() { calls++;
  return { outcome: "result", value: { kind: "skill_pending_review_request" },
    output: '{"kind":"skill_pending_review_request"}', truncated: false }; }, cancel: async () => {} };

  return { tools, readSkillPending: async () => undefined, calls: () => calls };
}

function setup(overrides: Partial<WiringInput> = {}) {
  const requests: ProviderRequest[] = [], review = pending();
  const provider: ProviderPort = { async *stream(request) { requests.push(request);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const wiring = wirePorts({ providerId: "fixture", model: "fixture-model", endpoint: "", apiKey: undefined,
    workspaceRoot: process.cwd(), permission: createDenyAllPermission(), providerGuard: () => provider,
    subagent: { enabled: true }, skillPending: review, ...overrides });

  assert.equal("code" in wiring, false);
  if ("code" in wiring) throw new Error(wiring.detail);

  return { wiring, requests, review };
}

test("normal parent exposes the original review result; an actual forked worker receives neither review tool nor parent tool instructions", async () => {
  const { wiring, requests, review } = setup();
  try {
    assert.ok(wiring.ports.tools.snapshot().some(tool => tool.name === "skill_proposals"));
    assert.equal(wiring.ports.sandbox?.evaluate({ toolCallId: "review", name: "skill_proposals", arguments: {} }).ok, true);
    await runTurn(wiring.ports, { sessionId: "parent", turnId: "normal", correlationId: "root", text: "Ordinary user task", model: "fixture-model" });
    const outcome = await wiring.ports.tools.execute({ toolCallId: "request-review", name: "skill_proposals", arguments: {} }, new AbortController().signal);

    assert.equal(outcome.outcome, "result");
    assert.equal(review.calls(), 1);

    if (outcome.outcome === "result") assert.equal(JSON.parse(outcome.output).kind, "skill_pending_review_request");

    const spawn = await wiring.ports.tools.execute({ toolCallId: "spawn", name: "spawn_agent",
      arguments: { message: "Independent worker task", fork_context: true } }, new AbortController().signal);

    assert.equal(spawn.outcome, "result");
    if (spawn.outcome !== "result") return;

    const id = String(spawn.value.agent_id);

    await wiring.ports.tools.execute({ toolCallId: "wait", name: "wait_agent", arguments: { targets: [id], timeout_ms: 1000 } }, new AbortController().signal);
    assert.ok(requests.length >= 2);
    const child = requests.at(-1)!;

    assert.ok(!child.tools.some(tool => tool.name === "skill_proposals"));
    assert.ok(!child.messages.some(message => message.role === "system" && message.content.startsWith("Available tools this run:")
      && message.content.includes("skill_proposals")));
    assert.equal(review.calls(), 1);
  } finally { await wiring.close(); }
});

test("an explicit parent tool ceiling still excludes review", async () => {
  const { wiring } = setup({ toolSelectionCeiling: ["read_file"] });
  try { assert.ok(!wiring.ports.tools.snapshot().some(tool => tool.name === "skill_proposals")); }
  finally { await wiring.close(); }
});

test("the original permission owner can deny the read-only review port", async () => {
  const permission = createDenyAllPermission();
  const { wiring, review } = setup({ permission: { ...permission, isDenied: name => name === "skill_proposals" } });

  try {
    const outcome = await wiring.ports.tools.execute({ toolCallId: "denied", name: "skill_proposals", arguments: {} }, new AbortController().signal);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") assert.equal(outcome.code, "permission_denied");
    assert.equal(review.calls(), 0);
  } finally { await wiring.close(); }
});
