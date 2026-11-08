import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileCheckpointStore } from "../../adapters/checkpoint/store.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { EMPTY_PROFILE } from "../../contract/profile.js";
import type { PermissionDecision, PermissionPort, PermissionTicket } from "../../ports/permission.js";
import type { ProviderEvent } from "../../ports/provider.js";
import type { ToolOutcome, ToolPort } from "../../ports/tools.js";
import { createFakeProvider } from "../../loop/fakes.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { runTurn, type LoopPorts } from "../../loop/runner.js";
import { createPlannedPermission, planPermissions } from "./permission-plan.js";

/**
 * WP10.3 whole-turn proof: a model `apply_patch` call travels the real
 * chain — sandbox gate, one approval for the whole patch, checkpoint
 * snapshot before the first write, sequential commits, one journal
 * `file_write` fact per file — and the disk matches the journal.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-apply-turn-"));
}

const PROFILE = { async load() { return EMPTY_PROFILE; } };

function portsFor(root: string, storageRoot: string, decisions: ReadonlyArray<PermissionDecision>): LoopPorts {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  const grants = createPermissionGrantCache();
  const inner = createWorkspaceTools({ workspaceRoot: root, sandbox, visibility: grants });
  const tools: ToolPort = {
    snapshot: () => inner.snapshot(),
    async execute(call, signal): Promise<ToolOutcome> {
      return inner.execute(call, signal);
    },
    async cancel(toolCallId) {
      return inner.cancel(toolCallId);
    },
  };
  const queue = [...decisions];
  const permission: PermissionPort = {
    async request(): Promise<PermissionTicket> {
      return { ticketId: "tkt-1", toolCallId: "call-1" };
    },
    async awaitDecision(): Promise<PermissionDecision> {
      return queue.shift() ?? { resolution: "denied", scope: "once" };
    },
  };

  return {
    provider: createFakeProvider([]),
    tools,
    permission,
    profile: PROFILE,
    sandbox,
    grants,
    checkpoint: {
      port: createFileCheckpointStore({ workspaceRoot: root, storageRoot }),
      workspaceRoot: root,
      now: () => "2026-10-04T00:00:00.000Z",
    },
  };
}

function patchCall(toolCallId: string, patch: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "tool_call", toolCallId, name: "apply_patch", arguments: { patch } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

function finalStage(text: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text },
    { type: "text_end", blockId: "b1" },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
}

test("an approved multi-file patch lands with one journal fact per file", async () => {
  const root = tempRoot();
  const storage = join(tempRoot(), "checkpoints");

  try {
    writeFileSync(join(root, "keep.ts"), "old\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "*** Update File: keep.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: gone-missing.txt",
      "*** End Patch",
    ].join("\n");

    // The delete target must exist: deleting a missing file is a partial failure.
    writeFileSync(join(root, "gone-missing.txt"), "bye\n");
    const ports = portsFor(root, storage, [{ resolution: "approved", scope: "once" }]);
    const result = await runTurn(
      { ...ports, provider: createFakeProvider([patchCall("call-1", patch), finalStage("done")]) },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "apply the patch" },
    );

    assert.equal(result.state.phase, "terminal");
    assert.equal(result.state.terminalReason, "completed");
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(root, "keep.ts"), "utf8"), "new\n");
    const facts = result.envelopes.filter((envelope) => envelope.kind === "file_write");

    assert.deepEqual(
      facts.map((fact) => `${fact.payload.mode}:${fact.payload.path}`),
      ["created:new.txt", "patched:keep.ts", "deleted:gone-missing.txt"],
    );
    const snapshots = result.envelopes.filter(
      (envelope) => envelope.kind === "observation" && envelope.payload["component"] === "checkpoint",
    );

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.payload["status"], "ok");
    assert.equal(snapshots[0]?.payload["tool"], "apply_patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--ask writes approves the patch without asking and lands facts", async () => {
  const root = tempRoot();
  const storage = join(tempRoot(), "checkpoints");

  try {
    writeFileSync(join(root, "keep.ts"), "old\n");
    const patch = ["*** Begin Patch", "*** Update File: keep.ts", "@@", "-old", "+new", "*** End Patch"].join("\n");
    const prompted: string[] = [];
    const planned = createPlannedPermission(planPermissions({ ask: "writes", interactive: true }), {
      prompt: (text) => {
        prompted.push(text);
      },
      readLine: async () => "n",
    });
    const ports = { ...portsFor(root, storage, []), permission: planned };
    const result = await runTurn(
      { ...ports, provider: createFakeProvider([patchCall("call-1", patch), finalStage("done")]) },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "apply the patch" },
    );

    assert.equal(result.state.terminalReason, "completed");
    assert.equal(readFileSync(join(root, "keep.ts"), "utf8"), "new\n");
    assert.deepEqual(prompted, []);
    assert.equal(
      result.envelopes.some((envelope) => envelope.kind === "file_write"),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a denied patch runs nothing and leaves no file", async () => {
  const root = tempRoot();
  const storage = join(tempRoot(), "checkpoints");

  try {
    writeFileSync(join(root, "keep.ts"), "old\n");
    const patch = ["*** Begin Patch", "*** Add File: never.txt", "+x", "*** End Patch"].join("\n");
    const ports = portsFor(root, storage, [{ resolution: "denied", scope: "once" }]);
    const result = await runTurn(
      { ...ports, provider: createFakeProvider([patchCall("call-1", patch)]) },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "apply the patch" },
    );

    assert.equal(readFileSync(join(root, "keep.ts"), "utf8"), "old\n");
    assert.equal(
      result.envelopes.some((envelope) => envelope.kind === "file_write"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
