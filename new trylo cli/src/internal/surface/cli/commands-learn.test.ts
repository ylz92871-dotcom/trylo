import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatch } from "./commands.js";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";

test("standalone learning runs without a provider and honors TRYLO_HOME; corruption is a failed invocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-collaboration-cli-"));
  const home = join(root, "isolated-home");
  const out: string[] = [];
  const unexpected = (): never => { throw new Error("standalone learning tried to construct task IO"); };
  const ctx: CliContext = {
    env: { TRYLO_HOME: home }, homeDir: join(root, "unused-home"), cwd: root,
    nodeVersion: "v24.0.0", stdinIsTty: false, readFile: unexpected, readDir: unexpected,
    writeFile: unexpected, isDirectory: unexpected, readStdin: unexpected, readLine: unexpected,
    readSecret: unexpected, stdout: text => out.push(text), stderr: unexpected,
    now: () => 1793635200000, newId: unexpected,
  };

  try {
    assert.equal(await dispatch(parseArgs(["learn", "collaboration", "--budget", "0"]), ctx), 0);
    assert.equal(JSON.parse(out.at(-1)!).ok, true);
    assert.equal(existsSync(home), false, "zero budget must not construct a store");
    assert.equal(await dispatch(parseArgs(["learn", "collaboration", "--tokens", "0"]), ctx), 0);
    assert.equal(JSON.parse(out.at(-1)!).phase, "idle");
    assert.equal(existsSync(home), false, "zero persistent grant must not resolve a model or construct a store");
    const boardRoot = join(home, "learning", "board");

    mkdirSync(boardRoot, { recursive: true });
    writeFileSync(join(boardRoot, "board-events.ndjson"), "invalid committed log\n");
    assert.equal(await dispatch(parseArgs(["learn", "collaboration", "--budget", "8"]), ctx), 1);
    assert.equal(JSON.parse(out.at(-1)!).ok, false);
    assert.equal(existsSync(join(root, "unused-home")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
