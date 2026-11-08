import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WRITE_FIXTURE_CONTENT, WRITE_FIXTURE_PATH } from "../../internal/adapters/provider/fixture.js";

/**
 * Child-process demos for the mutating path.
 *
 * These are the three commands the work package asks to be demonstrable, run
 * against the real binary: a write that lands, a non-interactive write that is
 * refused, and an escape that is refused even when the write was allowed.
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type Fixture = {
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-mutating-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "@trylo/fixture-workspace" }, null, 2));

  return {
    root,
    workspace,
    home,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(fx: Fixture, args: readonly string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: fx.home };

  // Ambient credentials must never change a test outcome.
  delete env.TRYLO_API_KEY;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("an allowed write lands on disk and the answer quotes what is really there", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture-write", "--allow-writes", "write a file"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(join(fx.workspace, WRITE_FIXTURE_PATH)), true);
    assert.equal(readFileSync(join(fx.workspace, WRITE_FIXTURE_PATH), "utf8"), WRITE_FIXTURE_CONTENT);
    assert.match(result.stdout, new RegExp(WRITE_FIXTURE_CONTENT));
  } finally {
    fx.cleanup();
  }
});

test("a non-interactive write with no opt-in is refused and leaves no file", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture-write", "write a file"]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(fx.workspace, WRITE_FIXTURE_PATH)), false);
  } finally {
    fx.cleanup();
  }
});

/**
 * The strongest version of the escape demo: the write is *allowed*, and the
 * sandbox is still the thing that stops it.
 */
test("a link out of the workspace is refused even when writes are allowed", (t) => {
  const fx = fixture();
  try {
    const outside = join(fx.root, "outside.txt");

    writeFileSync(outside, "original");
    let linked = true;

    try {
      symlinkSync(outside, join(fx.workspace, WRITE_FIXTURE_PATH), "file");
    } catch {
      linked = false;
    }

    if (linked === false) {
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const result = run(fx, ["run", "--provider", "fixture-write", "--allow-writes", "write a file"]);

    assert.equal(readFileSync(outside, "utf8"), "original");
    assert.match(result.stdout, /did not land/);
  } finally {
    fx.cleanup();
  }
});

test("--allow-writes takes no value, so it cannot be turned into a default", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture-write", "--allow-writes=false", "write"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--allow-writes takes no value/);
  } finally {
    fx.cleanup();
  }
});
