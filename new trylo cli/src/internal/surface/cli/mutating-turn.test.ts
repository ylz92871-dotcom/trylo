import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { EMPTY_PROFILE } from "../../contract/profile.js";
import type { PermissionDecision, PermissionPort, PermissionTicket } from "../../ports/permission.js";
import type { ProviderEvent } from "../../ports/provider.js";
import type { ToolOutcome, ToolPort } from "../../ports/tools.js";
import { createFakeProvider, echoBinding } from "../../loop/fakes.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { runTurn, type LoopPorts } from "../../loop/runner.js";

/**
 * H5/H6 end to end: the same guards, now observed through a whole turn.
 *
 * This file lives in `surface/cli` rather than `loop` for a reason the quality
 * gate enforces: `loop/**` — tests included — may not import `adapters/**`, and
 * these cases must run against the *real* sandbox and the *real* mutating tools
 * rather than doubles. The composition layer is the one place allowed to know
 * both sides, so the wiring test belongs here.
 *
 * The point of these cases is the journal: what the run claims happened has to
 * match what the disk says happened.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-loop-"));
}

/** A workspace with a parent, so "one level up" is a real, checkable place. */
function nestedRoot(): { readonly parent: string; readonly root: string } {
  const parent = tempRoot();
  const root = join(parent, "workspace");
  mkdirSync(root, { recursive: true });
  return { parent, root };
}

const PROFILE = { async load() { return EMPTY_PROFILE; } };

type Scenario = {
  readonly root: string;
  readonly ports: LoopPorts;
  readonly executed: () => number;
  readonly asked: () => number;
};

function scenarioFor(
  root: string,
  decisions: ReadonlyArray<PermissionDecision>,
): Scenario {
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
  const grants = createPermissionGrantCache();
  const inner = createWorkspaceTools({ workspaceRoot: root, sandbox, visibility: grants });
  let executed = 0;
  let asked = 0;
  const tools: ToolPort = {
    snapshot: () => inner.snapshot(),

    async execute(call, signal): Promise<ToolOutcome> {
      const outcome = await inner.execute(call, signal);
      if (outcome.outcome === "result") {
        executed += 1;
      }
      return outcome;
    },

    async cancel(toolCallId) {
      return inner.cancel(toolCallId);
    },
  };
  const queue = [...decisions];
  const permission: PermissionPort = {
    async request(): Promise<PermissionTicket> {
      asked += 1;
      return { ticketId: `tkt-${asked}`, toolCallId: "call-1" };
    },

    async awaitDecision(): Promise<PermissionDecision> {
      return queue.shift() ?? { resolution: "denied", scope: "once" };
    },
  };

  return {
    root,
    ports: { provider: createFakeProvider([]), tools, permission, profile: PROFILE, sandbox, grants },
    executed: () => executed,
    asked: () => asked,
  };
}

function writeCall(toolCallId: string, path: string, content: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "tool_call", toolCallId, name: "write_file", arguments: { path, content } },
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

function kindsOf(envelopes: ReadonlyArray<{ kind: string }>): ReadonlyArray<string> {
  return envelopes.map((envelope) => envelope.kind);
}

test("an approved write lands, and the journal says so in its own words", async () => {
  const root = tempRoot();
  try {
    const scenario = scenarioFor(root, [{ resolution: "approved", scope: "once" }]);
    const result = await runTurn(
      { ...scenario.ports, provider: createFakeProvider([writeCall("call-1", "out.txt", "written"), finalStage("done")]) },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "write a file" },
    );

    assert.equal(result.state.phase, "terminal");
    assert.equal(result.state.terminalReason, "completed");
    assert.equal(readFileSync(join(root, "out.txt"), "utf8"), "written");
    const kinds = kindsOf(result.envelopes);

    for (const kind of ["tool_use", "approval_requested", "tool_result", "file_write"]) {
      assert.equal(kinds.includes(kind), true, kind);
    }

    const written = result.envelopes.find((envelope) => envelope.kind === "file_write");

    assert.deepEqual(written?.payload.path, "out.txt");
    assert.equal(written?.payload.bytes, 7);
    assert.equal(written?.payload.mode, "created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-interactive run denies the write and leaves no file", async () => {
  const root = tempRoot();
  try {
    const scenario = scenarioFor(root, [{ resolution: "denied", scope: "once" }]);
    const result = await runTurn(
      { ...scenario.ports, provider: createFakeProvider([writeCall("call-1", "never.txt", "x")]) },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "write a file" },
    );

    assert.equal(result.state.terminalReason, "failed");
    assert.equal(existsSync(join(root, "never.txt")), false);
    const kinds = kindsOf(result.envelopes);

    assert.equal(kinds.includes("permission_denied"), true);
    assert.equal(kinds.includes("file_write"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call the sandbox refuses never reaches the permission port", async () => {
  const { parent, root } = nestedRoot();
  try {
    const scenario = scenarioFor(root, [{ resolution: "approved", scope: "once" }]);
    const result = await runTurn(
      {
        ...scenario.ports,
        provider: createFakeProvider([writeCall("call-1", "../escape.txt", "x"), finalStage("could not write")]),
      },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "escape" },
    );

    assert.equal(scenario.asked(), 0);
    assert.equal(existsSync(join(parent, "escape.txt")), false);
    const refused = result.envelopes.find((envelope) => envelope.kind === "tool_result");

    assert.equal(refused?.payload.code, "path_outside_workspace");
    // The turn survives a refusal: it is a fact about one call, not the run.
    assert.equal(result.state.terminalReason, "completed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/**
 * The third identical call goes back for approval, and when the answer is no it
 * does not run: two side effects, one more prompt.
 */
test("a model repeating itself is stopped on the third call", async () => {
  const root = tempRoot();
  try {
    const scenario = scenarioFor(root, [
      { resolution: "approved", scope: "session" },
      { resolution: "denied", scope: "once" },
    ]);
    // Identical calls in the sense the guard cares about — same tool, same
    // arguments — each with its own id, because ids are per call.
    const result = await runTurn(
      {
        ...scenario.ports,
        provider: createFakeProvider([
          writeCall("call-1", "loop.txt", "same"),
          writeCall("call-2", "loop.txt", "same"),
          writeCall("call-3", "loop.txt", "same"),
          finalStage("stopped"),
        ]),
      },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "loop" },
    );

    assert.equal(scenario.executed(), 2);
    assert.equal(scenario.asked(), 2);
    assert.equal(result.state.terminalReason, "failed");
    assert.equal(readFileSync(join(root, "loop.txt"), "utf8"), "same");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A refusal the model never hears about is a refusal it will ask for again, so
 * the rejection has to travel back in the same channel as every other result.
 */
test("a refused call reaches the model as a failed tool result", async () => {
  const { parent, root } = nestedRoot();
  try {
    const scenario = scenarioFor(root, [{ resolution: "approved", scope: "once" }]);
    const result = await runTurn(
      {
        ...scenario.ports,
        provider: createFakeProvider([writeCall("call-1", "../escape.txt", "x"), finalStage("understood")]),
      },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "escape" },
    );
    const results = result.transcript.filter((item) => item.kind === "tool_result");

    assert.equal(results.length, 1);
    assert.match(String(results[0]?.output ?? ""), /path_outside_workspace/);
    assert.equal(result.state.terminalReason, "completed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a tool denied for the session disappears from the catalog", async () => {
  const root = tempRoot();
  try {
    const scenario = scenarioFor(root, [{ resolution: "denied", scope: "session" }]);
    const namesBefore = scenario.ports.tools.snapshot().map((binding) => binding.name);

    assert.equal(namesBefore.includes("write_file"), true);
    await runTurn(
      { ...scenario.ports, provider: createFakeProvider([writeCall("call-1", "denied.txt", "x")]) },
      { sessionId: "s", turnId: "t", correlationId: "c", text: "deny this tool" },
    );
    const namesAfter = scenario.ports.tools.snapshot().map((binding) => binding.name);

    assert.equal(namesAfter.includes("write_file"), false);
    assert.equal(namesAfter.includes("read_file"), true);
    assert.equal(existsSync(join(root, "denied.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the catalog still declares which tools mutate and which only read", () => {
  const root = tempRoot();
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const tools = createWorkspaceTools({ workspaceRoot: root, sandbox });
    const byName = new Map(tools.snapshot().map((binding) => [binding.name, binding]));

    assert.equal(byName.get("write_file")?.sideEffect, "workspace_write");
    assert.equal(byName.get("edit_file")?.sideEffect, "workspace_write");
    assert.equal(byName.get("run_shell")?.sideEffect, "external");
    assert.equal(byName.get("read_file")?.sideEffect, "read_only");

    for (const name of ["write_file", "edit_file", "run_shell"]) {
      assert.equal(byName.get(name)?.needsApproval, true, name);
    }

    assert.equal(byName.get("read_file")?.needsApproval, false);
    assert.equal(echoBinding().name, "echo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
