import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createSkillCatalog } from "../../adapters/skills/catalog.js";
import { createNodeSkillReader, discoverSkills } from "../../adapters/skills/discover.js";
import { createSkillForkExecutor, SKILL_TOOL_NAME } from "../../adapters/tools/skill/index.js";
import { wirePorts } from "./wiring.js";
import { createDenyAllPermission } from "./permission.js";
import { skillsPortFor } from "./skills-wiring.js";
import type { ToolCallRequest, ToolPort } from "../../ports/tools.js";
import { createRunExecution, type RunExecution } from "./run-execution-wiring.js";

/**
 * Composition-root wiring for skills (WP14.2/14.3).
 *
 * Proven against a real temporary directory and the real `wirePorts`: the
 * catalog the run host freezes per turn reaches the tool table, a skill call
 * through the *wired* port returns the skill body, a run with no skills keeps
 * the old catalog, and a fork skill with the subagent switch off refuses
 * terminally instead of going inline.
 */

let workspace = "";
let home = "";
const executions: RunExecution[] = [];

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "trylo-skill-wire-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "trylo-skill-wire-home-"));
  const projectSkill = path.join(workspace, ".trylo", "skills", "greet");

  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(
    path.join(projectSkill, "SKILL.md"),
    "---\ndescription: greets someone\n---\nGreet $ARGUMENTS warmly.",
  );
  const forkSkill = path.join(workspace, ".trylo", "skills", "deep-dive");

  mkdirSync(forkSkill, { recursive: true });
  writeFileSync(
    path.join(forkSkill, "SKILL.md"),
    "---\ndescription: runs forked\ncontext: fork\n---\nFork body.",
  );
});

after(async () => {
  for (const execution of executions) await execution.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function wiredSkills(): NonNullable<ReturnType<typeof skillsPortFor>["catalog"]> {
  const wired = skillsPortFor(home, {}, workspace);
  assert.notEqual(wired.catalog, undefined);
  return wired.catalog!;
}

function wire(skills?: ReturnType<typeof skillsPortFor>["catalog"]) {
  // This contract exercises skill composition with denied business tools;
  // it does not claim Windows sandbox/packaged-helper acceptance.
  const execution = createRunExecution(workspace, { shellIsolation: "host" });
  executions.push(execution);
  const wiring = wirePorts({
    providerId: "fixture",
    model: "test-model",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: workspace,
    execution,
    permission: createDenyAllPermission(),
    ...(skills === undefined ? {} : { skills }),
  });
  if ("code" in wiring) {
    throw new Error(`wiring failed: ${wiring.code}`);
  }

  return wiring;
}

function skillCall(arguments_: Record<string, string>): ToolCallRequest {
  return { toolCallId: "t-wire", name: SKILL_TOOL_NAME, arguments: arguments_ };
}

test("disabling the builtin browser fallback and having no installed skills leaves the catalog empty", () => {
  const empty = skillsPortFor(home, { TRYLO_MEDIA_CONFIG: JSON.stringify({ version: 1, browserFallback: false }) }, path.join(workspace, "nowhere"));
  assert.equal(empty.catalog, undefined);
  const wiring = wire(undefined);
  assert.equal(wiring.ports.tools.snapshot().some((binding) => binding.name === SKILL_TOOL_NAME), false);
});

test("a fresh run discovers and loads the official browser-media skill without global prompt injection", () => {
  const builtins = skillsPortFor(home, {}, path.join(workspace, "nowhere")).catalog!;
  assert.deepEqual(builtins.list().map(skill => skill.name), ["browser-media-creation"]);
  const loaded = builtins.load("browser-media-creation", "");
  assert.equal(loaded.kind, "loaded");
  if (loaded.kind === "loaded") assert.match(loaded.skill.content, /login/);
});

test("a run with skills mounts the skill tool and serves a model call", async () => {
  const wiring = wire(wiredSkills());
  assert.equal(wiring.ports.tools.snapshot().some((binding) => binding.name === SKILL_TOOL_NAME), true);
  const outcome = await wiring.ports.tools.execute(skillCall({ skill: "greet", args: "the crew" }), new AbortController().signal);
  assert.equal(outcome.outcome, "result");
  if (outcome.outcome !== "result") return;
  assert.match(outcome.output, /Greet the crew warmly\./);
});

test("a fork skill with the subagent switch off refuses terminally", async () => {
  const wiring = wire(wiredSkills());
  const outcome = await wiring.ports.tools.execute(skillCall({ skill: "deep-dive" }), new AbortController().signal);
  assert.equal(outcome.outcome, "error");
  if (outcome.outcome !== "error") return;
  assert.equal(outcome.code, "skill_fork_unavailable");
});

test("the fork executor forwards to the subagent port with the skill as prompt", async () => {
  const seen: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const delegate: ToolPort = {
    snapshot: () => [],

    async execute(call: ToolCallRequest) {
      seen.push({ name: call.name, arguments: call.arguments });
      return { outcome: "result", value: {}, output: "delegated", truncated: false };
    },

    async cancel(): Promise<void> {},
  };
  const executor = createSkillForkExecutor({ delegate: () => delegate });
  const outcome = await executor({
    toolCallId: "t-fork",
    name: "deep-dive",
    prompt: "Fork body.",
    allowedTools: ["read_file"],
    signal: new AbortController().signal,
  });

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome !== "result") return;

  assert.equal(outcome.output, "delegated");
  assert.equal(seen[0]?.name, "delegate_subagent");
  assert.equal(seen[0]?.arguments["taskName"], "skill:deep-dive");
  assert.equal(seen[0]?.arguments["prompt"], "Fork body.");
});

test("the frozen catalog composes from a real discovery snapshot", () => {
  const discovery = discoverSkills(
    [{ source: "project", directory: path.join(workspace, ".trylo", "skills") }],
    createNodeSkillReader(),
  );
  const catalog = createSkillCatalog(discovery.skills);

  assert.deepEqual(catalog.list().map((skill) => skill.name).sort(), ["deep-dive", "greet"]);
  const loaded = catalog.load("greet", "you");

  assert.equal(loaded.kind, "loaded");

  if (loaded.kind !== "loaded") return;

  assert.match(loaded.skill.content, /Greet you warmly\./);
});
