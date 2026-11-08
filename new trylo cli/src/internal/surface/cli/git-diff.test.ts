import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectGitDiff,
  driverNeuterEnv,
  filterDriversArgv,
  nullDevice,
  parseDriverNames,
  revParseArgv,
  trackedDiffArgv,
  untrackedDiffArgv,
  untrackedListArgv,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git-diff.js";

/**
 * WP11.1 (C21): `/diff` command shapes and collection, Codex-ported.
 *
 * Red evidence: the module did not exist before WP11 (import fails on the
 * unfixed tree). Behavioural red was shown by pointing the scripted runner's
 * untracked diff at exit 2: `unexpected diff exits fail visibly` goes red.
 */

function scripted(responses: ReadonlyArray<GitCommandResult & { argv?: string }>): {
  runner: GitCommandRunner;
  calls: Array<{ argv: ReadonlyArray<string>; cwd: string }>;
} {
  const calls: Array<{ argv: ReadonlyArray<string>; cwd: string }> = [];
  let index = 0;

  return {
    calls,
    runner: {
      async run(argv, cwd): Promise<GitCommandResult> {
        calls.push({ argv, cwd });
        const next = responses[index];

        index += 1;

        if (next === undefined) {
          throw new Error(`no scripted response for call ${calls.length}`);
        }

        return { exit: next.exit, stdout: next.stdout, stderr: next.stderr };
      },
    },
  };
}

const OK_EMPTY: GitCommandResult = { exit: 0, stdout: "", stderr: "" };

test("argv shapes carry the Codex hardening", () => {
  const tracked = trackedDiffArgv("posix", false).join(" ");

  assert.match(tracked, /safe\.bareRepository=explicit/);
  assert.match(tracked, /core\.fsmonitor=false/);
  assert.match(tracked, /core\.hooksPath=\/dev\/null/);
  assert.match(tracked, /--no-textconv --no-ext-diff --submodule=short/);
  assert.match(tracked, /--no-color/);
  assert.match(trackedDiffArgv("posix", true).join(" "), /--color/);
  assert.match(untrackedDiffArgv("win32", false, "new.txt").join(" "), /NUL/);
  assert.equal(nullDevice("win32"), "NUL");
  assert.equal(nullDevice("posix"), "/dev/null");
  assert.ok(revParseArgv("posix").includes("--is-inside-work-tree"));
  assert.ok(filterDriversArgv("posix").join(" ").includes("--get-regexp"));
  assert.ok(untrackedListArgv("posix").includes("--others"));
});

test("driver names dedupe and neuter as env", () => {
  assert.deepEqual(parseDriverNames("filter.a.clean\0filter.a.process\0filter.b.clean\0"), ["filter.a", "filter.b"]);
  assert.deepEqual(parseDriverNames(""), []);
  const env = driverNeuterEnv(["filter.a"]);
  assert.equal(env["GIT_CONFIG_COUNT"], "3");
  assert.equal(env["GIT_CONFIG_KEY_0"], "filter.a.clean");
  assert.equal(env["GIT_CONFIG_VALUE_2"], "false");
});

test("outside a git repo succeeds with an empty diff", async () => {
  const { runner, calls } = scripted([{ exit: 128, stdout: "", stderr: "not a git repo" }]);
  const outcome = await collectGitDiff(runner, { cwd: "/work", platform: "posix" });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.value.isGitRepo, false);
    assert.equal(outcome.value.diff, "");
  }

  assert.equal(calls.length, 1);
});

test("tracked plus untracked diffs concatenate", async () => {
  const { runner, calls } = scripted([
    OK_EMPTY,
    { exit: 1, stdout: "", stderr: "" },
    { exit: 1, stdout: "--- a/f.ts\n", stderr: "" },
    { exit: 0, stdout: "new.ts\n", stderr: "" },
    { exit: 1, stdout: "--- a/new.ts\n", stderr: "" },
  ]);
  const outcome = await collectGitDiff(runner, { cwd: "/work", platform: "posix" });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.value.isGitRepo, true);
    assert.equal(outcome.value.diff, "--- a/f.ts\n--- a/new.ts\n");
  }

  assert.equal(calls.length, 5);
  assert.ok(calls[4]?.argv.includes("--no-index"));
});

test("unexpected diff exits fail visibly", async () => {
  const { runner } = scripted([OK_EMPTY, { exit: 1, stdout: "", stderr: "" }, { exit: 2, stdout: "", stderr: "boom" }]);
  const outcome = await collectGitDiff(runner, { cwd: "/work", platform: "posix" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "diff_failed");
    assert.match(outcome.detail, /status 2/);
  }
});

test("spawn failures become git_unavailable, aborts become cancelled", async () => {
  const throwing: GitCommandRunner = {
    async run(): Promise<GitCommandResult> {
      throw new Error("spawn git ENOENT");
    },
  };
  const missing = await collectGitDiff(throwing, { cwd: "/work", platform: "posix" });

  assert.equal(missing.ok, false);

  if (!missing.ok) {
    assert.equal(missing.code, "git_unavailable");
  }

  const controller = new AbortController();

  controller.abort();
  const { runner } = scripted([]);
  const cancelled = await collectGitDiff(runner, { cwd: "/work", platform: "posix", signal: controller.signal });

  assert.equal(cancelled.ok, false);

  if (!cancelled.ok) {
    assert.equal(cancelled.code, "cancelled");
  }
});
