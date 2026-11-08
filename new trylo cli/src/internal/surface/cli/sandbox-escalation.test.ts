import assert from "node:assert/strict";
import { test } from "node:test";
import { admitToolCall, type AdmissionPorts, type ToolAdmissionRequest } from "../../loop/tool-admission.js";
import { createDoomLoopTracker } from "../../loop/doom-loop.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { decision, type PermissionPort } from "../../ports/permission.js";
import type { SandboxVerdict, ToolSandbox } from "../../ports/tools.js";
import { WRITE_FILE_TOOL } from "../../adapters/tools/mutating/names.js";
import { isEscalatableRefusal, type EscalationInput } from "../../domain/sandbox-escalation.js";
import { createInteractiveEscalation, type EscalationIo } from "./sandbox-escalation.js";

/**
 * The escalation path (C65).
 *
 * The interesting cases are the ones that must *not* work: a made-up ticket, a
 * ticket replayed, a ticket carried over to another call, and a refusal that is
 * a fact rather than a boundary. Each is asserted to release nothing.
 */

const OUTSIDE = { path: "../outside.txt", content: "x" };
const INSIDE = { path: "inside.txt", content: "x" };

const REFUSAL: Pick<EscalationInput, "code" | "message"> = {
  code: "path_outside_workspace",
  message: "refused: path outside workspace",
};

function scriptedIo(answers: ReadonlyArray<string>): EscalationIo & { prompts: string[] } {
  const prompts: string[] = [];
  const queue = [...answers];

  return {
    prompts,
    prompt: (text) => prompts.push(text),
    readLine: async () => queue.shift(),
  };
}

function sandboxWith(verdict: SandboxVerdict): ToolSandbox {
  return {
    policy: {
      mode: "workspace_write",
      network: "restricted",
      workspaceRoot: "D:/workspace",
      maxWriteBytes: 1024,
      allowAbsoluteExecutable: false,
    },
    evaluate: () => verdict,
  };
}

function writeCall(args: Record<string, string>): ToolAdmissionRequest {
  return { toolCallId: "call-1", name: WRITE_FILE_TOOL, arguments: args };
}

function portsFor(
  io: EscalationIo,
  sandbox: ToolSandbox,
): AdmissionPorts & { asked(): number } {
  let asked = 0;
  const permission: PermissionPort = {
    async request() {
      asked += 1;
      return { ticketId: `p${asked}`, toolCallId: "call-1" };
    },

    async awaitDecision() {
      return decision("approved", "once");
    },
  };

  return {
    asked: () => asked,
    permission,
    sandbox,
    grants: createPermissionGrantCache(),
    doom: createDoomLoopTracker(),
    escalation: createInteractiveEscalation(io),
  };
}

function escalationInput(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    toolCallId: "call-1",
    name: WRITE_FILE_TOOL,
    arguments: OUTSIDE,
    ...REFUSAL,
    ...overrides,
  };
}

test("only a drawn boundary is worth asking about", () => {
  assert.equal(isEscalatableRefusal("path_outside_workspace"), true);
  for (const code of ["path_escapes_via_link", "path_unverifiable", "parent_missing", "invalid_path", "cd_forbidden"]) {
    assert.equal(isEscalatableRefusal(code), false, code);
  }
});

test("releasing a boundary runs the call and shows what was released", async () => {
  const io = scriptedIo(["y"]);
  const ports = portsFor(io, sandboxWith({ ok: false, ...REFUSAL }));
  const verdict = await admitToolCall(ports, writeCall(OUTSIDE));

  assert.deepEqual(verdict, { kind: "approved", source: "escalation" });
  assert.equal(ports.asked(), 0, "the ordinary approval path is not what released this");
  const prompt = io.prompts.join("\n");

  assert.match(prompt, /path_outside_workspace/);
  assert.match(prompt, /\.\.\/outside\.txt/, "the prompt names the value, not just the tool");
  assert.match(prompt, /nothing is remembered/);
  assert.doesNotMatch(prompt, /\[s\]/, "there is no remember answer for a boundary");
});

test("a refusal that is a fact is not put to anyone", async () => {
  const io = scriptedIo(["y"]);
  const ports = portsFor(io, sandboxWith({ ok: false, code: "path_escapes_via_link", message: "symlink" }));
  const verdict = await admitToolCall(ports, writeCall(OUTSIDE));
  assert.equal(verdict.kind, "sandbox_rejected");
  assert.deepEqual(io.prompts, [], "no question was asked, so the queued answer was never read");
  assert.equal(ports.asked(), 0);
});

test("declining and closing the input are different ends", async () => {
  const declined = await admitToolCall(
    portsFor(scriptedIo(["n"]), sandboxWith({ ok: false, ...REFUSAL })),
    writeCall(OUTSIDE),
  );

  assert.equal(declined.kind, "sandbox_rejected");
  assert.equal(declined.kind === "sandbox_rejected" ? declined.escalated : undefined, true);

  const closed = await admitToolCall(
    portsFor(scriptedIo([]), sandboxWith({ ok: false, ...REFUSAL })),
    writeCall(OUTSIDE),
  );

  assert.equal(closed.kind, "cancelled");
});

test("a ticket is spent by the one call it was issued for", async () => {
  const authority = createInteractiveEscalation(scriptedIo(["y", "y"]));
  const first = await authority.request(escalationInput());

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  assert.equal(authority.redeem(first.ticket, escalationInput()), true);
  assert.equal(authority.redeem(first.ticket, escalationInput()), false, "and only once");
});

test("a made-up ticket releases nothing", async () => {
  const authority = createInteractiveEscalation(scriptedIo(["y"]));
  assert.equal(authority.redeem({ ticketId: "escalate-999" }, escalationInput()), false);
  assert.equal(authority.redeem(undefined, escalationInput()), false);
});

test("a ticket does not travel to another call or another value", async () => {
  const authority = createInteractiveEscalation(scriptedIo(["y", "y"]));
  const first = await authority.request(escalationInput());

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  assert.equal(
    authority.redeem(first.ticket, escalationInput({ toolCallId: "call-2" })),
    false,
    "somebody else's answer",
  );
  const second = await authority.request(escalationInput());

  assert.equal(second.ok, true);

  if (!second.ok) {
    return;
  }

  assert.equal(
    authority.redeem(
      second.ticket,
      escalationInput({ arguments: { path: "../somewhere-else.txt", content: "x" } }),
    ),
    false,
    "releasing one path is not a licence for the next one",
  );
});

test("re-presenting a call with its ticket skips the refusal that was released", async () => {
  const io = scriptedIo(["y"]);
  const ports = portsFor(io, sandboxWith({ ok: false, ...REFUSAL }));
  const escalation = ports.escalation;

  assert.ok(escalation);
  const issued = await escalation.request(escalationInput());

  assert.equal(issued.ok, true);

  if (!issued.ok) {
    return;
  }

  const verdict = await admitToolCall(ports, { ...writeCall(OUTSIDE), resume: issued.ticket });

  assert.equal(verdict.kind, "approved");
  assert.equal(io.prompts.length, 1, "the ticket answered the question instead of asking it again");
});

test("a call inside the workspace never reaches the escalation at all", async () => {
  const io = scriptedIo(["y"]);
  const ports = portsFor(io, sandboxWith({ ok: true }));
  const verdict = await admitToolCall(ports, writeCall(INSIDE));
  assert.equal(verdict.kind, "approved");
  assert.equal(ports.asked(), 1, "it goes on to the ordinary approval chain");
  assert.deepEqual(io.prompts, []);
});
