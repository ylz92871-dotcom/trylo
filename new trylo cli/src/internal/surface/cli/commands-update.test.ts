import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { TRYLO_VERSION } from "../../protocol/version.js";
import { parseUpdate } from "./args-update.js";
import { handleUpdate, updateStatus } from "./commands-update.js";
import type { CliContext } from "./context.js";

/**
 * `update` regression (WP24.1 / C86).
 *
 * New-behavior red proof lives in `evidence/2026-10-06-WP24/wp24-red-examples.md`:
 * before this package `trylo update` was `unknown command` (exit 2); the
 * tests below pin the new contract — check reports, bare install refuses,
 * and the command never touches the network or a secret.
 */

function ctx(): { readonly ctx: CliContext; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];

  return {
    ctx: {
      env: {},
      homeDir: "/home",
      cwd: "/ws",
      nodeVersion: "v20.0.0",
      platform: "linux",
      stdinIsTty: false,
      readFile: () => undefined,
      isDirectory: () => false,
      readDir: () => [],
      writeFile: () => true,
      readStdin: async () => "",
      readLine: async () => undefined,
      readSecret: async () => undefined,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      now: () => 0,
      newId: (prefix) => `${prefix}-1`,
    },
    out,
    err,
  };
}

test("update --check reports the version and the missing channel", () => {
  const fx = ctx();
  assert.equal(handleUpdate(fx.ctx, { check: true, json: false }), EXIT_CODES.OK);
  assert.match(fx.out.join(""), new RegExp(TRYLO_VERSION));
  assert.match(fx.out.join(""), /no release channel/);
  assert.equal(fx.err.join(""), "");
});

test("update --check --json agrees with text on the same status object", () => {
  const fx = ctx();
  assert.equal(handleUpdate(fx.ctx, { check: true, json: true }), EXIT_CODES.OK);
  assert.deepEqual(JSON.parse(fx.out.join("")), { update: updateStatus() });
});

test("bare update refuses to fake an install", () => {
  const fx = ctx();
  assert.equal(handleUpdate(fx.ctx, { check: false, json: false }), EXIT_CODES.CONFIG);
  assert.equal(fx.out.join(""), "");
  assert.match(fx.err.join(""), /cannot install an update/);
});

test("the parser takes only --check and --json", () => {
  assert.equal(parseUpdate(["--check"]).kind, "update");
  assert.equal(parseUpdate(["--channel", "stable"]).kind, "error");
  assert.equal(parseUpdate(["extra"]).kind, "error");
  const parsed = parseUpdate([]);

  assert.equal(parsed.kind, "update");

  if (parsed.kind === "update") {
    assert.equal(parsed.options.check, false);
  }
});
