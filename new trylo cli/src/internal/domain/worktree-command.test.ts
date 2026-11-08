import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterNeuterEnv,
  filterProbeArgv,
  ignoredFilesArgv,
  parseFilterDriverNames,
  parseWorktreeList,
  populateWorktreeArgv,
  resolveCommitArgv,
  revParseArgv,
  scrubGitEnv,
  setCoreWorktreeArgv,
  worktreeAddArgv,
  worktreeConfigPathArgv,
  worktreeGitArgv,
  worktreeListArgv,
  worktreeRemoveArgv,
  WORKTREE_GIT_ENV_SET,
  WORKTREE_GIT_ENV_UNSET,
} from "./worktree-command.js";

/**
 * Command surface, from Codex `codex-rs/worktree/src/git.rs` and the command
 * sequence in `lib.rs:76-139`.
 */

test("every git command carries the isolation overrides", () => {
  const argv = worktreeGitArgv("posix", ["rev-parse", "HEAD"]);

  assert.deepEqual(argv, [
    "git",
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=",
    "-c",
    "attr.tree=",
    "-c",
    "core.attributesFile=",
    "rev-parse",
    "HEAD",
  ]);
  assert.equal(worktreeGitArgv("win32", ["status"]).includes("core.hooksPath=NUL"), true, "NUL on windows");
  assert.equal(worktreeGitArgv("win32", ["status"]).includes("core.hooksPath=/dev/null"), false);
});

test("inherited repository selectors are dropped and ours are pinned", () => {
  const inherited = { PATH: "/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere", HOME: "/root" };
  const scrubbed = scrubGitEnv(inherited);

  assert.equal(scrubbed.PATH, "/bin", "unrelated variables survive");
  assert.equal(scrubbed.HOME, "/root");
  assert.equal("GIT_DIR" in scrubbed, false, "a wrong repository selector is the defect this prevents");
  assert.equal("GIT_WORK_TREE" in scrubbed, false);
  assert.deepEqual({ ...WORKTREE_GIT_ENV_SET }, { GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" });
  assert.equal(scrubbed.GIT_LFS_SKIP_SMUDGE, "1");
  assert.equal(scrubbed.GIT_TERMINAL_PROMPT, "0");
  assert.equal(inherited.GIT_DIR, "/elsewhere/.git", "the caller's environment is not mutated");
});

test("every selector Codex lists is on the list", () => {
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
  ]) {
    assert.equal(WORKTREE_GIT_ENV_UNSET.includes(name), true, `${name} must be scrubbed`);
    assert.equal("GIT_DIR" in scrubGitEnv({ [name]: "x" }), false, `${name} must not survive`);
  }
});

test("scrubbing survives a missing environment", () => {
  assert.deepEqual(scrubGitEnv(undefined), { ...WORKTREE_GIT_ENV_SET });
});

test("the create sequence peels tags and checks out detached and empty", () => {
  assert.deepEqual(resolveCommitArgv("posix", "HEAD").slice(-4), [
    "rev-parse",
    "--verify",
    "--end-of-options",
    "HEAD^{commit}",
  ]);
  assert.deepEqual(resolveCommitArgv("posix", "v1.2.3").slice(-1), ["v1.2.3^{commit}"], "tags peel to commits");
  assert.deepEqual(worktreeAddArgv("posix", "/pool/0a1b/repo", "abc").slice(-6), [
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    "/pool/0a1b/repo",
    "abc",
  ]);
  assert.equal(worktreeAddArgv("posix", "/p", "abc").includes("--no-checkout"), true, "empty until we pin it");
});

test("checkout writes the destination config, never the shared one", () => {
  const path = worktreeConfigPathArgv("posix");

  assert.equal(path.includes("--path-format=absolute"), true, "an absolute path must not be joined onto a cwd");
  assert.deepEqual(setCoreWorktreeArgv("posix", "/git/config.worktree", "/pool/0a1b/repo").slice(-4), [
    "--file",
    "/git/config.worktree",
    "core.worktree",
    "/pool/0a1b/repo",
  ]);
  assert.deepEqual(populateWorktreeArgv("posix", "abc").slice(-4), ["reset", "--hard", "--no-recurse-submodules", "abc"]);
});

test("removal is unforced unless we are undoing our own work", () => {
  assert.equal(worktreeRemoveArgv("posix", "/pool/0a1b/repo", false).includes("--force"), false);
  assert.equal(worktreeRemoveArgv("posix", "/pool/0a1b/repo", true).includes("--force"), true);
});

test("rev-parse passes its arguments through", () => {
  assert.deepEqual(revParseArgv("posix", ["--show-toplevel"]).slice(-2), ["rev-parse", "--show-toplevel"]);
  assert.deepEqual(revParseArgv("posix", ["--git-common-dir"]).slice(-2), ["rev-parse", "--git-common-dir"]);
  assert.deepEqual(worktreeListArgv("posix").slice(-4), ["worktree", "list", "--porcelain", "-z"]);
  assert.deepEqual(ignoredFilesArgv("posix").slice(-5), [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  assert.equal(filterProbeArgv("posix").includes("^filter\\."), true);
});

test("filter drivers include smudge, which the read-only diff hardener omits", () => {
  const drivers = parseFilterDriverNames("filter.lfs.clean\0filter.lfs.smudge\0filter.my.drv.process\0filter.lfs.required\0");

  assert.deepEqual(drivers, ["lfs", "my.drv"], "dots inside a driver name are kept; only the attribute is peeled");
  assert.deepEqual(parseFilterDriverNames(""), []);
  assert.deepEqual(parseFilterDriverNames("core.pager\0"), [], "a non-filter key is not a driver");

  const env = filterNeuterEnv(["lfs"]);

  assert.equal(env.GIT_CONFIG_COUNT, "4", "clean, smudge, process, required");
  assert.equal(env.GIT_CONFIG_KEY_0, "filter.lfs.clean");
  assert.equal(env.GIT_CONFIG_KEY_1, "filter.lfs.smudge");
  assert.equal(env.GIT_CONFIG_VALUE_0, "", "empty value unsets the helper");
  assert.equal(env.GIT_CONFIG_KEY_3, "filter.lfs.required");
  assert.equal(env.GIT_CONFIG_VALUE_3, "false", "a missing required helper must not be fatal");
  assert.equal(filterNeuterEnv([]).GIT_CONFIG_COUNT, "0");
  assert.equal(filterNeuterEnv(["a", "b"]).GIT_CONFIG_COUNT, "8");
});

test("the porcelain listing separates entries on empty fields, not newlines", () => {
  const output = [
    "worktree /repo",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree /pool/0a1b/repo",
    "HEAD bbb",
    "detached",
    "",
    "",
  ].join("\0");
  const entries = parseWorktreeList(output);

  assert.equal(entries.length, 2, "a path containing a newline cannot end an entry");
  assert.deepEqual(entries[0], { root: "/repo", headSha: "aaa", branch: "main" });
  assert.deepEqual(entries[1], { root: "/pool/0a1b/repo", headSha: "bbb", branch: undefined });
});

test("a checkout with no HEAD is reported rather than dropped", () => {
  const entries = parseWorktreeList("worktree /pool/0a1b/repo\0\0");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.headSha, undefined, "the caller decides this is a failure");
});

test("a trailing entry without a blank field is still parsed", () => {
  const entries = parseWorktreeList("worktree /repo\0HEAD aaa");
  assert.deepEqual(entries, [{ root: "/repo", headSha: "aaa", branch: undefined }]);
});
