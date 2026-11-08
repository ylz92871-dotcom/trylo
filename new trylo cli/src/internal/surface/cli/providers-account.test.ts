import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { handleLogin } from "./commands-auth.js";
import { handleProvidersAdd, handleProvidersEdit } from "./commands-providers.js";
import { runCredentialFor } from "./provider-selection.js";

/**
 * D7 #13: `providers add/edit --account <不存在>` 零校验。
 *
 * 一条命令弄瘫整个 profile：之后所有 run → 41，还指去查 credentials.json，
 * 真凶却在 providers.json。修两处：写时校验（usage 拒，盘不动）；
 * 跑时悬空绑定落 52（config）并点名声明，不再报 41。
 */

type Recorded = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, string>;
};

function recorded(homeDir: string): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  // 注意：凭据账本走真实 fs（以 homeDir 为根），所以这里必须用真临时目录；
  // 用 "/home/user" 会落盘污染整机（D:\home），还会毒化其它用同 home 的测试。
  const files = new Map<string, string>();
  const ctx: CliContext = {
    env: {},
    homeDir,
    cwd: "/workspace",
    nodeVersion: "v22.0.0",
    stdinIsTty: true,
    readFile: (path) => files.get(path),
    isDirectory: () => true,
    readDir: () => [],

    writeFile: (path, text) => {
      files.set(path, text);
      return true;
    },

    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => "seed-secret",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, err, files };
}

const ADD = {
  id: "lab",
  kind: "openai-compatible" as const,
  endpoint: "https://lab.example/v1",
  model: "lab-7b",
};

test("D7: add with an unknown account is refused and writes nothing", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-acct-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = recorded(home);
  const code = handleProvidersAdd(fx.ctx, { ...ADD, account: "nosuch" });

  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /unknown account nosuch/);
  assert.match(fx.err.join(""), /auth list/);
  assert.equal(fx.files.size, 0);
});

test("D7: a stored account passes, and edit to an unknown one is refused", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-acct-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = recorded(home);

  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-old" }), EXIT_CODES.OK);
  assert.equal(handleProvidersAdd(fx.ctx, { ...ADD, account: "acc-old" }), EXIT_CODES.OK);

  const path = `${home}/.trylo/providers.json`;
  const before = fx.files.get(path);

  assert.equal(handleProvidersEdit(fx.ctx, { id: "lab", account: "nosuch" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /unknown account nosuch/);
  assert.equal(fx.files.get(path), before);
});

test("D7: a run bound to a dangling account fails config, not auth", (t) => {
  const home = mkdtempSync(join(tmpdir(), "trylo-acct-"));

  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = recorded(home);
  const result = runCredentialFor(fx.ctx, "openai-compatible", "nosuch");

  assert.equal("exitCode" in result, true, "expected a failure, not a credential");

  if (!("exitCode" in result)) {
    throw new Error("unreachable");
  }

  assert.equal(result.exitCode, EXIT_CODES.CONFIG);
  assert.notEqual(result.exitCode, EXIT_CODES.AUTH);
  assert.match(result.message, /providers\.json/);
  assert.match(result.hint, /providers edit/);
});
