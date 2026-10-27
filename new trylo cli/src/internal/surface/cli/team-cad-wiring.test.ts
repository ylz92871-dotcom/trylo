import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { teamProfileFor } from "./team-profile-wiring.js";
import { constrainWorkMemberTool } from "./team-work-policy.js";
import { narrowTeamTools } from "../../subagent/team.js";
import type { ToolBinding } from "../../ports/tools.js";

const members = ["person", "cad-planner", "cad-verifier"].map(baseRole => ({
  memberId: `m-${baseRole}`, baseRole, displayName: baseRole,
  overlay: { model: "inherit", skills: [], systemPromptOverlay: "" },
}));
function load(surface: "code" | "work") {
  return teamProfileFor({ workspaceRoot: "D:/workspace",
    systemPrompt: `<trylo_team_access>\ndecision: spawn_team\nsurface: ${surface}\nteamRunId: cad-team\n${members.map(member =>
      `- member_id=${member.memberId} baseRole=${member.baseRole} displayName=${member.displayName}`).join("\n")}\n</trylo_team_access>`,
    readFile: () => JSON.stringify({ frozenProfile: { surface, members } }),
  });
}

test("frozen Work CAD seats load with document-only floors and independent instructions", () => {
  const result = load("work");
  assert.equal(result.ok, true);
  if (!result.ok || !result.team) return;
  const names = ["read_file", "write_file", "edit_file", "apply_patch", "run_shell", "notebook_edit",
    "mcp__trylo-solidworks__create_part", "todo_write", "create_goal"];
  const catalog: ToolBinding[] = names.map(name => ({ name, description: name, parameters: { type: "object", properties: {} },
    sideEffect: "workspace_write", needsApproval: true, timeoutMs: 1000, outputLimits: { maxBytes: 1000, maxLines: 100 } }));
  const narrowed = narrowTeamTools(result.team, catalog);
  for (const member of narrowed.members.slice(1)) {
    assert.deepEqual(member.role.allowedTools, ["read_file", "write_file", "edit_file"]);
    assert.match(member.role.prompt ?? "", /construction-package\.md/);
    assert.match(member.role.prompt ?? "", /SolidWorks/);
  }
  assert.match(narrowed.members[2]!.role.prompt ?? "", /UNVERIFIABLE/);
});

test("CAD seats are unavailable on the Code surface", () => {
  assert.equal(load("code").ok, false);
});

test("CAD seats can write only their own document kind inside the Work deliverable tree", t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-cad-scope-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  for (const name of ["write_file", "edit_file"]) {
    const check = (role: string, target: string) => constrainWorkMemberTool(role, root,
      { name, toolCallId: "cad-write", arguments: { path: target, content: "not a grant" } }).ok;
    assert.equal(check("cad-planner", ".trylo/out/cad-plans/job/construction-package.md"), true);
    for (const kind of ["package-review.md", "verdict.md"]) {
      assert.equal(check("cad-verifier", `.trylo/out/cad-plans/job/${kind}`), true);
      assert.equal(check("cad-planner", `.trylo/out/cad-plans/job/${kind}`), false);
    }
    assert.equal(check("cad-verifier", ".trylo/out/cad-plans/job/construction-package.md"), false);
    for (const role of ["cad-planner", "cad-verifier"]) {
      for (const target of ["work/cad-plans/job/construction-package.md", ".trylo/out/build.py", ".trylo/out/evidence/evidence-report.md"]) {
        assert.equal(check(role, target), false, `${role}: ${target}`);
      }
    }
  }
});
