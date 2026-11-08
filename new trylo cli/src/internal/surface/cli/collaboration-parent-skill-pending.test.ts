import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import type { ProviderMessage, ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import { createPersonalAgentProvider, type PersonalAgentProviderOptions } from "./collaboration-parent-context.js";
import { createPersonalAgentRuntime } from "./collaboration-personal-agent-wiring.js";
import { createDenyAllPermission } from "./permission.js";
import { streamPreparedProvider } from "../../testing/provider-request.js";

type PendingReader = NonNullable<PersonalAgentProviderOptions["readSkillPending"]>;

const pending = { text: "Original native pending proposal pending:actual; await original user review.", sourceRefs: ["native:pending:actual"] };
const input = { attemptId: "request:pa", model: "scripted-local", messages: [{ role: "user" as const, content: "Review the current task." }], tools: [] };
const signal = () => new AbortController().signal;
const now = () => "2026-11-05T12:00:00.000Z";

function fixture(options: { readonly read: PendingReader; readonly enabled?: () => boolean }) {
  const requests: (readonly ProviderMessage[])[] = [], warnings: string[] = [];
  const stream: ProviderPort["stream"] = async function* (request) {
    requests.push(request.messages);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  };
  const provider: ProviderPort = { stream, fork: () => ({ stream }) };
  const experience = { async prepareExperience() { return { ok: true as const, text: "", versionIds: [], selectionId: "none" }; },
    async recordLoad() { throw new Error("No experience version was selected."); },
    async recordDispatch() { throw new Error("No experience version was selected."); } };
  const parent = createPersonalAgentProvider({ provider, experience, scope: "workspace:pending", turnId: "turn:pending", now,
    recentFacts: () => [], inspect: async () => ({}), warn: reason => warnings.push(reason), readSkillPending: options.read,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }) });

  return { parent, provider, requests, warnings };
}

async function send(provider: ProviderPort, runSignal = signal()) {
  for await (const event of streamPreparedProvider(provider, input, runSignal)) assert.equal(event.type, "finish");
}

const context = (messages: readonly ProviderMessage[]) => messages.map(message => message.content).join("\n");

test("normal PA reads complete skill pending guidance and source refs at each actual request boundary", async () => {
  let reads = 0;
  const runSignal = signal();
  let current = pending;
  const h = fixture({ read: async received => {
    assert.equal(received, runSignal);
    reads++;
    return current;
  } });

  assert.equal(reads, 0);
  await send(h.parent, runSignal);
  assert.equal(reads, 1);
  assert.equal(h.requests.length, 1);
  const shown = context(h.requests[0]!);

  assert.match(shown, /pending:actual/);
  assert.match(shown, /native:pending:actual/);
  assert.match(shown, /unapproved data/);
  current = { text: "Original pending catalog now has pending:next.", sourceRefs: ["native:pending:next"] };
  await send(h.parent, runSignal);
  assert.equal(reads, 2);
  assert.match(context(h.requests[1]!), /pending:next/);
  assert.doesNotMatch(context(h.requests[1]!), /pending:actual/);
  assert.deepEqual(h.requests[0]!.slice(0, 1), input.messages);
  assert.deepEqual(h.warnings, []);
});

test("disabled and already cancelled PA requests do not read or retain skill pending data", async () => {
  let enabled = true, reads = 0;
  const h = fixture({ enabled: () => enabled, read: async () => {
    reads++;
    return pending;
  } });
  await send(h.parent);
  assert.equal(reads, 1);
  assert.match(context(h.requests[0]!), /pending:actual/);
  enabled = false;
  await send(h.parent);
  assert.equal(reads, 1);
  assert.doesNotMatch(context(h.requests[1]!), /pending:actual/);
  enabled = true;
  const cancelled = new AbortController();
  cancelled.abort();
  await send(h.parent, cancelled.signal);
  assert.equal(reads, 1);
  assert.doesNotMatch(context(h.requests[2]!), /pending:actual/);
});

for (const mode of ["cancelled", "disabled"] as const) {
  test(`skill pending read completing after ${mode} is discarded before the PA provider request`, async () => {
    let enabled = true, reads = 0;
    const controller = new AbortController();
    const h = fixture({ enabled: () => enabled, read: async received => {
      assert.equal(received, controller.signal);
      reads++;
      if (mode === "cancelled") controller.abort();else enabled = false;
      return pending;
    } });

    await send(h.parent, controller.signal);
    assert.equal(reads, 1);
    assert.doesNotMatch(context(h.requests[0]!), /pending:actual/);
  });
}

test("oversized pending guidance is omitted whole and source failures only warn", async () => {
  let mode: "capacity" | "error" = "capacity";
  const h = fixture({ read: async () => {
    if (mode === "error") throw new Error("private_native_failure_detail");
    return { text: `pending:private-oversized:${"x".repeat(8192)}`, sourceRefs: ["native:private-oversized"] };
  } });

  await send(h.parent);
  assert.doesNotMatch(context(h.requests[0]!), /private-oversized/);
  assert.deepEqual(h.warnings, ["collaboration_parent:skill_pending_context_capacity"]);
  mode = "error";
  await send(h.parent);
  assert.equal(h.requests.length, 2);
  assert.doesNotMatch(context(h.requests[1]!), /private_native_failure_detail/);
  assert.deepEqual(h.warnings, ["collaboration_parent:skill_pending_context_capacity", "collaboration_parent:skill_pending_unavailable"]);
});

test("forked providers never inherit the parent-only pending reader or previously delivered pending data", async () => {
  let reads = 0;
  const h = fixture({ read: async () => {
    reads++;
    return pending;
  } });
  await send(h.parent);
  assert.equal(reads, 1);
  const child = h.parent.fork?.([]);
  assert.ok(child);
  await send(child);
  assert.equal(reads, 1);
  assert.deepEqual(h.requests[1], input.messages);
});

test("the normal PA runtime forwards its pending reader to its actual parent provider wrapper", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-pa-skill-pending-"));
  try {
    const h = fixture({ read: async () => undefined });
    let reads = 0;
    const tools: ToolPort = { snapshot: () => [], execute: async () => { throw new Error("No business tool is mounted."); }, cancel: async () => {} };
    const runtime = createPersonalAgentRuntime({ homeDir: root, env: { TRYLO_HOME: root }, scope: root, turnId: "turn:actual-pa",
      now: () => Date.parse(now()), newOwnerId: () => "owner:local-pa", warn: () => {},
      tools, workspaceTools: tools, toolSelectionCeiling: [], provider: h.provider, model: "scripted-local",
      permission: createDenyAllPermission(), grants: createPermissionGrantCache(), sandbox: createWorkspaceSandbox({ workspaceRoot: root, mode: "deny_all" }),

      readSkillPending: async () => {
        reads++;
        return pending;
      } });

    try {
      await send(runtime.wrapProvider(h.provider));
      assert.equal(reads, 1);
      assert.match(context(h.requests[0]!), /pending:actual/);
    } finally { await runtime.close(); }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-pa-skill-pending-/);
    await rm(root, { recursive: true, force: true });
  }
});
