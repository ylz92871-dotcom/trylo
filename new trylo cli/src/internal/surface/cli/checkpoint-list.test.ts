import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { handleCheckpointList } from "./commands-checkpoint.js";
import type { CliContext } from "./context.js";

/**
 * C2: an empty checkpoint store is an answer, not a failure.
 *
 * Before this, `trylo checkpoint list` on a machine that had never snapshotted
 * anything printed a raw `ENOENT` and left with 75 — the code that means
 * "temporary, try again" — while `trylo session list`, asked the same kind of
 * question, said "no sessions". The difference was never a decision.
 *
 * The second case here is the one that keeps the fix honest: a root that exists
 * but cannot be read must stay a failure. A blanket "any list error is empty"
 * would have made the first case pass and quietly swallowed real storage faults.
 */

type Recorded = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly home: string;
  readonly root: string;
};

function scripted(): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-ckpt-list-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, err, home, root };
}

test("C2: listing a store that was never created says so and leaves with 0", async () => {
  const run = scripted();
  try {
    const code = await handleCheckpointList(run.ctx, { json: false });

    assert.equal(code, EXIT_CODES.OK);
    const said = run.out.join("");

    assert.match(said, /^no checkpoints/, said);
    // Emptiness alone is a dead end: it should also say where they come from,
    // because this command is how a person learns snapshots exist.
    assert.match(said, /automatically/, said);
    assert.equal(run.err.join(""), "", "an empty store must not print a diagnostic");
    assert.equal(run.err.join("").includes("ENOENT"), false);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("C2: the JSON shape of an empty store is an empty list", async () => {
  const run = scripted();
  try {
    const code = await handleCheckpointList(run.ctx, { json: true });
    assert.equal(code, EXIT_CODES.OK);
    assert.deepEqual(JSON.parse(run.out.join("")), []);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("C2: a store that exists but cannot be read is still a failure", async () => {
  const run = scripted();
  const store = join(run.home, ".trylo", "checkpoints");

  try {
    // A file where the directory should be: `existsSync` is true, so the
    // softening does not apply and the real storage fault must surface.
    writeFileSync(store, "not a directory\n");
    const code = await handleCheckpointList(run.ctx, { json: false });

    // 75, not 52: `storage_unavailable` is a transient code and was classified
    // that way before this package. What matters here is that it is a failure
    // at all — the softening must not have turned a real fault into "none".
    assert.equal(code, EXIT_CODES.TEMPORARY);
    assert.notEqual(code, EXIT_CODES.OK);
    assert.equal(run.out.join(""), "");
    assert.equal(run.err.join("").includes("checkpoint storage could not be read"), true);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});
