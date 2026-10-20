import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "../../adapters/tools/mutating/names.js";
import { WEB_FETCH_TOOL } from "../../adapters/tools/web/names.js";
import type { PermissionAction } from "../../ports/permission.js";
import { createDenyAllPermission } from "./permission.js";
import {
  APPROVABLE_TOOL_NAMES,
  ASK_POLICIES,
  createPlannedPermission,
  decideForPlan,
  defaultAskPolicy,
  isAskPolicy,
  isApprovableToolName,
  planPermissions,
  type AskPolicy,
  type PermissionPlan,
} from "./permission-plan.js";

/**
 * B4 (the flag matrix), B5 (the default path is untouched) and the fail-closed
 * rule the whole decision rests on.
 *
 * The matrix is checked on `decideForPlan`, which is pure — no prompt, no
 * terminal, no clock. That is deliberate: the table in the spec is a statement
 * about a few inputs and one output, and a test that had to drive a terminal to
 * check it would be testing the prompt instead.
 */

// The default catalog's approval-bearing tools — the source of truth for what
// exists when no mount flag is on.
// WP13 adds NOTEBOOK_EDIT_TOOL to the approval-bearing default catalog.
const APPROVING = [APPLY_PATCH_TOOL, EDIT_FILE_TOOL, NOTEBOOK_EDIT_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL].sort();
// The flag vocabulary is wider: `--allow-tools` may name a mount-scoped tool
// before its flag mounts it, so web_fetch is approvable-by-name while absent
// from the default catalog above.
const MEMORY_WRITERS = ["memory_remember", "memory_correct", "memory_forget"];
const APPROVABLE_VOCAB = [...APPROVING, WEB_FETCH_TOOL, ...MEMORY_WRITERS].sort();

test("user memory writers accept explicit permission names without inheriting workspace grants", () => {
  for (const name of MEMORY_WRITERS) {
    assert.equal(isApprovableToolName(name), true);
    assert.equal(decisionFor(planPermissions({ interactive: false, allowTools: [name] }), name), "approved");
    assert.equal(decisionFor(planPermissions({ interactive: false, allowTools: [name], denyTools: [name] }), name), "denied");
    assert.equal(decisionFor(planPermissions({ interactive: false, allowWrites: true }), name), "denied");
    assert.equal(decisionFor(planPermissions({ interactive: false }), name), "denied");
  }
});

function action(name: string): PermissionAction {
  return { toolCallId: "call-1", name, arguments: {}, pattern: `${name}#p` };
}

function decisionFor(plan: PermissionPlan, name: string): string {
  return decideForPlan(plan, action(name));
}

/** A plan port whose prompt is recorded rather than rendered. */
function planned(plan: PermissionPlan, asked: string[]) {
  return createPlannedPermission(plan, {
    prompt: (text) => {
      asked.push(text);
    },
    readLine: async () => "y",
  });
}

test("B4: the --ask matrix, cell by cell", () => {
  const plain = (ask: AskPolicy): PermissionPlan => planPermissions({ ask, interactive: false });

  // never: nothing is approved unless it was named.
  assert.equal(decisionFor(plain("never"), WRITE_FILE_TOOL), "denied");
  assert.equal(decisionFor(plain("never"), RUN_SHELL_TOOL), "denied");
  assert.equal(
    decisionFor(planPermissions({ ask: "never", allowTools: [RUN_SHELL_TOOL], interactive: false }), RUN_SHELL_TOOL),
    "approved",
  );

  // writes: the two workspace writers are approved, a shell is still not.
  assert.equal(decisionFor(plain("writes"), WRITE_FILE_TOOL), "approved");
  assert.equal(decisionFor(plain("writes"), EDIT_FILE_TOOL), "approved");
  assert.equal(decisionFor(plain("writes"), RUN_SHELL_TOOL), "denied");
  // `--ask writes` covers workspace writers only — a mounted web_fetch is
  // never blanket-approved by it, only named explicitly.
  assert.equal(decisionFor(plain("writes"), WEB_FETCH_TOOL), "denied");
  assert.equal(
    decisionFor(planPermissions({ ask: "writes", allowTools: [RUN_SHELL_TOOL], interactive: false }), RUN_SHELL_TOOL),
    "approved",
  );

  // always: every approving tool goes to a human, and only a human answers.
  assert.equal(decisionFor(plain("always"), WRITE_FILE_TOOL), "ask");
  assert.equal(decisionFor(plain("always"), EDIT_FILE_TOOL), "ask");
  assert.equal(decisionFor(plain("always"), RUN_SHELL_TOOL), "ask");
});

test("B4: a denial outranks an allowance, whichever order they were given", () => {
  const both = planPermissions({
    allowTools: [WRITE_FILE_TOOL, RUN_SHELL_TOOL],
    denyTools: [WRITE_FILE_TOOL],
    interactive: false,
  });
  assert.equal(decisionFor(both, WRITE_FILE_TOOL), "denied");
  assert.equal(decisionFor(both, RUN_SHELL_TOOL), "approved");

  const reversed = planPermissions({
    denyTools: [WRITE_FILE_TOOL],
    allowTools: [WRITE_FILE_TOOL],
    interactive: false,
  });
  assert.equal(decisionFor(reversed, WRITE_FILE_TOOL), "denied");
  assert.equal(decisionFor(planPermissions({ ask: "always", denyTools: [RUN_SHELL_TOOL], interactive: true }), RUN_SHELL_TOOL), "denied");
});

test("B4: workspace readers stay approval-free; external path readers are approvable by name", () => {
  // The first column of the matrix is "approved", and it is approved before any
  // of this exists: a read-only binding declares that it needs no approval, so
  // the loop never asks. The check runs against the real tool table rather than
  // against `APPROVABLE_TOOL_NAMES`, because that list is only an assertion
  // *about* the table and would happily agree with a stale one.
  const root = mkdtempSync(join(tmpdir(), "trylo-plan-"));
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    const bindings = createWorkspaceTools({ workspaceRoot: root, sandbox }).snapshot();
    const approving = bindings.filter((binding) => binding.needsApproval).map((binding) => binding.name).sort();
    assert.deepEqual(approving, APPROVING);
    assert.equal(
      bindings.some((binding) => !binding.needsApproval && binding.sideEffect === "read_only"),
      true,
      "the table no longer advertises a read-only tool; this check has stopped testing anything",
    );
    assert.deepEqual([...APPROVABLE_TOOL_NAMES].sort(), [...APPROVABLE_VOCAB,
      "read_file", "list_files", "search_text", "glob_files", "view_image", "read_pdf", "read_notebook"].sort());
    assert.equal(new Set(APPROVABLE_TOOL_NAMES).size, APPROVABLE_TOOL_NAMES.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B4: a tool nobody approved — including one mounted later — fails closed", () => {
  for (const ask of ASK_POLICIES) {
    assert.equal(
      decisionFor(planPermissions({ ask, interactive: true }), "mcp__some_server__do_thing"),
      ask === "always" ? "ask" : "denied",
    );
  }
});

test("D7: the default policy follows the terminal, not a guess", () => {
  assert.equal(defaultAskPolicy({ interactive: true }), "always");
  assert.equal(defaultAskPolicy({ interactive: false }), "never");
  // `--allow-writes` is the sugar for `--ask writes`, and it still means that
  // in a terminal — the flag narrows, it never widens.
  assert.equal(defaultAskPolicy({ interactive: true, allowWrites: true }), "writes");
  assert.equal(defaultAskPolicy({ interactive: false, allowWrites: true }), "writes");
  // An explicit --ask wins over the sugar.
  assert.equal(defaultAskPolicy({ interactive: false, allowWrites: true, ask: "never" }), "never");
});

test("B5: with no flags the plan decides exactly what deny-all decided", async () => {
  const plan = planPermissions({ interactive: false });
  assert.equal(plan.ask, "never");
  assert.equal(plan.allow.size, 0);
  assert.equal(plan.deny.size, 0);

  // Outside a terminal nothing can be asked, so every approving call must come
  // out denied — the same answer the port this replaced gave.
  const legacy = createDenyAllPermission();
  for (const name of APPROVABLE_TOOL_NAMES) {
    assert.equal(decisionFor(plan, name), "denied", `${name} was not denied by the default plan`);
    const ticket = await legacy.request(action(name));
    assert.equal((await legacy.awaitDecision(ticket.ticketId)).resolution, "denied");
  }
});

test("B5: an interactive plan with no flags asks about every approving tool", async () => {
  const asked: string[] = [];
  const port = planned(planPermissions({ interactive: true }), asked);
  for (const name of APPROVABLE_TOOL_NAMES) {
    const ticket = await port.request(action(name));
    assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, "approved");
  }
  assert.deepEqual([...new Set(asked)].length, APPROVABLE_TOOL_NAMES.length);
});

test("D7: --ask never reaches a prompt even in a terminal", async () => {
  const asked: string[] = [];
  const port = planned(planPermissions({ ask: "never", interactive: true }), asked);
  for (const name of APPROVABLE_TOOL_NAMES) {
    const ticket = await port.request(action(name));
    assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, "denied");
  }
  assert.deepEqual(asked, [], "a policy of never must not ask anybody anything");
});

test("D7: the ask vocabulary is a closed set", () => {
  assert.deepEqual([...ASK_POLICIES], ["always", "writes", "never"]);
  assert.equal(ASK_POLICIES.every(isAskPolicy), true);
  assert.equal(isAskPolicy("sometimes"), false);
  assert.equal(isAskPolicy(""), false);
});
