import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import { createIdleDispatch } from "./queued-dispatch.js";
import type { CliContext } from "./context.js";
import { sessionQueuePath } from "./session-paths.js";

/**
 * Idle dispatch: the step that makes `trylo queue` a queue rather than a file.
 *
 * The contract is narrow and load-bearing: **one call takes at most one message,
 * and takes the oldest.** Everything else here is the ways that can go wrong —
 * taking two, taking the newest, taking one twice, or reporting an unreadable
 * queue as an idle session.
 *
 * "At most one" is the property the whole design rests on. A turn is not free
 * and a session cannot answer two prompts at once, so a dispatch that returned a
 * batch would turn one queued message into two turns nobody asked for.
 */

type Lab = {
  readonly ctx: CliContext;
  readonly root: string;
  readonly queueFile: string;
};

function lab(sessionId = "s-1"): Lab {
  const root = mkdtempSync(join(tmpdir(), "trylo-dispatch-"));
  const home = join(root, "home");

  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  let ids = 0;
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd: root,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,

    readFile: (absolutePath) => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => 1_700_000_000_000,
    newId: (prefix) => `${prefix}-${(ids += 1)}`,
  };

  return { ctx, root, queueFile: sessionQueuePath(home, {}, sessionId) };
}

async function seed(l: Lab, texts: ReadonlyArray<string>): Promise<void> {
  const queue = createFileBackgroundQueue({
    path: l.queueFile,
    clock: { now: l.ctx.now, newId: l.ctx.newId },
  });

  for (const text of texts) {
    const put = await queue.enqueue(text);
    assert.equal(put.ok, true);
  }

  await queue.release();
}

async function remainingIn(l: Lab): Promise<ReadonlyArray<string>> {
  const queue = createFileBackgroundQueue({
    path: l.queueFile,
    clock: { now: l.ctx.now, newId: l.ctx.newId },
  });
  const page = await queue.list(0, 50);

  await queue.release();
  assert.equal(page.ok, true);

  return (page.ok ? page.value.items : []).map((item) => item.text);
}

test("an empty queue is idle, not an error", async () => {
  const l = lab();
  try {
    const dispatch = createIdleDispatch(l.ctx);
    assert.deepEqual(await dispatch("s-1"), { kind: "idle" });
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("one call takes one message and leaves the rest queued", async () => {
  const l = lab();
  try {
    await seed(l, ["first", "second"]);
    const dispatch = createIdleDispatch(l.ctx);
    const got = await dispatch("s-1");

    assert.equal(got.kind, "turn");

    if (got.kind !== "turn") return;

    assert.equal(got.text, "first");
    assert.equal(got.id, "q-1");
    assert.equal(got.remaining, 1);
    assert.deepEqual(await remainingIn(l), ["second"]);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("successive idle ticks drain the queue oldest first", async () => {
  const l = lab();
  try {
    await seed(l, ["a", "b", "c"]);
    const dispatch = createIdleDispatch(l.ctx);
    const taken: Array<string> = [];

    for (;;) {
      const got = await dispatch("s-1");
      if (got.kind !== "turn") {
        assert.equal(got.kind, "idle");
        break;
      }
      taken.push(got.text);
    }

    assert.deepEqual(taken, ["a", "b", "c"]);
    assert.deepEqual(await remainingIn(l), []);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("the last message reports no remainder, so the shell can say so", async () => {
  const l = lab();
  try {
    await seed(l, ["only"]);
    const dispatch = createIdleDispatch(l.ctx);
    const got = await dispatch("s-1");
    assert.equal(got.kind === "turn" && got.remaining, 0);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a message is taken exactly once", async () => {
  const l = lab();
  try {
    await seed(l, ["once"]);
    const dispatch = createIdleDispatch(l.ctx);
    assert.equal((await dispatch("s-1")).kind, "turn");
    // The second tick must find nothing. If the take were a read, this is where
    // one message would be answered twice — invisibly, since both turns succeed.
    assert.deepEqual(await dispatch("s-1"), { kind: "idle" });
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a second dispatcher over the same queue is refused, never served a second message", async () => {
  const l = lab();
  try {
    await seed(l, ["x", "y"]);
    const one = createIdleDispatch(l.ctx);
    const two = createIdleDispatch(l.ctx);
    const results = await Promise.all([one("s-1"), two("s-1")]);
    const started = results.filter((r) => r.kind === "turn");
    const refused = results.filter((r) => r.kind === "unknown");

    // The writer lock is a file, and existence is the whole predicate — so a
    // second dispatcher *in this process* is refused exactly as a second
    // process would be. That is the point: within one session there is one
    // dispatcher, and if that invariant is ever broken the queue refuses rather
    // than answering one message twice.
    assert.equal(started.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.kind === "unknown" && refused[0].code, "queue_locked");
    // The refused one changed nothing.
    assert.deepEqual(await remainingIn(l), ["y"]);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("an unreadable queue is refused and stays refused, never read as idle", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.root, "home", ".trylo", "queue"), { recursive: true });
    writeFileSync(l.queueFile, "{ not json\n");
    const dispatch = createIdleDispatch(l.ctx);
    // "Idle" here would be the dangerous answer: the person would conclude their
    // message was never queued, and send it again somewhere else.
    assert.deepEqual(await dispatch("s-1"), { kind: "unknown", code: "queue_unreadable" });
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a locked queue is refused as locked, which is temporary by nature", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.root, "home", ".trylo", "queue"), { recursive: true });
    writeFileSync(`${l.queueFile}.lock`, "999999");
    assert.deepEqual(await createIdleDispatch(l.ctx)("s-1"), { kind: "unknown", code: "queue_locked" });
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("queues are per session: another session's messages are not taken", async () => {
  const l = lab();
  try {
    await seed(l, ["mine"]);
    const dispatch = createIdleDispatch(l.ctx);
    assert.deepEqual(await dispatch("s-2"), { kind: "idle" });
    assert.equal((await dispatch("s-1")).kind, "turn");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("TRYLO_HOME moves the queue, and both faces follow it", async () => {
  const l = lab();
  const alt = join(l.root, "elsewhere");

  try {
    // Both the path and the context move, because the writer resolves the queue
    // from the environment and so does the consumer. Checking one against a
    // path built for the other would pass for the wrong reason.
    const moved: Lab = {
      ...l,
      ctx: { ...l.ctx, env: { TRYLO_HOME: alt } },
      queueFile: sessionQueuePath(l.ctx.homeDir, { TRYLO_HOME: alt }, "s-1"),
    };

    await seed(moved, ["over here"]);
    assert.equal(existsSync(moved.queueFile), true);
    // The consumer resolves its own path from the same environment. If the
    // writer honoured TRYLO_HOME and the reader did not, this queue would fill
    // up forever and nothing would ever be answered.
    const got = await createIdleDispatch(moved.ctx)("s-1");

    assert.equal(got.kind === "turn" && got.text, "over here");
    assert.deepEqual(await remainingIn(moved), []);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
