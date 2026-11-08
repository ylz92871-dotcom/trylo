import assert from "node:assert/strict";
import test from "node:test";
import { handleSkillLearning, parseSkillLearningCommand } from "./commands-skill-learning.js";
import type { CliContext } from "./context.js";
import type { SkillLearningCommandPort } from "./skill-learning-command-contract.js";

function context() {
  const output: string[] = [], errors: string[] = [];
  const ctx: CliContext = { cwd: "D:/workspace", homeDir: "D:/profile", env: {}, nodeVersion: "v24", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: text => output.push(text), stderr: text => errors.push(text), now: () => 0, newId: name => name };
  return { ctx, output, errors };
}

test("skills management validates budgets and exact version operands before opening a host", () => {
  assert.deepEqual(parseSkillLearningCommand(["learn", "--max-tokens", "2000", "--max-calls", "2", "--json"]), { kind: "learn", maxTokens: 2000, maxCalls: 2 });
  assert.deepEqual(parseSkillLearningCommand(["show", "skill-v1", "--json"]), { kind: "show", versionId: "skill-v1" });
  assert.deepEqual(parseSkillLearningCommand(["learn", "--max-tokens", "12000", "--max-calls", "12", "--allow-writes", "--allow-exec"]),
    { kind: "learn", maxTokens: 12000, maxCalls: 12, permissionChoice: { allowWrites: true, allowTools: ["run_shell"] } });
  assert.equal(parseSkillLearningCommand(["list", "--allow-exec"]).kind, "error");
  assert.deepEqual(parseSkillLearningCommand(["learn", "--max-tokens", "12000", "--max-calls", "12", "--allow-writes", "--allow-exec", "--allow-skill-trial"]),
    { kind: "learn", maxTokens: 12000, maxCalls: 12, permissionChoice: { allowWrites: true, allowTools: ["run_shell", "skill"] } });

  for (const args of [["withdraw"], ["withdraw", "--all"], ["learn", "--max-tokens", "-1", "--max-calls", "2"],
    ["learn", "--max-tokens", "100001", "--max-calls", "2"], ["learn", "--max-calls", "2", "--max-calls", "2"]]) {
    assert.equal(parseSkillLearningCommand(args).kind, "error");
  }
});

test("independent learning accepts only an explicit valid runtime shell isolation choice", () => {
  const base = ["learn", "--max-tokens", "12000", "--max-calls", "12"];

  assert.deepEqual(parseSkillLearningCommand([...base, "--shell-isolation", "host"]),
    { kind: "learn", maxTokens: 12000, maxCalls: 12, shellIsolation: "host" });
  assert.deepEqual(parseSkillLearningCommand([...base, "--shell-isolation", "sandbox"]),
    { kind: "learn", maxTokens: 12000, maxCalls: 12, shellIsolation: "sandbox" });

  for (const args of [["list", "--shell-isolation", "host"], [...base, "--shell-isolation", "invalid"],
    [...base, "--shell-isolation"], [...base, "--shell-isolation", "host", "--shell-isolation", "host"]]) {
    assert.equal(parseSkillLearningCommand(args).kind, "error");
  }
});

test("skills handler emits one versioned JSON receipt and forwards only the allocated budget", async () => {
  const fx = context(), calls: unknown[] = [];
  const port: SkillLearningCommandPort = {
    list: async () => ({ schemaVersion: 1, ok: true, workspaceId: "workspace-1", skills: [] }),
    show: async () => ({ schemaVersion: 1, ok: false, code: "not_found", message: "missing version" }),
    withdraw: async versionId => ({ schemaVersion: 1, ok: true, versionId, status: "withdrawn" }),
    learn: async (allowance, signal) => { calls.push({ allowance, aborted: signal.aborted });
    return { schemaVersion: 1, ok: true,
      result: { status: "waiting", reason: "needs_more_evidence", usage: { calls: 0, usageStatus: "missing" } } }; },
  };

  assert.equal(await handleSkillLearning(fx.ctx, ["learn", "--max-tokens", "2000", "--max-calls", "2"], port), 0);
  assert.deepEqual(calls, [{ allowance: { maxTokens: 2000, maxCalls: 2 }, aborted: false }]);
  assert.equal(fx.output.length, 1);
  assert.deepEqual(JSON.parse(fx.output[0]!).result.usage, { calls: 0, usageStatus: "missing" });
  const missing = context();

  assert.notEqual(await handleSkillLearning(missing.ctx, ["show", "foreign-version"], port), 0);
  assert.equal(JSON.parse(missing.output[0]!).code, "not_found");
});
