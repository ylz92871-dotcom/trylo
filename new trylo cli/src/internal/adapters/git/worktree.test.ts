import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorktreeManager } from "./worktree.js";
import type { WorktreeIo, WorktreeIoFailure } from "./worktree-io.js";
import type { GitCommandRunner, GitCommandResult } from "../../surface/cli/git-diff.js";

/**
 * The worktree port, driven through a scripted git and an in-memory disk
 * (WP25.2 / C79, L70, L28).
 *
 * The refusals are the contract: a checkout holding someone's uncommitted work
 * must survive, and a directory we did not create must be unreachable. Each of
 * those is asserted here against the real code path, not described.
 */

type ReplyResult = { readonly exit?: number; readonly stdout?: string; readonly stderr?: string } | Error;

/**
 * A reply may be a thunk over the fake disk so that a scripted command can
 * materialise what it would really have created. `worktree add` putting the
 * checkout on disk is the case that matters: without it, every later probe
 * would fail for a reason the test invented rather than one it is checking.
 */
type Reply = ReplyResult | ((files: Map<string, FakeFile>) => ReplyResult);

const POOL = "/pool";

function createRunner(
  replies: Map<string, Reply>,
  files: Map<string, FakeFile>,
): { runner: GitCommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: GitCommandRunner = {
    async run(argv, cwd): Promise<GitCommandResult> {
      const args = argv.slice(1);
      const command = subcommand(args);

      calls.push(`${command} @${cwd}`);
      // The filter probe runs before every working-tree command and answers
      // "none configured" by default, which is the common case.
      const key = args.includes("--get-regexp") ? "probe" : command;
      // Lookups differ per working directory (`--git-dir` is the admin
      // directory inside a linked checkout, the repository's own inside the
      // primary), so a reply may be pinned to one with a `@cwd` suffix.
      const reply = replies.get(`${key} @${cwd}`) ?? replies.get(key) ?? replies.get(command.split(" ")[0] ?? "");
      const resolved = typeof reply === "function" ? reply(files) : (reply ?? { exit: 0 });
      if (resolved instanceof Error) {
        throw resolved;
      }

      return { exit: resolved.exit ?? 0, stdout: resolved.stdout ?? "", stderr: resolved.stderr ?? "" };
    },
  };

  return { runner, calls };
}

type FakeFile = { readonly dir: boolean; readonly text?: string };

/**
 * Strips the isolation overrides so a test can key a reply on the git
 * subcommand alone. Everything before `rev-parse`/`worktree`/`config` is a
 * `-c value` pair, and none of them are the interesting part.
 */
function subcommand(args: ReadonlyArray<string>): string {
  const index = args.findIndex((arg) => ["rev-parse", "worktree", "config", "ls-files", "--work-tree=."].includes(arg));
  return index < 0 ? args.join(" ") : args.slice(index).join(" ");
}

function createIo(files: ReadonlyMap<string, FakeFile>): { io: WorktreeIo; files: Map<string, FakeFile> } {
  const state = new Map(files);
  const asIoFailure = (error: unknown): WorktreeIoFailure => ({ error: String(error) });
  const io: WorktreeIo = {
    async canonicalize(path) {
      if (!state.has(path)) {
        return { error: `ENOENT ${path}` };
      }
      return path;
    },
    async ensureDir(path) {
      if (!state.has(path)) {
        state.set(path, { dir: true });
      }
      return undefined;
    },
    async createDir(path) {
      if (state.has(path)) {
        return "exists";
      }
      state.set(path, { dir: true });
      return "created";
    },
    async isDirectory(path) {
      return state.get(path)?.dir === true;
    },
    async isFile(path) {
      const entry = state.get(path);
      return entry !== undefined && !entry.dir;
    },
    async readText(path) {
      const entry = state.get(path);
      if (entry === undefined) {
        return undefined;
      }
      return entry.text ?? "";
    },
    async writeNew(path, text) {
      if (state.has(path)) {
        return "exists";
      }
      state.set(path, { dir: false, text });
      return "written";
    },
    async removeEmptyDir(path) {
      if (state.get(path)?.dir === true) {
        state.delete(path);
        return { removed: true };
      }
      return { removed: false };
    },
  };

  void asIoFailure;

  return { io, files: state };
}

function seeded(): Map<string, FakeFile> {
  return new Map([
    ["/repo", { dir: true }],
    ["/pool", { dir: true }],
  ]);
}

function manager(replies: Map<string, Reply>, files = seeded(), randomHex?: () => string) {
  const { io, files: state } = createIo(files);
  const { runner, calls } = createRunner(replies, state);

  return {
    port: createWorktreeManager({
      settings: { root: POOL, platform: "posix" },
      runner,
      io,
      ...(randomHex === undefined ? {} : { randomHex }),
    }),
    calls,
    files: state,
  };
}

/**
 * The scripted happy path. `worktree add` puts the checkout and its `.git`
 * link on the fake disk, and `worktree remove` takes them away — because those
 * two are the only places where git and the disk are supposed to agree, and
 * every later refusal depends on that agreement.
 *
 * `materialise` controls whether the new checkout also receives the
 * repository's subdirectories, which is what `reset --hard` does. A case that
 * needs the caller's directory to be *absent* turns it off.
 */
function withDiskEffect(replies: Map<string, Reply>, materialise = true): Map<string, Reply> {
  // Rewrite after the walk: mutating a Map while iterating it makes the
  // replacement value the next thing visited, which silently skips entries.
  const rewritten: Array<readonly [string, Reply]> = [];

  for (const [key, value] of replies) {
    if (value instanceof Error || typeof value === "function") {
      continue;
    }

    const add = key.match(/^worktree add --detach --no-checkout (\S+) \S+$/);
    if (add !== null && (value.exit ?? 0) === 0) {
      const root = add[1] ?? "";

      rewritten.push([
        key,
        (files: Map<string, FakeFile>) => {
          const bucket = root.slice(0, root.lastIndexOf("/"));

          files.set(bucket, { dir: true });
          files.set(root, { dir: true });
          files.set(`${root}/.git`, { dir: false, text: `gitdir: /repo/.git/worktrees/repo\n` });

          // `reset --hard` materialises the tracked tree, so the
          // subdirectories the repository had exist in the new checkout too.
          // Without this, every later "is the caller's directory present"
          // probe would fail for a reason the fake invented.
          for (const entry of [...files.keys()]) {
            if (materialise && entry.startsWith("/repo/")) {
              files.set(`${root}${entry.slice("/repo".length)}`, { dir: true });
            }
          }

          return value;
        },
      ]);
      continue;
    }

    const remove = key.match(/^worktree remove (?:--force )?(\S+)$/);
    if (remove !== null && (value.exit ?? 0) === 0) {
      const root = remove[1] ?? "";
      rewritten.push([
        key,
        (files: Map<string, FakeFile>) => {
          files.delete(root);
          files.delete(`${root}/.git`);
          return value;
        },
      ]);
    }
  }

  for (const [key, reply] of rewritten) {
    replies.set(key, reply);
  }

  return replies;
}

const baseReplies = (headSha: string, sha = headSha): Map<string, Reply> =>
  withDiskEffect(
    new Map([
      ["rev-parse --show-toplevel", { stdout: "/repo\n" }],
      ["rev-parse --verify --end-of-options HEAD^{commit}", { stdout: `${sha}\n` }],
      ["rev-parse --path-format=absolute --git-path config.worktree", { stdout: "/repo/.git/config.worktree\n" }],
      ["config --file /repo/.git/config.worktree core.worktree /pool/0a1b/repo", { exit: 0 }],
      ["--work-tree=. reset --hard --no-recurse-submodules " + sha, { exit: 0 }],
      ["worktree add --detach --no-checkout /pool/0a1b/repo " + sha, { exit: 0 }],
    ]),
  );

/** The administration git writes for a checkout it just created. */
function seedAdmin(files: Map<string, FakeFile>, name: string, root: string): void {
  files.set(`/repo/.git/worktrees/${name}`, { dir: true });
  files.set(`/repo/.git/worktrees/${name}/gitdir`, { dir: false, text: `${root}/.git\n` });
}

function withCreatedCheckout(): Map<string, FakeFile> {
  const files: Map<string, FakeFile> = new Map([
    ...seeded(),
    ["/pool/0a1b", { dir: true }],
    ["/pool/0a1b/repo", { dir: true }],
    ["/pool/0a1b/repo/.git", { dir: false, text: "gitdir: /repo/.git/worktrees/repo\n" }],
    ["/pool/0a1b/repo/src", { dir: true }],
    ["/repo/.git", { dir: true }],
  ]);

  seedAdmin(files, "repo", "/pool/0a1b/repo");

  return files;
}

const listingReplies = new Map<string, Reply>([
  [
    "worktree list --porcelain -z",
    { stdout: "worktree /repo\0HEAD aaa\0branch refs/heads/main\0\0worktree /pool/0a1b/repo\0HEAD bbb\0detached\0\0" },
  ],
  ["rev-parse --show-toplevel", { stdout: "/repo\n" }],
  // Inside a linked checkout, git reports the *checkout's* root. Without this
  // the "you are standing in it" case would never reach the refusal it tests.
  ["rev-parse --show-toplevel @/pool/0a1b/repo", { stdout: "/pool/0a1b/repo\n" }],
  ["rev-parse --show-toplevel @/pool/0a1b/repo/src", { stdout: "/pool/0a1b/repo\n" }],
  ["rev-parse --git-common-dir", { stdout: "/repo/.git\n" }],
  ["rev-parse --git-dir @/pool/0a1b/repo", { stdout: "/repo/.git/worktrees/repo\n" }],
  ["rev-parse --git-dir", { stdout: "/repo/.git\n" }],
]);

test("create returns a checkout whose cwd keeps the caller's subdirectory", async () => {
  const files = seeded();
  const { port, calls } = manager(baseReplies("sha1"), files, () => "0a1b");
  const outcome = await port.create({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  assert.equal(outcome.value.root, "/pool/0a1b/repo");
  assert.equal(outcome.value.cwd, "/pool/0a1b/repo", "no subdirectory means the checkout root");
  assert.equal(outcome.value.headSha, "sha1");
  assert.equal(outcome.value.branch, undefined, "we create a detached HEAD");
  assert.equal(outcome.value.sourceRoot, "/repo");
  assert.equal(
    calls.some((call) => call.includes("core.hooksPath") === false && call.includes("--show-toplevel")),
    true,
  );
});

test("create preserves a nested working directory", async () => {
  const files = new Map([...seeded(), ["/repo/src", { dir: true }]]);
  const { port } = manager(baseReplies("sha1"), files, () => "0a1b");
  const outcome = await port.create({ sourceCwd: "/repo/src" });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.value.cwd, "/pool/0a1b/repo/src");
  }
});

test("a relative pool root is refused before anything runs", async () => {
  const { runner, calls } = createRunner(new Map(), seeded());
  const port = createWorktreeManager({
    settings: { root: "relative/pool", platform: "posix" },
    runner,
    io: createIo(seeded()).io,
  });
  const outcome = await port.create({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "relative_root");
  }

  assert.deepEqual(calls, [], "no git ran against a root we cannot resolve");
});

test("a directory outside a repository is reported as such, not as a git failure", async () => {
  const files = new Map([...seeded(), ["/tmp", { dir: true }]]);
  const { port } = manager(new Map([["rev-parse --show-toplevel", { exit: 128, stderr: "not a git repository" }]]), files);
  const outcome = await port.create({ sourceCwd: "/tmp" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "not_a_repository", "the reason a person needs is 'not a repo', not 'git said no'");
  }
});

test("a path that does not exist is a distinct answer from 'not a repository'", async () => {
  const { port } = manager(new Map([["rev-parse --show-toplevel", { exit: 128, stderr: "not a git repository" }]]));
  const outcome = await port.create({ sourceCwd: "/nowhere" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "unresolved_path");
  }
});

test("git missing is 'git_unavailable', which a caller must not read as git's verdict", async () => {
  const { port } = manager(new Map([["rev-parse --show-toplevel", new Error("spawn git ENOENT")]]));
  const outcome = await port.list({ sourceCwd: "/repo" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "git_unavailable");
  }
});

test("a cancellation is a distinct terminal state", async () => {
  const controller = new AbortController();

  controller.abort();
  const { port } = manager(new Map([["rev-parse --show-toplevel", new Error("aborted")]]));
  const outcome = await port.list({ sourceCwd: "/repo", signal: controller.signal });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "cancelled");
  }
});

test("a taken bucket is retried with a fresh name", async () => {
  // Both candidate roots are scripted up front so `withDiskEffect` rewrites
  // them; adding a reply afterwards would skip the disk effect entirely.
  const replies = withDiskEffect(
    new Map([
      ["rev-parse --show-toplevel", { stdout: "/repo\n" }],
      ["rev-parse --verify --end-of-options HEAD^{commit}", { stdout: "sha1\n" }],
      ["rev-parse --path-format=absolute --git-path config.worktree", { stdout: "/repo/.git/config.worktree\n" }],
      ["config --file /repo/.git/config.worktree core.worktree /pool/0a1b/repo", { exit: 0 }],
      ["config --file /repo/.git/config.worktree core.worktree /pool/ffff/repo", { exit: 0 }],
      ["--work-tree=. reset --hard --no-recurse-submodules sha1", { exit: 0 }],
      ["worktree add --detach --no-checkout /pool/0a1b/repo sha1", { exit: 0 }],
      ["worktree add --detach --no-checkout /pool/ffff/repo sha1", { exit: 0 }],
    ]),
  );
  // `/pool/0a1b` already exists, so the first draw collides for real.
  const files = new Map([...seeded(), ["/pool/0a1b", { dir: true }]]);
  const names = ["0a1b", "0a1b", "ffff"];
  const { port } = manager(replies, files, () => names.shift() ?? "ffff");
  const outcome = await port.create({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, true, "an occupied bucket is skipped, not adopted");

  if (outcome.ok) {
    assert.equal(outcome.value.root, "/pool/ffff/repo");
  }
});

test("a draw that is not hex is skipped rather than becoming a bucket name", async () => {
  const names = ["zz", "0a1b"];
  const { port } = manager(baseReplies("sha1"), seeded(), () => names.shift() ?? "0a1b");
  const outcome = await port.create({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.equal(outcome.value.root, "/pool/0a1b/repo");
  }
});

test("a failed checkout leaves no bucket behind", async () => {
  const replies = baseReplies("sha1");

  replies.set("worktree add --detach --no-checkout /pool/0a1b/repo sha1", { exit: 128, stderr: "fatal: bad revision" });
  const { port, files } = manager(replies, seeded(), () => "0a1b");
  const outcome = await port.create({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "git_failed");
    assert.equal(outcome.detail.includes("bad revision"), true, "git's own words reach the caller");
  }

  assert.equal(files.has("/pool/0a1b"), false, "an empty bucket is reclaimed");
});

test("a failure while populating rolls the checkout back with force", async () => {
  const replies = baseReplies("sha1");

  replies.set("--work-tree=. reset --hard --no-recurse-submodules sha1", { exit: 1, stderr: "out of disk" });
  replies.set("worktree remove --force /pool/0a1b/repo", { exit: 0 });
  const { port, calls } = manager(replies, seeded(), () => "0a1b");
  const outcome = await port.create({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "git_failed");
  }

  assert.equal(
    calls.some((call) => call.startsWith("worktree remove --force")),
    true,
    "our own half-built checkout is undone",
  );
});

test("create rolls back when the requested base lacks the caller's directory", async () => {
  // The repository has `src`, but the scripted checkout does not: this is the
  // case Codex `lib.rs:148-155` rolls back on.
  const files = new Map([...seeded(), ["/repo/src", { dir: true }]]);
  const replies = withDiskEffect(
    new Map([
      ["rev-parse --show-toplevel", { stdout: "/repo\n" }],
      ["rev-parse --verify --end-of-options HEAD^{commit}", { stdout: "sha1\n" }],
      ["rev-parse --path-format=absolute --git-path config.worktree", { stdout: "/repo/.git/config.worktree\n" }],
      ["config --file /repo/.git/config.worktree core.worktree /pool/0a1b/repo", { exit: 0 }],
      ["--work-tree=. reset --hard --no-recurse-submodules sha1", { exit: 0 }],
      ["worktree add --detach --no-checkout /pool/0a1b/repo sha1", { exit: 0 }],
      ["worktree remove --force /pool/0a1b/repo", { exit: 0 }],
    ]),
    false,
  );
  const { port, calls } = manager(replies, files, () => "0a1b");
  const outcome = await port.create({ sourceCwd: "/repo/src" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "outside_repository");
  }

  assert.equal(calls.some((call) => call.startsWith("worktree remove --force")), true);
});

test("list returns our checkouts and nothing else", async () => {
  const { port } = manager(listingReplies, withCreatedCheckout());
  const outcome = await port.list({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  assert.equal(outcome.value.length, 1, "the primary checkout is not ours to manage");
  assert.equal(outcome.value[0]?.root, "/pool/0a1b/repo");
  assert.equal(outcome.value[0]?.headSha, "bbb");
});

test("a hand-made worktree is invisible to list, so remove cannot reach it", async () => {
  const files = withCreatedCheckout();

  files.set("/elsewhere/manual", { dir: true });
  files.set("/elsewhere/manual/.git", { dir: false, text: "gitdir: /repo/.git/worktrees/manual\n" });
  files.set("/repo/.git/worktrees/manual", { dir: true });
  files.set("/repo/.git/worktrees/manual/gitdir", { dir: false, text: "/elsewhere/manual/.git\n" });
  const replies = new Map(listingReplies);

  replies.set(
    "worktree list --porcelain -z",
    { stdout: "worktree /elsewhere/manual\0HEAD ccc\0detached\0\0worktree /pool/0a1b/repo\0HEAD bbb\0detached\0\0" },
  );
  const { port } = manager(replies, files);
  const outcome = await port.list({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.deepEqual(
      outcome.value.map((item) => item.root),
      ["/pool/0a1b/repo"],
    );
  }
});

test("the backlink probe runs with the caller's environment", async () => {
  // `--git-dir` resolves the administration directory, and it is only correct
  // when it runs against the caller's repository. Asserted per command rather
  // than over the whole run: two other `--git-common-dir` probes in the same
  // path already carry the environment, so an aggregate check would stay green
  // even with this one call dropped.
  const { runner } = createRunner(listingReplies, withCreatedCheckout());
  const { io } = createIo(withCreatedCheckout());
  const marker = "TRYLO_WORKTREE_PROBE_MARKER";
  const perCommand = new Map<string, ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>>();
  const watched: GitCommandRunner = {
    run: (argv, cwd, options) => {
      const args = argv.slice(1);
      const command = subcommand(args);
      perCommand.set(command, [...(perCommand.get(command) ?? []), options?.env]);
      return runner.run(argv, cwd, options);
    },
  };
  const port = createWorktreeManager({ settings: { root: POOL, platform: "posix" }, runner: watched, io });
  const outcome = await port.list({ sourceCwd: "/repo", baseEnv: { [marker]: "carried" } });

  assert.equal(outcome.ok, true);
  const gitDirEnvs = perCommand.get("rev-parse --git-dir") ?? [];

  assert.equal(gitDirEnvs.length > 0, true, "the backlink probe did not run");
  assert.equal(
    gitDirEnvs.every((env) => env?.[marker] === "carried"),
    true,
    "the backlink probe ran without the caller's environment, so it resolved whatever repository was ambient",
  );
});

test("a stale registration whose directory was recycled is not adopted", async () => {
  const files = withCreatedCheckout();

  // The administration directory now points at a different checkout.
  files.set("/repo/.git/worktrees/repo/gitdir", { dir: false, text: "/pool/ffff/repo/.git\n" });
  const { port } = manager(listingReplies, files);
  const outcome = await port.list({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, true);

  if (outcome.ok) {
    assert.deepEqual(outcome.value, [], "a backlink to elsewhere means this registration is stale");
  }
});

test("a managed checkout with no HEAD fails the listing rather than vanishing from it", async () => {
  const replies = new Map(listingReplies);

  replies.set("worktree list --porcelain -z", { stdout: "worktree /pool/0a1b/repo\0detached\0\0" });
  const { port } = manager(replies, withCreatedCheckout());
  const outcome = await port.list({ sourceCwd: "/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.detail.includes("no HEAD"), true);
  }
});

test("remove refuses a path that is not ours", async () => {
  const { port } = manager(listingReplies, withCreatedCheckout());
  const outcome = await port.remove({ sourceCwd: "/repo", root: "/pool/ffff/repo" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "not_managed");
  }
});

test("remove refuses the checkout you are standing in", async () => {
  const { port, calls } = manager(listingReplies, withCreatedCheckout());
  const outcome = await port.remove({ sourceCwd: "/pool/0a1b/repo/src", root: "/pool/0a1b/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "current_checkout");
  }

  assert.equal(calls.some((call) => call.includes("worktree remove")), false, "nothing was deleted");
});

test("remove refuses a checkout holding ignored local files", async () => {
  const replies = new Map(listingReplies);

  replies.set("ls-files --others --ignored --exclude-standard -z", { stdout: "node_modules/x\0" });
  const { port, calls } = manager(replies, withCreatedCheckout());
  const outcome = await port.remove({ sourceCwd: "/repo", root: "/pool/0a1b/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "has_ignored_files");
  }

  assert.equal(calls.some((call) => call.startsWith("worktree remove")), false);
});

test("remove never passes --force, so git refuses tracked changes for us", async () => {
  const replies = withDiskEffect(
    new Map([...listingReplies, ["ls-files --others --ignored --exclude-standard -z", { stdout: "" }]]),
  );

  replies.set("worktree remove /pool/0a1b/repo", { exit: 0 });
  const { port, calls, files } = manager(withDiskEffect(replies), withCreatedCheckout());
  const outcome = await port.remove({ sourceCwd: "/repo", root: "/pool/0a1b/repo" });

  assert.equal(outcome.ok, true);
  assert.equal(calls.some((call) => call.includes("--force")), false, "git, not us, is what refuses dirty work");
  assert.equal(files.has("/pool/0a1b/repo"), false, "the checkout is gone");
  assert.equal(files.has("/pool/0a1b"), false, "an emptied bucket is reclaimed");
});

test("a git refusal during remove surfaces as a failure, not as a completed deletion", async () => {
  const replies = new Map(listingReplies);

  replies.set("ls-files --others --ignored --exclude-standard -z", { stdout: "" });
  replies.set("worktree remove /pool/0a1b/repo", { exit: 128, stderr: "fatal: contains modified or untracked files" });
  const { port } = manager(replies, withCreatedCheckout());
  const outcome = await port.remove({ sourceCwd: "/repo", root: "/pool/0a1b/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.detail.includes("modified or untracked"), true, "the user's work is what stopped us");
  }
});

/** No ownership record on disk at all: the unbound case. */
const ownerFiles = (): Map<string, FakeFile> => withCreatedCheckout();

const ownerReplies = new Map<string, Reply>([
  ["rev-parse --show-toplevel", { stdout: "/repo\n" }],
  ["rev-parse --git-path trylo-worktree.json", { stdout: "/repo/.git/worktrees/repo/trylo-worktree.json\n" }],
  ["rev-parse --git-common-dir", { stdout: "/repo/.git\n" }],
]);

test("an unbound checkout answers 'no owner' rather than failing", async () => {
  const { port } = manager(ownerReplies, ownerFiles());
  const outcome = await port.ownerOf({ root: "/pool/0a1b/repo" });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.value, undefined);
  }
});

test("binding is exclusive and idempotent for the same owner", async () => {
  const { port, files } = manager(ownerReplies, ownerFiles());
  const first = await port.bindOwner({ root: "/pool/0a1b/repo", ownerId: "task-1" });

  assert.equal(first.ok, true);
  const again = await port.bindOwner({ root: "/pool/0a1b/repo", ownerId: "task-1" });

  assert.equal(again.ok, true, "re-binding our own checkout is not a conflict");
  const other = await port.bindOwner({ root: "/pool/0a1b/repo", ownerId: "task-2" });

  assert.equal(other.ok, false);

  if (!other.ok) {
    assert.equal(other.code, "already_owned");
  }

  const owner = await port.ownerOf({ root: "/pool/0a1b/repo" });

  assert.equal(owner.ok && owner.value, "task-1", "the first owner kept it");
  assert.equal(files.has("/repo/.git/worktrees/repo/trylo-worktree.json"), true);
});

test("a race for the same checkout loses to whoever wrote first", async () => {
  const files = ownerFiles();

  files.set("/repo/.git/worktrees/repo/trylo-worktree.json", {
    dir: false,
    text: '{"version":1,"ownerId":"task-9"}\n',
  });
  const { port } = manager(ownerReplies, files);
  const outcome = await port.bindOwner({ root: "/pool/0a1b/repo", ownerId: "task-1" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "already_owned");
  }
});

test("a corrupted ownership record is reported, not read as unowned", async () => {
  const files = ownerFiles();

  files.set("/repo/.git/worktrees/repo/trylo-worktree.json", { dir: false, text: "{ not json" });
  const { port } = manager(ownerReplies, files);
  const outcome = await port.ownerOf({ root: "/pool/0a1b/repo" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "owner_invalid");
  }
});

test("a checkout outside the pool has no owner record to report", async () => {
  const files = ownerFiles();

  files.set("/elsewhere/manual", { dir: true });
  const { port } = manager(ownerReplies, files);
  const outcome = await port.ownerOf({ root: "/elsewhere/manual" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "not_managed", "a hand-made worktree has no owner concept here");
  }
});

test("an empty owner id is refused before anything is written", async () => {
  const { port, calls } = manager(ownerReplies, ownerFiles());
  const outcome = await port.bindOwner({ root: "/pool/0a1b/repo", ownerId: "" });
  assert.equal(outcome.ok, false);
  assert.equal(calls.some((call) => call.includes("--git-path")), false);
});
