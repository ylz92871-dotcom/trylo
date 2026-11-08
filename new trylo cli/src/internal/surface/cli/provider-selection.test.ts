import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { CliContext } from "./context.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { selectRunProvider } from "./provider-selection.js";

/**
 * D5 P2-2: unknown provider 的 hint 必须同时给两条路。
 *
 * 974e42e 之后 `run --provider <声明id>` 可直用，但 hint 只教 switch。
 * 跑一次挂掉的用户最需要的是"我刚打的那行怎么改"，不是先去 switch。
 */

function ctx(): CliContext {
  return {
    env: {},
    homeDir: "/home/user",
    cwd: "/workspace",
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => {},
    stderr: () => {},
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };
}

test("D5: an unknown provider hint offers both the direct run and switch", () => {
  const result = selectRunProvider(ctx(), {
    flagProvider: "nosuch",
    endpoint: "https://lab.example/v1",
    model: "lab-7b",
  });

  assert.equal("providerId" in result, false, "expected a failure, not a provider");

  if ("providerId" in result) {
    throw new Error("unreachable");
  }

  assert.match(result.message, /unknown provider nosuch/);
  assert.match(result.hint, /trylo run --provider/);
  assert.match(result.hint, /providers switch/);
});

test("a project model overrides only its explicitly matched provider without writing configuration", () => {
  const base = ctx();
  const endpoint = "https://developer.amd.com.cn/radeon/api/v1/chat/completions";
  const providers = [
    { id: "amd", kind: "openai-compatible", endpoint, model: "DeepSeek-V4-Flash-Vision-Exp", accountId: "amd-account" },
    { id: "other", kind: "openai-compatible", endpoint: "https://other.example/v1", model: "other-model", accountId: "other-account" },
  ];
  let selected = "amd";
  let project: Record<string, string> = { provider: "amd", model: "DeepSeek-V4-Flash" };
  let user: Record<string, string> = {};
  let writes = 0;
  const memory: CliContext = { ...base,

    readFile: file => {
      const normalized = path.normalize(file);
      if (normalized === path.join(base.homeDir, ".trylo", "providers.json")) return JSON.stringify({ version: 1, selected, providers });
      if (normalized === path.join(base.homeDir, ".trylo", "config.json")) return JSON.stringify(user);
      if (normalized === path.join(base.cwd, ".trylo", "config.json")) return JSON.stringify(project);
      return undefined;
    },

    writeFile: () => {
      writes++;
      throw new Error("connection selection must not write configuration");
    },
  };
  const resolve = (overrides: { readonly model?: string; readonly provider?: string } = {}) => {
    const result = resolveConnectionSettings(memory, { message: [], readStdin: false, ...overrides });
    if ("exitCode" in result) assert.fail(result.message);
    return result.provider;
  };
  const matched = resolve();

  assert.equal(matched.providerId, "amd");
  assert.equal(matched.model, "DeepSeek-V4-Flash");
  assert.equal(matched.endpoint, endpoint);
  assert.equal(matched.accountId, "amd-account");
  const flagged = resolve({ model: "explicit-flag-model" });

  assert.equal(flagged.model, "explicit-flag-model");
  assert.equal(flagged.endpoint, endpoint);
  assert.equal(flagged.accountId, "amd-account");
  assert.equal(resolve({ provider: "amd" }).model, "DeepSeek-V4-Flash-Vision-Exp", "an explicit provider flag replaces the project provider layer even when its id matches");

  selected = "other";
  const other = resolve();

  assert.equal(other.providerId, "other");
  assert.equal(other.model, "other-model");
  assert.equal(other.endpoint, "https://other.example/v1");
  assert.equal(other.accountId, "other-account");

  selected = "amd";
  user = { provider: "amd" };
  project = { model: "DeepSeek-V4-Flash" };
  assert.equal(resolve().model, "DeepSeek-V4-Flash-Vision-Exp", "a project model cannot borrow its provider from the user layer");
  assert.equal(writes, 0);
});
