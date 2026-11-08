import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { handleAuthDelete, handleAuthList, handleAuthSwitch, handleLogin, handleLogout } from "./commands-auth.js";
import { parseLogout, parseAuthDelete } from "./args-auth.js";

/**
 * D6 #14/#15：凭据删不掉 + logout 吞 --account。
 *
 * #14：auth 面缺删除动词（logout 只清指针，secret 留盘）。内部 delete 原语
 * 早就存在（current 指针保护），缺的只是 CLI 动词——补上。
 * #15：parseLogout 静默丢弃 --account 还报成功；无账号概念的动词收到账号旗
 * 必须是用法错误。
 */

function recorded(homeDir: string) {
  const out: string[] = [];
  const err: string[] = [];
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

  return { ctx, out, err };
}

function tempHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "trylo-authdel-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function ledgerOf(home: string): string {
  return readFileSync(join(home, ".trylo", "credentials.json"), "utf8");
}

test("D6: auth delete removes the record and its secret from disk", async (t) => {
  const home = tempHome(t);
  const fx = recorded(home);

  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-a" }), EXIT_CODES.OK);
  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-b" }), EXIT_CODES.OK);
  assert.equal(ledgerOf(home).includes("seed-secret"), true);
  // 当前指针在 acc-b（刚登录过它）：先指回 acc-a 才能删 acc-b。
  assert.equal(handleAuthSwitch(fx.ctx, { provider: "openai-compatible", account: "acc-a" }), EXIT_CODES.OK);
  assert.equal(handleAuthDelete(fx.ctx, { provider: "openai-compatible", account: "acc-b" }), EXIT_CODES.OK);
  assert.match(fx.out.join(""), /deleted openai-compatible account acc-b/);
  fx.out.length = 0;
  assert.equal(handleAuthList(fx.ctx, false, false), EXIT_CODES.OK);
  assert.equal(fx.out.join("").includes("acc-b"), false);
  // 清指针再删剩下的：盘上不再有任何 secret 残留。
  assert.equal(handleLogout(fx.ctx, { provider: "openai-compatible" }), EXIT_CODES.OK);
  assert.equal(handleAuthDelete(fx.ctx, { provider: "openai-compatible", account: "acc-a" }), EXIT_CODES.OK);
  assert.equal(ledgerOf(home).includes("seed-secret"), false);
});

test("D6: auth delete refuses the current pointer and unknown accounts", async (t) => {
  const home = tempHome(t);
  const fx = recorded(home);

  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-a" }), EXIT_CODES.OK);
  assert.equal(handleAuthDelete(fx.ctx, { provider: "openai-compatible", account: "acc-a" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /current/);
  assert.equal(handleAuthDelete(fx.ctx, { provider: "openai-compatible", account: "nosuch" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /unknown_account|unknown account/);
});

test("D6: auth delete parses --account and logout refuses it", () => {
  const parsed = parseAuthDelete(["--provider", "openai-compatible", "--account", "acc-a"]);

  assert.equal(parsed.kind, "auth_delete");

  if (parsed.kind !== "auth_delete") {
    throw new Error("unreachable");
  }

  assert.equal(parsed.options.account, "acc-a");
  assert.equal(parseAuthDelete(["--provider", "openai-compatible"]).kind, "error");

  const logout = parseLogout(["--provider", "openai-compatible", "--account", "acc-a"]);

  assert.equal(logout.kind, "error");

  if (logout.kind !== "error") {
    throw new Error("unreachable");
  }

  assert.match(logout.message, /--account/);
});

test("D6: logout still clears the pointer and reports it", async (t) => {
  const home = tempHome(t);
  const fx = recorded(home);
  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-a" }), EXIT_CODES.OK);
  assert.equal(handleLogout(fx.ctx, { provider: "openai-compatible" }), EXIT_CODES.OK);
  assert.match(fx.out.join(""), /logged out openai-compatible/);
});
