import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./main.js";
import type { CliContext } from "../../internal/surface/cli/context.js";
import { isolationCleanupError } from "../../internal/adapters/sandbox/windows/windows-isolation-error.js";

function context(failure: Error, errors: string[]): CliContext {
  return {
    env: {}, homeDir: "/home", cwd: "/workspace", nodeVersion: "v24", stdinIsTty: false,
    stdout: () => { throw failure; }, stderr: text => { errors.push(text); },
    readFile: () => undefined, isDirectory: () => false, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    now: () => 0, newId: prefix => prefix,
  };
}

test("the command entry reports a cleanup failure with a failure exit instead of an uncaught stack", async () => {
  const error = isolationCleanupError("partial grant", new Error("open init-lock: access denied"), new Error("revocation missing"));
  const errors: string[] = [];
  assert.equal(await main(["help"], context(error, errors)), 1);
  assert.match(errors.join(""), /access denied/);
  assert.match(errors.join(""), /revocation missing/);
  assert.match(errors.join(""), /doctor/);
});

test("unclassified command exceptions remain exceptions rather than being reported as isolation failures", async () => {
  const error = new Error("unrelated invariant violation");
  await assert.rejects(main(["help"], context(error, [])), failure => failure === error);
});
