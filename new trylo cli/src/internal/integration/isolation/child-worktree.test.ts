import assert from "node:assert/strict";
import { test } from "node:test";
import { createIsolatedChildRunner } from "./child-worktree.js";
import type { WorktreePort } from "../../ports/worktree.js";

/**
 * Subagent worktree isolation (WP25.2 / L28).
 *
 * The property under test is that a child never ends up in the parent's tree,
 * and that a lease which cannot be granted says so instead of quietly running
 * the child unconfined.
 */

type Journal = {
  readonly created: Array<{ readonly sourceCwd: string; readonly base?: string }>;
  readonly bound: Array<{ readonly root: string; readonly ownerId: string }>;
  readonly removed: Array<{ readonly root: string }>;
};

/**
 * A port that records what was asked of it. Failing operations are given per
 * test, because the point of most cases is what happens *after* the failure.
 */
function scripted(failures: Partial<Record<"create" | "bind" | "remove", string>> = {}): {
  worktrees: WorktreePort;
  journal: Journal;
} {
  const journal: Journal = { created: [], bound: [], removed: [] };
  const worktrees: WorktreePort = {
    settings: () => ({ root: "/pool", platform: "posix" }),

    async create(request) {
      journal.created.push({ sourceCwd: request.sourceCwd, ...(request.base === undefined ? {} : { base: request.base }) });
      const failure = failures.create;
      if (failure !== undefined) {
        return { ok: false, code: "git_unavailable", detail: failure };
      }

      return {
        ok: true,
        value: {
          root: "/pool/0a1b/repo",
          cwd: "/pool/0a1b/repo",
          sourceRoot: "/repo",
          sourceCwd: request.sourceCwd,
          headSha: "sha1",
          branch: undefined,
        },
      };
    },

    async list() {
      return { ok: true, value: [] };
    },

    async bindOwner(request) {
      journal.bound.push({ root: request.root, ownerId: request.ownerId });
      const failure = failures.bind;
      return failure === undefined
        ? { ok: true, value: undefined }
        : { ok: false, code: "already_owned", detail: failure };
    },

    async ownerOf() {
      return { ok: true, value: undefined };
    },

    async remove(request) {
      journal.removed.push({ root: request.root });
      const failure = failures.remove;
      return failure === undefined
        ? { ok: true, value: undefined }
        : { ok: false, code: "has_ignored_files", detail: failure };
    },
  };

  return { worktrees, journal };
}

test("a leased child runs in its own checkout, never the parent's directory", async () => {
  const { worktrees, journal } = scripted();
  const runner = createIsolatedChildRunner(worktrees);
  const outcome = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });

  assert.equal(outcome.ok, true);

  if (!outcome.ok) {
    return;
  }

  assert.equal(outcome.lease.cwd, "/pool/0a1b/repo", "the child must not be pointed back at /repo");
  assert.notEqual(outcome.lease.cwd, "/repo");
  assert.deepEqual(journal.bound, [{ root: "/pool/0a1b/repo", ownerId: "sub-1" }], "the child, not the display name, owns it");
});

test("a child with no id cannot be leased", async () => {
  const { worktrees, journal } = scripted();
  const runner = createIsolatedChildRunner(worktrees);
  const outcome = await runner.lease({ parentCwd: "/repo", childId: "" });
  assert.equal(outcome.ok, false);
  assert.deepEqual(journal.created, [], "nothing was created for an unidentifiable child");
});

test("a failed create leaves no checkout behind and no lease", async () => {
  const { worktrees, journal } = scripted({ create: "git is not installed" });
  const runner = createIsolatedChildRunner(worktrees);
  const outcome = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.code, "git_unavailable");
    assert.equal(outcome.detail.includes("git is not installed"), true);
  }

  assert.deepEqual(journal.bound, [], "no ownership was claimed for a checkout that does not exist");
});

test("a checkout that cannot be bound is removed, not left unowned in the pool", async () => {
  const { worktrees, journal } = scripted({ bind: "another session already owns it" });
  const runner = createIsolatedChildRunner(worktrees);
  const outcome = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });
  assert.equal(outcome.ok, false);
  assert.deepEqual(journal.removed, [{ root: "/pool/0a1b/repo" }], "an unowned checkout would linger in every listing");
});

test("when the rollback also fails, both facts reach the caller", async () => {
  const { worktrees } = scripted({ bind: "bind refused", remove: "ignored files present" });
  const runner = createIsolatedChildRunner(worktrees);
  const outcome = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });

  assert.equal(outcome.ok, false);

  if (!outcome.ok) {
    assert.equal(outcome.detail.includes("bind refused"), true);
    assert.equal(outcome.detail.includes("ignored files present"), true, "a swallowed cleanup failure is how directories go missing");
  }
});

test("releasing a clean checkout removes it", async () => {
  const { worktrees, journal } = scripted();
  const runner = createIsolatedChildRunner(worktrees);
  const leased = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });

  assert.equal(leased.ok, true);

  if (!leased.ok) {
    return;
  }

  const released = await runner.release(leased.lease, "/repo");

  assert.deepEqual(released, { state: "removed" });
  assert.deepEqual(journal.removed, [{ root: "/pool/0a1b/repo" }]);
});

test("a checkout holding the child's changes is kept and reported as kept", async () => {
  const { worktrees } = scripted({ remove: "worktree contains ignored local files" });
  const runner = createIsolatedChildRunner(worktrees);
  const leased = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });

  assert.equal(leased.ok, true);

  if (!leased.ok) {
    return;
  }

  // Uncommitted work is the deliverable, not a fault. The state must be
  // distinguishable from a clean removal, or the caller reports success for
  // work that is still sitting on disk.
  const released = await runner.release(leased.lease, "/repo");

  assert.deepEqual(released, { state: "kept", reason: "child_has_changes" });
});

test("a refusal to release for any other reason is reported", async () => {
  const worktrees: WorktreePort = {
    settings: () => ({ root: "/pool", platform: "posix" }),

    async create(request) {
      return {
        ok: true,
        value: {
          root: "/pool/0a1b/repo",
          cwd: "/pool/0a1b/repo",
          sourceRoot: "/repo",
          sourceCwd: request.sourceCwd,
          headSha: "sha1",
          branch: undefined,
        },
      };
    },

    async list() {
      return { ok: true, value: [] };
    },
    async bindOwner() {
      return { ok: true, value: undefined };
    },
    async ownerOf() {
      return { ok: true, value: undefined };
    },
    async remove() {
      return { ok: false, code: "current_checkout", detail: "switch to another checkout first" };
    },
  };
  const runner = createIsolatedChildRunner(worktrees);
  const leased = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });

  assert.equal(leased.ok, true);

  if (!leased.ok) {
    return;
  }

  const released = await runner.release(leased.lease, "/pool/0a1b/repo");

  assert.equal(released.state, "kept", "a genuine refusal must not be swallowed into success");

  if (released.state === "kept" && released.reason !== "child_has_changes") {
    assert.equal(released.reason, "current_checkout");
    assert.equal(typeof released.detail, "string");
  }
});

test("release passes the caller's environment and signal to git", async () => {
  // The env scrub reads the injected environment, so dropping it here would
  // make git run against the ambient GIT_DIR instead of the caller's.
  const seen: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
  let sawSignal = false;
  const worktrees: WorktreePort = {
    settings: () => ({ root: "/pool", platform: "posix" }),

    async create(request) {
      seen.push(request.baseEnv);
      return {
        ok: true,
        value: {
          root: "/pool/0a1b/repo",
          cwd: "/pool/0a1b/repo",
          sourceRoot: "/repo",
          sourceCwd: request.sourceCwd,
          headSha: "sha1",
          branch: undefined,
        },
      };
    },

    async list() {
      return { ok: true, value: [] };
    },
    async bindOwner() {
      return { ok: true, value: undefined };
    },
    async ownerOf() {
      return { ok: true, value: undefined };
    },

    async remove(request) {
      seen.push(request.baseEnv);
      sawSignal = request.signal !== undefined;
      return { ok: true, value: undefined };
    },
  };
  const runner = createIsolatedChildRunner(worktrees);
  const controller = new AbortController();
  const baseEnv = { TRYLO_HOME: "/home/x" };
  const leased = await runner.lease({ parentCwd: "/repo", childId: "sub-1", baseEnv, signal: controller.signal });

  assert.equal(leased.ok, true);

  if (!leased.ok) {
    return;
  }

  await runner.release(leased.lease, "/repo", { baseEnv, signal: controller.signal });
  assert.deepEqual(seen, [baseEnv, baseEnv], "both the create and the remove must carry it");
  assert.equal(sawSignal, true, "a cancelled release must still reach git");
});

test("a lease is refused rather than downgraded when isolation is unavailable", async () => {
  const { worktrees } = scripted({ create: "not a git repository" });
  const runner = createIsolatedChildRunner(worktrees);
  const outcome = await runner.lease({ parentCwd: "/repo", childId: "sub-1" });
  assert.equal(outcome.ok, false, "running the child in the parent tree would hand it the parent's uncommitted files");
});
