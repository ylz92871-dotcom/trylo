import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import type {
  PermissionAction,
  PermissionDecision,
  PermissionPort,
  PermissionResolution,
  PermissionScope,
  PermissionTicket,
} from "../../ports/permission.js";
import { createDoomLoopTracker, DOOM_LOOP_THRESHOLD } from "../../loop/doom-loop.js";
import { awaitPermissionDecision } from "../../loop/permission-boundary.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { admitToolCall, type AdmissionPorts } from "../../loop/tool-admission.js";
import { permissionPattern } from "../../ports/permission.js";

/**
 * H5: the guards, in the order they run.
 *
 * The dangerous failure is not "a tool ran when it should not have" — that is
 * visible. It is "a tool asked for permission when it should not have", because
 * a prompt implies the thing being asked for is available at all.
 *
 * It sits in `surface/cli` because `loop/**` may not import `adapters/**` (the
 * quality gate scans tests too) and the first guard must be exercised against
 * the real workspace sandbox, not a stand-in.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-admission-"));
}

type Recorder = {
  readonly port: PermissionPort;
  readonly actions: PermissionAction[];
};

function recordingPermission(resolutions: ReadonlyArray<PermissionDecision>): Recorder {
  const actions: PermissionAction[] = [];
  const queue = [...resolutions];
  let counter = 0;
  return {
    actions,
    port: {
      async request(action: PermissionAction): Promise<PermissionTicket> {
        actions.push(action);
        counter += 1;
        return { ticketId: `tkt-${counter}`, toolCallId: action.toolCallId };
      },
      async awaitDecision(): Promise<PermissionDecision> {
        return queue.shift() ?? { resolution: "denied", scope: "once" };
      },
    },
  };
}

function decided(resolution: PermissionResolution, scope: PermissionScope = "once"): PermissionDecision {
  return { resolution, scope };
}

function portsFor(root: string, recorder: Recorder): AdmissionPorts {
  return {
    permission: recorder.port,
    sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
    grants: createPermissionGrantCache(),
    doom: createDoomLoopTracker(),
  };
}

const WRITE = { path: "notes.txt", content: "hello" } as const;

test("the sandbox refuses an escaping call before anyone is asked to approve it", async () => {
  const root = tempRoot();
  try {
    const recorder = recordingPermission([decided("approved")]);
    const admission = await admitToolCall(portsFor(root, recorder), {
      toolCallId: "c",
      name: "write_file",
      arguments: { path: "../escape.txt", content: "x" },
    });
    assert.equal(admission.kind, "sandbox_rejected");
    if (admission.kind === "sandbox_rejected") {
      assert.equal(admission.code, "path_outside_workspace");
    }
    assert.equal(recorder.actions.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every request carries the parsed arguments and their fingerprint", async () => {
  const root = tempRoot();
  try {
    const recorder = recordingPermission([decided("approved")]);
    await admitToolCall(portsFor(root, recorder), { toolCallId: "c", name: "write_file", arguments: { ...WRITE } });
    assert.equal(recorder.actions.length, 1);
    const action = recorder.actions[0];
    if (action !== undefined) {
      assert.deepEqual(action.arguments, WRITE);
      assert.match(action.pattern, /^write_file#[0-9a-f]{32}$/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session approval covers the same call and nothing else", async () => {
  const root = tempRoot();
  try {
    const recorder = recordingPermission([decided("approved", "session"), decided("approved", "session")]);
    const ports = portsFor(root, recorder);
    const first = await admitToolCall(ports, { toolCallId: "c1", name: "write_file", arguments: { ...WRITE } });
    assert.deepEqual(first, { kind: "approved", source: "prompt" });
    const same = await admitToolCall(ports, { toolCallId: "c2", name: "write_file", arguments: { ...WRITE } });
    assert.deepEqual(same, { kind: "approved", source: "remembered" });
    assert.equal(recorder.actions.length, 1);

    const other = await admitToolCall(ports, {
      toolCallId: "c3",
      name: "write_file",
      arguments: { path: "notes.txt", content: "different" },
    });
    assert.deepEqual(other, { kind: "approved", source: "prompt" });
    assert.equal(recorder.actions.length, 2);
    const patterns = recorder.actions.map((action) => action.pattern);
    assert.notEqual(patterns[0], patterns[1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key order does not turn one call into two", async () => {
  const root = tempRoot();
  try {
    const recorder = recordingPermission([decided("approved", "session")]);
    const ports = portsFor(root, recorder);
    await admitToolCall(ports, { toolCallId: "c1", name: "write_file", arguments: { path: "a", content: "b" } });
    const swapped = await admitToolCall(ports, { toolCallId: "c2", name: "write_file", arguments: { content: "b", path: "a" } });
    assert.deepEqual(swapped, { kind: "approved", source: "remembered" });
    assert.equal(recorder.actions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A model stuck on one call must not be able to keep going on the strength of a
 * single earlier approval: the third identical call goes back to a human.
 */
test("the third identical call is re-approved even after a session approval", async () => {
  const root = tempRoot();
  try {
    const recorder = recordingPermission([
      decided("approved", "session"),
      decided("approved", "session"),
    ]);
    const ports = portsFor(root, recorder);
    await admitToolCall(ports, { toolCallId: "c1", name: "write_file", arguments: { ...WRITE } });
    await admitToolCall(ports, { toolCallId: "c2", name: "write_file", arguments: { ...WRITE } });
    assert.equal(recorder.actions.length, 1);
    const third = await admitToolCall(ports, { toolCallId: "c3", name: "write_file", arguments: { ...WRITE } });
    assert.deepEqual(third, { kind: "approved", source: "prompt" });
    assert.equal(recorder.actions.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repeat detector counts consecutive calls, not lifetime calls", () => {
  const tracker = createDoomLoopTracker();
  const action = (pattern: string) => ({ toolCallId: "c", name: "write_file", arguments: {}, pattern });
  assert.equal(tracker.observe(action("a")), false);
  assert.equal(tracker.observe(action("a")), false);
  assert.equal(tracker.observe(action("a")), true);
  assert.equal(tracker.consecutive(), DOOM_LOOP_THRESHOLD);
  assert.equal(tracker.observe(action("b")), false);
  tracker.reset();
  assert.equal(tracker.consecutive(), 0);
});

test("a denial of the whole tool hides it and keeps denying it", async () => {
  const root = tempRoot();
  try {
    const recorder = recordingPermission([decided("denied", "session")]);
    const ports = portsFor(root, recorder);
    const denied = await admitToolCall(ports, { toolCallId: "c1", name: "write_file", arguments: { ...WRITE } });
    assert.deepEqual(denied, { kind: "denied", source: "prompt" });
    assert.equal(ports.grants.isDenied("write_file"), true);
    assert.equal(ports.grants.isDenied("edit_file"), false);
    const again = await admitToolCall(ports, { toolCallId: "c2", name: "write_file", arguments: { path: "other.txt", content: "x" } });
    assert.deepEqual(again, { kind: "denied", source: "remembered", reason: "remembered_denial" });
    assert.equal(recorder.actions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled and expired stay distinct from denied", async () => {
  const root = tempRoot();
  try {
    const cancelled = await admitToolCall(
      portsFor(root, recordingPermission([decided("cancelled")])),
      { toolCallId: "c", name: "write_file", arguments: { ...WRITE } },
    );
    assert.equal(cancelled.kind, "cancelled");
    const expired = await admitToolCall(
      portsFor(root, recordingPermission([decided("expired")])),
      { toolCallId: "c", name: "write_file", arguments: { ...WRITE } },
    );
    assert.equal(expired.kind, "expired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The pre-P03 action shape is what a widened approval would look like, so the
 * boundary is where it dies — before the port, not inside it.
 */
test("an action without parsed arguments fails closed at the boundary", async () => {
  let asked = 0;
  const port: PermissionPort = {
    async request(action) {
      asked += 1;
      return { ticketId: "t", toolCallId: action.toolCallId };
    },
    async awaitDecision() {
      return decided("approved");
    },
  };
  const legacy = { toolCallId: "c", name: "write_file" } as unknown as PermissionAction;
  const result = await awaitPermissionDecision(port, legacy);
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.match(result.message, /permission_action_missing_arguments/);
  }
  assert.equal(asked, 0);
});

test("a ticket belonging to another call is a failure, not a decision", async () => {
  const port: PermissionPort = {
    async request() {
      return { ticketId: "t", toolCallId: "someone-else" };
    },
    async awaitDecision() {
      return decided("approved");
    },
  };
  const result = await awaitPermissionDecision(port, {
    toolCallId: "c",
    name: "write_file",
    arguments: { ...WRITE },
    pattern: permissionPattern("write_file", WRITE),
  });
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") {
    assert.match(result.message, /permission_ticket_tool_mismatch/);
  }
});
