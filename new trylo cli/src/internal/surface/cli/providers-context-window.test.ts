import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { parseProviders } from "./args-providers.js";
import { handleProvidersAdd, handleProvidersConfig, handleProvidersEdit } from "./commands-providers.js";
import { effectiveContextCeiling } from "./run-command.js";

/**
 * D7 BYOK 压缩面：`providers config` 显示 `declared=not-declared effective=none`，
 * 而 add/edit 根本收不了 context——自动压缩在 BYOK 下永远休眠。
 *
 * 默认预算为 200K；声明的模型容量始终约束用户设置的工作窗口。
 */

type Recorded = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, string>;
};

function recorded(files: Map<string, string> = new Map()): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: {},
    homeDir: "/home/user",
    cwd: "/workspace",
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: (path) => files.get(path),
    isDirectory: () => true,
    readDir: () => [],
    writeFile: (path, text) => {
      files.set(path, text);
      return true;
    },
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };
  return { ctx, out, err, files };
}

const ADD = ["add", "lab", "--kind", "openai-compatible", "--endpoint", "https://lab.example/v1", "--model", "lab-7b"];

function configBudget(fx: Recorded): { declared?: number; effective?: number; overridden: boolean } {
  fx.out.length = 0;
  assert.equal(handleProvidersConfig(fx.ctx, { id: "lab", json: true }), EXIT_CODES.OK);
  const payload = JSON.parse(fx.out.join("")) as { budget: { declared?: number; effective?: number; overridden: boolean } };
  return payload.budget;
}

test("D7: add/edit parse --context-window and refuse non-positive values", () => {
  const added = parseProviders([...ADD, "--context-window", "128000"]);
  assert.equal(added.kind, "providers_add");
  if (added.kind !== "providers_add") {
    throw new Error("unreachable");
  }
  assert.equal(added.options.contextWindow, 128000);
  assert.equal(parseProviders([...ADD, "--context-window", "0"]).kind, "error");
  assert.equal(parseProviders([...ADD, "--context-window", "abc"]).kind, "error");

  const edited = parseProviders(["edit", "lab", "--context-window", "64000"]);
  assert.equal(edited.kind, "providers_edit");
  if (edited.kind !== "providers_edit") {
    throw new Error("unreachable");
  }
  assert.equal(edited.options.contextWindow, 64000);
  assert.equal(parseProviders(["edit", "lab", "--context-window", "-5"]).kind, "error");
});

test("D7: a declared window persists, shows, and becomes the ceiling", () => {
  const fx = recorded();
  const add = parseProviders([...ADD, "--context-window", "128000"]);
  assert.equal(add.kind, "providers_add");
  if (add.kind !== "providers_add") {
    throw new Error("unreachable");
  }
  assert.equal(handleProvidersAdd(fx.ctx, add.options), EXIT_CODES.OK);
  const budget = configBudget(fx);
  assert.equal(budget.declared, 128000);
  assert.equal(budget.effective, 128000);
  assert.equal(budget.overridden, false);
});

test("D7: edit changes the window, and absence keeps the old one", () => {
  const fx = recorded();
  const add = parseProviders([...ADD, "--context-window", "128000"]);
  assert.equal(add.kind, "providers_add");
  if (add.kind !== "providers_add") {
    throw new Error("unreachable");
  }
  assert.equal(handleProvidersAdd(fx.ctx, add.options), EXIT_CODES.OK);
  assert.equal(handleProvidersEdit(fx.ctx, { id: "lab", contextWindow: 64000 }), EXIT_CODES.OK);
  assert.equal(configBudget(fx).effective, 64000);
  assert.equal(handleProvidersEdit(fx.ctx, { id: "lab", model: "lab-70b" }), EXIT_CODES.OK);
  const budget = configBudget(fx);
  assert.equal(budget.effective, 64000);
  assert.equal(budget.declared, 64000);
});

test("D7: the run ceiling defaults to 200K and clamps preferences to declared capacity", () => {
  assert.equal(effectiveContextCeiling(8000, 128000), 8000);
  assert.equal(effectiveContextCeiling(undefined, 128000), 128000);
  assert.equal(effectiveContextCeiling(undefined, undefined), 200000);
  assert.equal(effectiveContextCeiling(400000, 128000), 128000);
  assert.equal(effectiveContextCeiling(undefined, 1000000), 200000);
});
