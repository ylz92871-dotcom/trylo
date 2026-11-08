import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandboxPolicy } from "./policy.js";
import { planMutation } from "./planner.js";
import { WRITE_FILE_TOOL } from "../tools/mutating/names.js";
import { SKILL_TOOL_NAME } from "../tools/skill/names.js";

/**
 * Sandbox-mode gating for the `skill` tool (WP14 复核 F2).
 *
 * `read_only` names the mutating set: it refuses tools that change the
 * machine. A read-only tool must not inherit that refusal just because it was
 * added to the planned set — the whole point of its plan is that the sandbox
 * has no path opinion about it. `deny_all` keeps refusing everything planned.
 */

const ROOT = "/ws";

function policy(mode: "workspace_write" | "read_only" | "deny_all") {
  return createSandboxPolicy({ workspaceRoot: ROOT, mode });
}

function skillCall(): { toolCallId: string; name: string; arguments: { skill: string } } {
  return { toolCallId: "t", name: SKILL_TOOL_NAME, arguments: { skill: "greet" } };
}

test("read_only mode still plans a skill call: it reads, it does not mutate", () => {
  const planned = planMutation(policy("read_only"), skillCall());
  assert.equal(planned.ok, true);
});

test("read_only mode still refuses the mutating set", () => {
  const planned = planMutation(policy("read_only"), {
    toolCallId: "t",
    name: WRITE_FILE_TOOL,
    arguments: { path: "a.txt", content: "x" },
  });

  assert.equal(planned.ok, false);

  if (planned.ok) return;

  assert.equal(planned.code, "sandbox_read_only");
});

test("deny_all refuses the skill tool like everything else planned", () => {
  const planned = planMutation(policy("deny_all"), skillCall());
  assert.equal(planned.ok, false);
  if (planned.ok) return;
  assert.equal(planned.code, "sandbox_deny_all");
});

test("an unnamed skill is refused before any surface loads it", () => {
  const planned = planMutation(policy("workspace_write"), {
    toolCallId: "t",
    name: SKILL_TOOL_NAME,
    arguments: {},
  });

  assert.equal(planned.ok, false);

  if (planned.ok) return;

  assert.equal(planned.code, "invalid_arguments");
});
