import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { resolveOutputStyleAppend } from "./output-style-resolve.js";

/**
 * Style-resolution regression (WP24.2 / L48).
 *
 * Split out of `run-command.ts` for the 400-line gate; the contract is
 * unchanged: absent/default reads nothing, a bad name is a usage error, an
 * unknown name refuses with CONFIG before any session opens.
 */

function ctxFor(dir: string): CliContext {
  return {
    env: { TRYLO_HOME: join(dir, "home") },
    homeDir: dir,
    cwd: dir,
    nodeVersion: "v20.0.0",
    platform: "linux",
    stdinIsTty: false,

    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,

    readDir: (absolutePath: string) => {
      try {
        return readdirSync(absolutePath).map((name) => ({ name, bytes: 0, modifiedAtMs: 0 }));
      } catch {
        return [];
      }
    },

    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => 0,
    newId: (prefix) => `${prefix}-test`,
  };
}

test("absent or default resolves to nothing without reading", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-style-resolve-"));
  try {
    const ctx = ctxFor(dir);
    assert.deepEqual(resolveOutputStyleAppend(ctx, dir, undefined), {});
    assert.deepEqual(resolveOutputStyleAppend(ctx, dir, "default"), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a known style resolves to its prompt; unknown and malformed refuse", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-style-resolve-"));
  try {
    mkdirSync(join(dir, ".trylo", "output-styles"), { recursive: true });
    writeFileSync(join(dir, ".trylo", "output-styles", "terse.md"), "Answer briefly.\n");
    const ctx = ctxFor(dir);

    assert.deepEqual(resolveOutputStyleAppend(ctx, dir, "terse"), { append: "Answer briefly." });
    const missing = resolveOutputStyleAppend(ctx, dir, "nosuch");

    assert.equal("exitCode" in missing && missing.exitCode, EXIT_CODES.CONFIG);
    const malformed = resolveOutputStyleAppend(ctx, dir, "../escape");

    assert.equal("exitCode" in malformed && malformed.exitCode, EXIT_CODES.USAGE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
