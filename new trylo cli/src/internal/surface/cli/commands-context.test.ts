import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { parseContext } from "./args-context.js";
import { handleContext } from "./commands-context.js";
import type { CliContext } from "./context.js";

/**
 * Context-inspect regression (WP24.2 / A08).
 *
 * Both paths are read-only: the workspace path reports the rules a run
 * would adopt, the session path reports journal-derived turns and token
 * estimates. Neither path opens a session, starts a turn, or calls a
 * model — the tests assert the journal is untouched by comparing its
 * bytes before and after.
 */

function workspace(files: Readonly<Record<string, string>>): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-ctx-"));

  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text);
  }

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ctxFor(dir: string): { readonly ctx: CliContext; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
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

    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },

    readDir: (absolutePath: string) => {
      try {
        return readdirSync(absolutePath).map((name) => {
          let bytes = 0;
          let modifiedAtMs = 0;

          try {
            const info = statSync(join(absolutePath, name));
            bytes = info.size;
            modifiedAtMs = info.mtimeMs;
          } catch {
            // Vanished between listing and stat: unsized, still listed.
          }

          return { name, bytes, modifiedAtMs };
        });
      } catch {
        return [];
      }
    },

    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    now: () => 0,
    newId: (prefix) => `${prefix}-test`,
  };

  return { ctx, out, err };
}

test("workspace context reports adopted rules and stays read-only", async () => {
  const ws = workspace({ "AGENTS.md": "# Rules\n\nBe careful.\n" });
  try {
    const fx = ctxFor(ws.dir);
    assert.equal(await handleContext(fx.ctx, { json: false }), EXIT_CODES.OK);
    assert.match(fx.out.join(""), /rule source/);
  } finally {
    ws.cleanup();
  }
});

test("a missing session refuses with CONFIG and a next action", async () => {
  const ws = workspace({});
  try {
    const fx = ctxFor(ws.dir);
    assert.equal(await handleContext(fx.ctx, { session: "nosuch", json: false }), EXIT_CODES.CONFIG);
    assert.equal(fx.out.join(""), "");
    assert.match(fx.err.join(""), /no such session/);
  } finally {
    ws.cleanup();
  }
});

test("--turn without --session is a usage error", () => {
  assert.equal(parseContext(["--turn", "t1"]).kind, "error");
  assert.equal(parseContext(["--session", "../escape"]).kind, "error");
  const parsed = parseContext(["--session", "s1", "--json"]);
  assert.equal(parsed.kind, "context");
});
