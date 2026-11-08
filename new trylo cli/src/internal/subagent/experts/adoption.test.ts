import assert from "node:assert/strict";
import test from "node:test";
import { teamProfileFor } from "../../surface/cli/team-profile-wiring.js";
import type { ToolBinding } from "../../ports/tools.js";
import type { ExpertVersion } from "./contracts.js";
import { instantiateExpert } from "./instantiate.js";
import { applyExpertToTeam } from "./dispatch.js";

test("adopting an expert into a real frozen team retains existing guidance, constraints and boundary identity", async () => {
  const rows = ["person", "worker"].map(baseRole => ({ memberId: `m-${baseRole}`, baseRole, displayName: baseRole,
    overlay: { model: "model1", skills: [], tools: ["Read", "WebFetch"], disallowedTools: ["WebFetch"],
      systemPromptOverlay: "PRESERVE_EXISTING_USER_CONSTRAINT" } }));
  const prompt = `<trylo_team_access>\ndecision: spawn_team\nteamRunId: adoption-run\nTRYLO_TEAM_HOLD: worker\n${rows.map(row =>
    `- member_id=${row.memberId} baseRole=${row.baseRole} displayName=${row.displayName}`).join("\n")}\n<trylo_engineering_contract>KEEP_ENGINEERING_CONTRACT</trylo_engineering_contract>\n<trylo_team_translation audience="seat:worker">KEEP_TRANSLATION</trylo_team_translation>\n</trylo_team_access>`;
  const loaded = teamProfileFor({ workspaceRoot: "D:/test", systemPrompt: prompt,
    readFile: () => JSON.stringify({ frozenProfile: { members: rows } }) });

  assert.equal(loaded.ok, true);

  if (!loaded.ok || loaded.team === undefined) throw new Error("Expected a loaded team");

  const team = { ...loaded.team, constrainTool: () => ({ ok: false as const, code: "existing_gate", message: "existing gate" }),
    members: loaded.team.members.map(member => member.baseRole === "worker" ? { ...member, role: { ...member.role, maxIterations: 3 } } : member) };
  const expert: ExpertVersion = { expertId: "sql-expert", version: 1, experienceKey: "expert:sql-expert", createdAt: 1, requestId: "r1",
    configuration: { displayName: "SQL reviewer", specialty: "Query plan inspection", situations: ["Slow SQL"],
      responsibilities: ["Inspect cardinality evidence"], constraints: ["Preserve data"], collaboration: ["Report plan evidence"],
      baseRole: "worker", role: { name: "worker", description: "SQL expertise", allowedTools: ["read_file", "web_fetch"], maxIterations: 5 },
      toolRefs: [], methods: [{ title: "Plan evidence", instructions: "Read the plan before proposing an index", sourceUris: ["https://example.test/plans"] }],
      sources: [{ kind: "community", title: "Plan guide", uri: "https://example.test/plans", excerpt: "Read the plan" }] } };
  const catalog: ToolBinding[] = ["read_file", "web_fetch"].map(name => ({ name, description: name, sideEffect: "read_only",
    parameters: {}, needsApproval: true, timeoutMs: 100, outputLimits: { maxBytes: 1000, maxLines: 100 } }));
  const instance = await instantiateExpert({ expert, runId: team.runId, surface: "code", memberId: "m-worker", task: "Review query",
    catalog, parent: { model: "model1", allowedTools: catalog.map(tool => tool.name), maxIterations: 10 }, signal: new AbortController().signal,
    experience: { async load() { return { text: "Check skew", versionIds: ["exp:v1"] }; } } });

  assert.equal(instance.overlay, undefined);
  const result = applyExpertToTeam({ team, instance, boundary: "handoff", occupiedMemberIds: new Set() });
  const adopted = result.team.members.find(member => member.memberId === "m-worker")!;

  for (const instruction of ["PRESERVE_EXISTING_USER_CONSTRAINT", "KEEP_ENGINEERING_CONTRACT", "KEEP_TRANSLATION", "Read the plan before proposing an index", "Check skew"]) {
    assert.ok(adopted.role.prompt!.includes(instruction), instruction);
  }

  assert.deepEqual(adopted.role.allowedTools, ["read_file"]);
  assert.deepEqual(adopted.role.disallowedTools, ["web_fetch"]);
  assert.equal(adopted.role.maxIterations, 3);
  assert.equal(result.team.constrainTool, team.constrainTool);
  assert.equal(result.team.inspectRepresentation, team.inspectRepresentation);
  assert.equal(result.team.heldRoles, team.heldRoles);
  assert.equal(team.members[1]!.role.prompt!.includes("Plan evidence"), false);
  assert.deepEqual(result.adoption.identity, instance.identity);
  assert.deepEqual(result.adoption.experienceVersionIds, ["exp:v1"]);
  assert.throws(() => applyExpertToTeam({ team: result.team, instance, boundary: "handoff", occupiedMemberIds: new Set() }), /pristine frozen member configuration/);
  assert.throws(() => applyExpertToTeam({ team, instance, boundary: "handoff", occupiedMemberIds: new Set(["m-worker"]) }), /running member/);
  assert.throws(() => applyExpertToTeam({ team, instance: { ...instance, runId: "different" }, boundary: "composition", occupiedMemberIds: new Set() }), /team run/);
  const fixedDifferentModel = { ...team, members: team.members.map(member => ({ ...member, role: { ...member.role, model: "different-model" } })) };

  assert.throws(() => applyExpertToTeam({ team: fixedDifferentModel, instance, boundary: "composition", occupiedMemberIds: new Set() }), /fixed team member model/);
});
