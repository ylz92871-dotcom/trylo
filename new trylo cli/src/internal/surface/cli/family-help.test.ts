import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { parseArgs } from "./args.js";
import { dispatch } from "./commands.js";
import type { CliContext } from "./context.js";

/**
 * D6 #19: 子命令级 --help。
 *
 * `providers --help` 曾是 exit 2（unknown subcommand），verb 级 --help 洒的是
 * 全量 USAGE。本面帮助按家族切片（由 USAGE 派生，零漂移），裸 `providers`
 * 仍是用法错误。
 */

function ctxOf(): { ctx: CliContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
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

  return { ctx, out, err };
}

async function helpFor(argv: ReadonlyArray<string>): Promise<{ code: number; out: string }> {
  const { ctx, out } = ctxOf();
  const parsed = parseArgs(argv);
  if (parsed.kind !== "family_help") {
    throw new Error(`expected family_help for ${argv.join(" ")}, got ${parsed.kind}`);
  }

  const code = await dispatch(parsed, ctx);

  return { code, out: out.join("") };
}

test("D6: every subcommand family answers --help with its own surface", async () => {
  for (const [family, marker] of [
    ["providers", "providers add"],
    ["auth", "auth switch"],
    ["mcp", "mcp list"],
    ["session", "session list"],
    ["checkpoint", "checkpoint list"],
    ["config", "config show"],
  ] as const) {
    const { code, out } = await helpFor([family, "--help"]);
    assert.equal(code, EXIT_CODES.OK, family);
    assert.ok(out.includes(marker), `${family} help misses ${marker}`);
    assert.equal(out.includes("run [options]"), false, `${family} help leaks the global surface`);
  }
});

test("D6: verb-level --help stays inside the family, bare family stays an error", async () => {
  const { code, out } = await helpFor(["providers", "add", "--help"]);

  assert.equal(code, EXIT_CODES.OK);
  assert.ok(out.includes("providers add"));
  const login = await helpFor(["login", "--help"]);

  assert.equal(login.code, EXIT_CODES.OK);
  assert.ok(login.out.includes("auth list"));

  const { ctx, err } = ctxOf();
  const bare = parseArgs(["providers"]);

  assert.equal(bare.kind, "error");
  assert.equal(await dispatch(bare, ctx), EXIT_CODES.USAGE);
  assert.ok(err.join("").includes("subcommand"));
});
