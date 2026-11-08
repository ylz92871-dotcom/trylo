import assert from "node:assert/strict";
import { test } from "node:test";
import { teamProfileFor } from "./team-profile-wiring.js";

const members = ["person", "worker"].map(baseRole => ({ memberId: `m-${baseRole}`, baseRole,
  displayName: baseRole, overlay: { model: "inherit", skills: [], systemPromptOverlay: "bounded task" } }));
const block = (runId: string) => `<trylo_team_access>\ndecision: spawn_team\nteamRunId: ${runId}\n${members.map(member =>
  `- member_id=${member.memberId} baseRole=${member.baseRole} displayName=${member.displayName}`).join("\n")}\n</trylo_team_access>`;
const readFile = () => JSON.stringify({ frozenProfile: { members } });

test("replacement and append prompt entries both load the same frozen identities", () => {
  for (const entry of [{ systemPrompt: block("team-replace") }, { systemPromptAppend: block("team-append") },
    { systemPrompt: "base rules", systemPromptAppend: block("team-mixed") }]) {
    const input = { workspaceRoot: "D:/fixture", readFile, ...entry };
    const result = teamProfileFor(input);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.team?.members.map(member => member.memberId), ["m-person", "m-worker"]);
  }
});

test("two frozen teams across replacement and append entries refuse instead of silently choosing one", () => {
  const input = { workspaceRoot: "D:/fixture", readFile, systemPrompt: block("first"), systemPromptAppend: block("second") };
  assert.equal(teamProfileFor(input).ok, false);
});
