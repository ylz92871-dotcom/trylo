import assert from "node:assert/strict";
import { test } from "node:test";
import { teamProfileFor } from "./team-profile-wiring.js";
import type { SkillCatalogPort, SkillDescriptor } from "../../ports/skills.js";

const members = ["person", "worker"].map(baseRole => ({ memberId: `m-${baseRole}`, baseRole,
  displayName: baseRole, overlay: { model: "inherit", skills: [], systemPromptOverlay: "custom instructions",
    disallowedTools: ["Bash"] } }));
const block = (runId = "team-test") => `<trylo_team_access>\ndecision: spawn_team\nteamRunId: ${runId}\nTRYLO_TEAM_HOLD: worker\n${members.map(member =>
  `- member_id=${member.memberId} baseRole=${member.baseRole} displayName=${member.displayName}`).join("\n")}\n<trylo_engineering_contract>{"goal":"inspect"}</trylo_engineering_contract>\n</trylo_team_access>`;

test("team loading consumes the frozen roster, instructions and denials without expanding tools", () => {
  const paths: string[] = [];
  const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt: block(), readFile: path => {
    paths.push(path); return JSON.stringify({ frozenProfile: { members } });
  } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.team?.members.map(member => member.memberId), ["m-person", "m-worker"]);
  assert.deepEqual(result.team?.heldRoles, ["worker"]);
  assert.deepEqual(result.team?.members[0]?.role.disallowedTools, ["run_shell"]);
  assert.ok(result.team?.members[0]?.role.prompt?.includes("custom instructions"));
  assert.ok(result.team?.members[0]?.role.prompt?.includes("trylo_engineering_contract"));
  assert.equal(paths.length, 1);
});

test("ordinary turns and stay_solo never read team files", () => {
  for (const systemPrompt of [undefined, "normal prompt", "<trylo_team_access>decision: stay_solo</trylo_team_access>"]) {
    const result = teamProfileFor({ workspaceRoot: "D:/project", ...(systemPrompt === undefined ? {} : { systemPrompt }),
      readFile: () => { throw new Error("unexpected team IO"); } });
    assert.deepEqual(result, { ok: true });
  }
});

test("invalid identity, corrupted freezes and missing overlays fail before dispatch", () => {
  for (const [systemPrompt, content] of [[block("../../escape"), "{}"], [block(), "{broken"],
    [block(), "{}"], [block(), undefined], [block(), JSON.stringify({ frozenProfile: { members: [] } })]] as const) {
    const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt, readFile: () => content });
    assert.equal(result.ok, false);
  }
});

test("scratch write failure uses the exact per-member fallback and retains denials", () => {
  const systemPrompt = `${block()}\n${members.map(member => `<trylo_member_overlay member_id="${member.memberId}">${JSON.stringify(member.overlay)}</trylo_member_overlay>`).join("\n")}`;
  const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt, readFile: () => undefined });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.team?.members[0]?.role.disallowedTools, ["run_shell"]);
});

test("legacy composer tool names resolve to the production V1 catalog", () => {
  const withTools = members.map(member => ({ ...member, overlay: { ...member.overlay,
    tools: ["Read", "Grep", "Glob", "LSP", "NotebookEdit", "TodoWrite", "Skill"] } }));
  const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt: block(),
    readFile: () => JSON.stringify({ frozenProfile: { members: withTools } }) });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.team?.members[1]?.role.allowedTools,
    ["read_file", "search_text", "glob_files", "lsp_navigate", "notebook_edit", "todo_write", "skill"]);
});

const selectedSkill: SkillDescriptor = { name: "chosen", description: "selected member instructions", source: "project",
  skillRoot: "D:/project/.agents/skills/chosen", path: "D:/project/.agents/skills/chosen/SKILL.md", contentHash: "hash",
  body: "SELECTED_SKILL_BODY", userInvocable: true, disableModelInvocation: false, forkExecution: false,
  allowedTools: ["Read", "Write"] };
const skillCatalog = (descriptor = selectedSkill): SkillCatalogPort => ({ list: () => [descriptor],
  load: name => name === descriptor.name ? { kind: "loaded", skill: { descriptor, content: descriptor.body } }
    : { kind: "unknown_skill", name } });
const selectedMembers = () => members.map(member => ({ ...member, overlay: { ...member.overlay,
  skills: ["chosen"], tools: ["Read", "Write", "Bash"] } }));

test("selected worker skills enter the actual member prompt and attenuate tools; read-only seats drop them", () => {
  const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt: block(), skills: skillCatalog(),
    readFile: () => JSON.stringify({ frozenProfile: { members: selectedMembers() } }) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.team?.members[1]?.role.prompt?.includes("SELECTED_SKILL_BODY"));
  assert.deepEqual(result.team?.members[1]?.role.allowedTools, ["read_file", "write_file"]);
  assert.deepEqual(result.team?.members[0]?.role.skills, []);
  assert.equal(result.team?.members[0]?.role.prompt?.includes("SELECTED_SKILL_BODY"), false);
});

test("missing selected skills and nested fork skills fail explicitly instead of silently ignoring them", () => {
  for (const skills of [undefined, skillCatalog({ ...selectedSkill, name: "other" }),
    skillCatalog({ ...selectedSkill, forkExecution: true })]) {
    const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt: block(),
      ...(skills === undefined ? {} : { skills }),
      readFile: () => JSON.stringify({ frozenProfile: { members: selectedMembers() } }) });
    assert.equal(result.ok, false);
  }
});

test("the frozen Work surface carries a member-bound output policy and rejects conflicting prompt metadata", () => {
  const result = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt: block(),
    readFile: () => JSON.stringify({ frozenProfile: { surface: "work", members } }) });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.team?.surface, "work");
    assert.equal(typeof result.team?.constrainTool, "function");
  }
  const conflict = teamProfileFor({ workspaceRoot: "D:/project", systemPrompt: block().replace("decision: spawn_team", "decision: spawn_team\nsurface: code"),
    readFile: () => JSON.stringify({ frozenProfile: { surface: "work", members } }) });
  assert.equal(conflict.ok, false);
});
