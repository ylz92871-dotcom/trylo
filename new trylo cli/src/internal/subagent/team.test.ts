import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolBinding } from "../ports/tools.js";
import { narrowTeamTools, type SubagentTeam } from "./team.js";

const binding = (name: string, sideEffect: ToolBinding["sideEffect"] = "read_only"): ToolBinding => ({
  name, sideEffect, description: name, needsApproval: false, timeoutMs: 1000,
  parameters: { type: "object", properties: {} }, outputLimits: { maxBytes: 1000, maxLines: 100 },
});
const catalog = ["read_file", "list_files", "search_text", "glob_files", "find_files", "view_image", "lsp_navigate", "todo_write", "skill", "create_goal",
  "get_goal", "update_goal", "ask_user_question", "request_user_input_async", "enter_plan_mode",
  "task_create", "unknown_read_tool"].map(name => binding(name)).concat([
    binding("write_file", "workspace_write"), binding("edit_file", "workspace_write"),
    binding("apply_patch", "workspace_write"), binding("run_shell", "external"), binding("web_fetch", "external"),
  ]);
const team = (roles: ReadonlyArray<{ name: string; allowedTools?: string[]; skills?: string[] }>): SubagentTeam => ({
  runId: "team-1", members: roles.map((role, index) => ({ memberId: `m${index}`, baseRole: role.name,
    displayName: role.name, role: { ...role, description: role.name } })),
});

test("read-only seats receive the frozen inspection floor, not parent lifecycle and question tools", () => {
  const narrowed = narrowTeamTools(team(["person", "reviewer", "verifier"].map(name => ({ name }))), catalog);
  for (const member of narrowed.members) assert.deepEqual(member.role.allowedTools,
    ["read_file", "list_files", "search_text", "glob_files", "find_files", "view_image", "lsp_navigate"]);
});

test("worker gets implementation tools but no independent lifecycle or unselected skills/research", () => {
  const narrowed = narrowTeamTools(team([{ name: "worker", skills: [] }]), catalog);
  assert.deepEqual(narrowed.members[0]?.role.allowedTools, ["read_file", "list_files", "search_text", "glob_files", "find_files", "view_image", "lsp_navigate",
    "todo_write", "write_file", "edit_file", "apply_patch", "run_shell"]);
});

test("explicit tools still intersect the role floor; worker research and selected skills are opt-in", () => {
  const narrowed = narrowTeamTools(team([
    { name: "person", allowedTools: ["read_file", "web_fetch", "write_file", "create_goal"] },
    { name: "worker", allowedTools: ["skill", "web_fetch", "create_goal"], skills: ["chosen"] },
    { name: "architect" },
  ]), catalog);
  assert.deepEqual(narrowed.members.map(member => member.role.allowedTools), [
    ["read_file"], ["web_fetch"], ["read_file", "list_files", "search_text", "glob_files", "find_files", "view_image", "lsp_navigate", "web_fetch"],
  ]);
});

test("a Work worker cannot inherit the general shell, patch or notebook mutation floor", () => {
  const narrowed = narrowTeamTools({ ...team([{ name: "worker" }]), surface: "work" }, catalog);
  assert.deepEqual(narrowed.members[0]?.role.allowedTools, ["read_file", "list_files", "search_text", "glob_files", "find_files",
    "view_image", "lsp_navigate", "todo_write", "write_file", "edit_file"]);
});
