import assert from "node:assert/strict";
import { test } from "node:test";
import { admitToolCall, actionFor, type AdmissionPorts, type ToolAdmissionRequest } from "../../loop/tool-admission.js";
import { createDoomLoopTracker } from "../../loop/doom-loop.js";
import { createPermissionGrantCache, type PermissionGrantCache } from "../../loop/permission-grants.js";
import { decision, type PermissionPort, type PermissionScope } from "../../ports/permission.js";
import type { ReviewAnswer, Reviewer } from "../../domain/approval-reviewer.js";
import type { ToolSandbox } from "../../ports/tools.js";
import { WRITE_FILE_TOOL } from "../../adapters/tools/mutating/names.js";

/**
 * Where the reviewer sits, proven through the real door (C67).
 *
 * Each test enters through `admitToolCall` and counts consultations of the
 * permission port. A reviewer changes *who* answers a question, so what matters
 * is not that it returns a verdict but that the question is still asked when it
 * declines to, and that its approval does not become a standing grant.
 */

const CALL: ToolAdmissionRequest = {
  toolCallId: "call-1",
  name: WRITE_FILE_TOOL,
  arguments: { path: "notes.md", content: "x" },
};

function answering(answer: ReviewAnswer, rationale?: string, name = "risk-model"): Reviewer {
  return {
    name,
    async review() {
      return rationale === undefined ? { answer } : { answer, rationale };
    },
  };
}

function portsWith(
  reviewer: Reviewer | undefined,
  overrides: Partial<AdmissionPorts> = {},
  scope: PermissionScope = "session",
): AdmissionPorts & { asked(): number; approvals(): number; grants: PermissionGrantCache } {
  let asked = 0;
  let approvals = 0;
  const permission: PermissionPort = {
    async request() {
      asked += 1;
      return { ticketId: `p${asked}`, toolCallId: "call-1" };
    },

    async awaitDecision() {
      approvals += 1;
      return decision("approved", scope);
    },
  };
  const grants = createPermissionGrantCache();

  return {
    asked: () => asked,
    approvals: () => approvals,
    permission,
    grants,
    doom: createDoomLoopTracker(),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...overrides,
  };
}

test("no reviewer configured means the person is asked, exactly as before", async () => {
  const ports = portsWith(undefined);
  const verdict = await admitToolCall(ports, CALL);
  assert.deepEqual(verdict, { kind: "approved", source: "prompt" });
  assert.equal(ports.asked(), 1);
});

test("a reviewer that allows settles the call without asking anyone", async () => {
  const ports = portsWith(answering("allow"));
  const verdict = await admitToolCall(ports, CALL);
  assert.deepEqual(verdict, { kind: "approved", source: "reviewed" });
  assert.equal(ports.asked(), 0);
});

test("a reviewer's approval is not a standing grant", async () => {
  // This is the load-bearing one. If the review were recorded, the identical
  // second call would be admitted as `remembered` and no reviewer — and no
  // person — would ever see it again. The reviewer is asked again instead,
  // because approving something is not the same as licensing it.
  const reviewer = answering("allow");
  // `once` throughout: the person's own approval is what may become a standing
  // grant, and these calls never reach them.
  const ports = portsWith(reviewer, {}, "once");

  assert.deepEqual(await admitToolCall(ports, CALL), { kind: "approved", source: "reviewed" });
  const second = await admitToolCall(ports, { ...CALL, toolCallId: "call-2" });

  assert.deepEqual(second, { kind: "approved", source: "reviewed" });
  assert.equal(ports.asked(), 0);
  assert.equal(
    ports.grants.lookup(actionFor(CALL)).kind,
    "ask",
    "a review is not written into the grant cache",
  );
  assert.deepEqual([...ports.grants.entries()], [], "and it leaves no entry behind at all");
});

test("a reviewer that declines to decide is not a denial; the person still decides", async () => {
  const ports = portsWith(answering("ask_user", "I am not sure about this path"));
  const verdict = await admitToolCall(ports, CALL);
  assert.deepEqual(verdict, { kind: "approved", source: "prompt" });
  assert.equal(ports.asked(), 1, "ask_user must reach the human rather than swallow the question");
});

test("a reviewer's denial is reported as its own kind, carrying its own words", async () => {
  const ports = portsWith(answering("deny", "this rewrites a file outside the project"));
  const verdict = await admitToolCall(ports, CALL);

  assert.deepEqual(verdict, {
    kind: "review_rejected",
    reviewer: "risk-model",
    rationale: "this rewrites a file outside the project",
  });
  assert.equal(ports.asked(), 0, "a denial is an answer, not a question");
});

test("a denial with no stated reason still refuses, and says it had none", async () => {
  const ports = portsWith(answering("deny"));
  const verdict = await admitToolCall(ports, CALL);
  assert.deepEqual(verdict, { kind: "review_rejected", reviewer: "risk-model", rationale: "no reason given" });
});

test("a reviewer that breaks is not a denial and not an approval", async () => {
  const ports = portsWith({
    name: "flaky",
    async review(): Promise<never> {
      throw new Error("upstream 503");
    },
  });
  const verdict = await admitToolCall(ports, CALL);

  assert.deepEqual(verdict, { kind: "approved", source: "prompt" });
  assert.equal(ports.asked(), 1);
});

test("a sandbox refusal is never reviewed", async () => {
  // The reviewer sits below the sandbox, so a call that is already out of bounds
  // must not consume a review — and must not be turned into an approval by one.
  let reviewed = 0;
  const sandbox: ToolSandbox = {
    policy: {
      mode: "workspace_write",
      network: "restricted",
      workspaceRoot: "D:/CC/trylo",
      maxWriteBytes: 1_000_000,
      allowAbsoluteExecutable: false,
    },
    evaluate: () => ({ ok: false, code: "path_outside_workspace", message: "outside" }),
  };
  const ports = portsWith(
    {
      name: "risk-model",

      async review() {
        reviewed += 1;
        return { answer: "allow" };
      },
    },
    { sandbox },
  );
  const verdict = await admitToolCall(ports, CALL);

  assert.equal(verdict.kind, "sandbox_rejected");
  assert.equal(reviewed, 0);
  assert.equal(ports.asked(), 0);
});

test("a written policy is never overridden by a reviewer", async () => {
  let reviewed = 0;
  const ports = portsWith(
    {
      name: "risk-model",

      async review() {
        reviewed += 1;
        return { answer: "allow" };
      },
    },
    { execPolicy: () => ({ kind: "denied", code: "policy_forbidden", message: "not on the list" }) },
  );
  const verdict = await admitToolCall(ports, CALL);

  assert.deepEqual(verdict, { kind: "policy_rejected", code: "policy_forbidden", message: "not on the list" });
  assert.equal(reviewed, 0);
});

test("a remembered session grant is answered before the reviewer is asked", async () => {
  let reviewed = 0;
  const ports = portsWith({
    name: "risk-model",

    async review() {
      reviewed += 1;
      // Declines to decide every time; what is under test is that once a person
      // has answered this session, the reviewer is not asked again.
      return { answer: "ask_user" };
    },
  });

  // The person approves the first call for the whole session.
  assert.deepEqual(await admitToolCall(ports, CALL), { kind: "approved", source: "prompt" });
  assert.equal(reviewed, 1, "the first call was reviewed, and the person still decided it");
  const second = await admitToolCall(ports, { ...CALL, toolCallId: "call-2" });

  assert.deepEqual(second, { kind: "approved", source: "remembered" });
  assert.equal(reviewed, 1, "a decision already made this session is not re-litigated");
});

test("a reviewer's denial is terminal; the person is not asked over it", async () => {
  // Worth stating outright because it is the other half of the ordering: a
  // reviewer sits *above* the human, so `deny` ends the call. This is the
  // asymmetry with a sandbox escalation, where the person is the last word -
  // and it is deliberate, because a reviewer configured to review is configured
  // to be able to say no without a second signature.
  const ports = portsWith(answering("deny", "outside the sanctioned paths"));
  const verdict = await admitToolCall(ports, CALL);

  assert.equal(verdict.kind, "review_rejected");
  assert.equal(ports.asked(), 0);
});

test("a re-presented call is flagged to the reviewer as a retry", async () => {
  const retries: boolean[] = [];
  // `once` so the first answer leaves nothing behind and the second call really
  // does reach the reviewer again.
  const ports = portsWith(
    {
      name: "risk-model",

      async review(input) {
        retries.push(input.retry);
        return { answer: "ask_user" };
      },
    },
    {},
    "once",
  );

  await admitToolCall(ports, CALL);
  await admitToolCall(ports, { ...CALL, toolCallId: "call-2", resume: { ticketId: "t1" } });
  assert.deepEqual(retries, [false, true]);
});
