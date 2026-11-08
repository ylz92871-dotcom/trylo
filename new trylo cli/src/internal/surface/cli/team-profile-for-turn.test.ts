import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillCatalogPort, SkillDescriptor } from "../../ports/skills.js";
import { teamProfileForTurn } from "./team-profile-for-turn.js";
import { teamProfileFor } from "./team-profile-wiring.js";
import { contentHashOf } from "../../learning/control/hash.js";

const descriptor = (name: string): SkillDescriptor => ({ name, description: name, source: "additional", skillRoot: `D:/skills/${name}`,
  path: `D:/skills/${name}/SKILL.md`, contentHash: contentHashOf(`BODY-${name}`), body: `BODY-${name}`,
  userInvocable: true, disableModelInvocation: false, forkExecution: false });
const catalog = (...names: string[]): SkillCatalogPort => ({ list: () => names.map(descriptor), load(name) {
  return names.includes(name) ? { kind: "loaded", skill: { descriptor: descriptor(name), content: `BODY-${name}` } }
    : { kind: "unknown_skill", name };
} });
const block = "<trylo_team_access>\ndecision: spawn_team\nteamRunId: bridge\n"
  + "- member_id=person baseRole=person displayName=Person\n- member_id=worker baseRole=worker displayName=Worker\n</trylo_team_access>";
const profile = (skills = ["local", "native"]) => JSON.stringify({ frozenProfile: { members: [
  { memberId: "person", baseRole: "person", displayName: "Person", overlay: { model: "inherit", skills: [], systemPromptOverlay: "Inspect" } },
  { memberId: "worker", baseRole: "worker",
  displayName: "Worker", overlay: { model: "inherit", skills, systemPromptOverlay: "Keep frozen instructions", tools: ["Read"] } }] } });
const ctx = (readFile: (path: string) => string | undefined) => ({ readFile, homeDir: "D:/home", env: {}, newId: () => "unused", stderr() {} });
const scaffold = { workspaceRoot: "D:/project", learning: "skill" as const, systemPrompt: { mode: "append" as const, text: block } };

test("Team resolves only explicit missing names, binds the frozen profile and leaves the parent catalog untouched", async () => {
  let reads = 0, content = profile();
  const local = catalog("local");
  const result = await teamProfileForTurn(ctx(() => {
    reads++;
    return content;
  }), scaffold, local, undefined, async input => {
    assert.deepEqual(input.names, ["native"]);
    assert.equal(input.localCatalog, local);
    content = profile(["changed-after-await"]);
    await Promise.resolve();
    return { ok: true, catalog: catalog("local", "native"), provided: [{ origin: "hermes", requestedName: "native", name: "native", contentHash: contentHashOf("BODY-native") }] };
  });

  assert.equal(result.ok, true);

  if (!result.ok) return;

  assert.equal(reads, 1);
  assert.ok(result.team?.members[1]?.role.prompt?.includes("BODY-local"));
  assert.ok(result.team?.members[1]?.role.prompt?.includes("BODY-native"));
  assert.ok(result.team?.members[1]?.role.prompt?.includes("Keep frozen instructions"));
  assert.ok(result.team?.members[1]?.role.prompt?.includes("Current task instructions take precedence over learned procedures"));
  assert.equal(result.team?.members[1]?.role.prompt?.includes("changed-after-await"), false);
  assert.deepEqual(result.team?.members[1]?.role.allowedTools, ["read_file"]);
  assert.deepEqual(local.list().map(item => item.name), ["local"]);
  assert.equal(local.load("native", undefined).kind, "unknown_skill");
  assert.ok(result.onChildRequestDispatched);
  const facts = await result.onChildRequestDispatched({ taskId: "task", agentId: "agent", round: 1, rootAttemptId: "root",
    teamMember: { teamRunId: "bridge", memberId: "worker" }, request: { attemptId: "request", model: "m", tools: [],
      messages: [{ role: "user", content: result.team?.members[1]?.role.prompt ?? "" }] } });

  assert.deepEqual(facts?.[0]?.skills, [{ name: "native", contentHash: contentHashOf("BODY-native") }]);
});

test("ordinary turns, local selections and disabled skill learning never construct a native resolver", async () => {
  let nativeCalls = 0;
  const resolve: NonNullable<Parameters<typeof teamProfileForTurn>[4]> = async () => {
    nativeCalls++;
    throw new Error("unexpected native IO");
  };
  const ordinary = await teamProfileForTurn(ctx(() => { throw new Error("unexpected team IO"); }),
    { workspaceRoot: "D:/project", learning: "all" }, undefined, undefined, resolve);

  assert.deepEqual(ordinary, { ok: true });
  const withoutLearning = { workspaceRoot: scaffold.workspaceRoot, systemPrompt: scaffold.systemPrompt };

  for (const learning of [undefined, "user", "method"] as const) {
    const result = await teamProfileForTurn(ctx(() => profile()), { ...withoutLearning, ...(learning === undefined ? {} : { learning }) },
      catalog("local"), undefined, resolve);
    assert.equal(result.ok, false, "disabled integration preserves the original missing-skill refusal");
  }

  const installed = await teamProfileForTurn(ctx(() => profile(["local"])), scaffold, catalog("local"), undefined, resolve);

  assert.equal(installed.ok, true);
  assert.deepEqual(installed, teamProfileFor({ workspaceRoot: scaffold.workspaceRoot, systemPrompt: block,
    readFile: () => profile(["local"]), skills: catalog("local") }));
  assert.equal(nativeCalls, 0);
});

test("native failure and thrown diagnostics cannot produce an incomplete role or expose raw dependency text", async () => {
  const unavailable = await teamProfileForTurn(ctx(() => profile()), scaffold, catalog("local"), undefined,
    async () => ({ ok: false, code: "hermes_explicit_unavailable" }));

  assert.deepEqual(unavailable, { ok: false, message: "Selected team skill could not be loaded (hermes_explicit_unavailable)." });
  const thrown = await teamProfileForTurn(ctx(() => profile()), scaffold, catalog("local"), undefined,
    async () => { throw new Error("PRIVATE_DEPENDENCY_DIAGNOSTIC"); });

  assert.equal(thrown.ok, false);
  assert.equal(JSON.stringify(thrown).includes("PRIVATE_DEPENDENCY_DIAGNOSTIC"), false);
});

test("the previous local-only Team boundary cannot consume this valid native-only selection", () => {
  const legacy = teamProfileFor({ workspaceRoot: scaffold.workspaceRoot, systemPrompt: block,
    readFile: () => profile(), skills: catalog("local") });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.match(legacy.message, /not installed/);
});
