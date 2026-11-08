import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import { MAX_QUEUED_MESSAGES } from "../../ports/background-queue.js";
import type { CliContext } from "./context.js";
import { handleQueueAdd, handleQueueDrop, handleQueueList } from "./commands-queue.js";
import { sessionQueuePath } from "./session-paths.js";

/**
 * The three verbs, driven in-process against a real queue file.
 *
 * The claims under test are the ones a person would be misled by if they broke:
 * an unreadable queue is never printed as an empty one; a truncated listing says
 * it was truncated; a refusal to drop says which id was not found rather than
 * failing silently; and the queue file lives where `session-paths.ts` says it
 * does, because `trylo queue` and the session that consumes it are two
 * processes that have to agree on a path without talking.
 */

type Lab = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly root: string;
  readonly queueFile: string;
};

function lab(sessionId = "s-1"): Lab {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-queue-"));
  const home = join(root, "home");

  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  let ids = 0;
  let at = 1_700_000_000_000;
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
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),

    now: () => {
      at += 1_000;
      return at;
    },

    newId: (prefix) => `${prefix}-${(ids += 1)}`,
  };

  return { ctx, out, err, root, queueFile: sessionQueuePath(home, {}, sessionId) };
}

function text(labbed: Lab): string {
  return labbed.out.join("");
}

function json(labbed: Lab): Record<string, unknown> {
  const line = text(labbed).trim();
  return JSON.parse(line) as Record<string, unknown>;
}

test("add says the id, because drop needs it", async () => {
  const l = lab();
  try {
    const code = await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "run the tests", json: false });
    assert.equal(code, EXIT_CODES.OK);
    assert.match(text(l), /queued for session s-1 as q-\d+ \(\d+ chars, starts when it goes idle\)/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("the queue file lands where session-paths says, and both faces agree", async () => {
  const l = lab();
  try {
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "hi", json: false });
    assert.equal(existsSync(l.queueFile), true);
    // The consumer side resolves the same path through the same formula. If
    // these two ever disagree, `trylo queue` succeeds and the session never
    // sees the message — the failure mode this asserts against.
    const queue = createFileBackgroundQueue({
      path: sessionQueuePath(l.ctx.homeDir, l.ctx.env, "s-1"),
      clock: { now: l.ctx.now, newId: l.ctx.newId },
    });
    const page = await queue.list(0, 10);

    await queue.release();
    assert.equal(page.ok, true);
    assert.equal(page.ok && page.value.total, 1);
    assert.equal(page.ok && page.value.items[0]?.text, "hi");
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("add --json answers with the whole record a later drop needs", async () => {
  const l = lab();
  try {
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "hi", json: true });
    // The timestamp is compared to the file, not to `ctx.now()`: this fixture's
    // clock advances on every call, so asking it again here would answer about
    // a moment that never happened.
    const stored = JSON.parse(readFileSync(l.queueFile, "utf8").trim()) as { enqueuedAtMs: number };
    const got = json(l);

    assert.equal(got["ok"], true);
    assert.equal(got["id"], "q-1");
    assert.equal(got["sessionId"], "s-1");
    assert.equal(got["enqueuedAtMs"], stored.enqueuedAtMs);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("list of nothing says nothing queued, and that is a success", async () => {
  const l = lab();
  try {
    const code = await handleQueueList(l.ctx, { sessionId: "s-1", json: false, limit: 20 });
    assert.equal(code, EXIT_CODES.OK);
    assert.match(text(l), /nothing queued for session s-1/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("list reads as one line per message, oldest first", async () => {
  const l = lab();
  try {
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "first", json: false });
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "second\nspans lines", json: false });
    l.out.length = 0;
    await handleQueueList(l.ctx, { sessionId: "s-1", json: false, limit: 20 });
    const rows = text(l).trim().split("\n");

    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", /q-1 .*first$/);
    // A message that spans lines is shown on one: a listing whose rows shift
    // when a message is long cannot be read as a list of messages.
    assert.match(rows[1] ?? "", /q-2 .*second spans lines$/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a truncated listing says how much it left out", async () => {
  const l = lab();
  try {
    for (let i = 0; i < 5; i += 1) {
      await handleQueueAdd(l.ctx, { sessionId: "s-1", text: `m${i}`, json: false });
    }

    l.out.length = 0;
    await handleQueueList(l.ctx, { sessionId: "s-1", json: false, limit: 2 });
    const body = text(l);

    assert.match(body, /showing 2 of 5; --limit 4 for more/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("an unreadable queue is refused, never reported as an empty one", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.root, "home", ".trylo", "queue"), { recursive: true });
    writeFileSync(l.queueFile, "{ this is not json\n");
    const code = await handleQueueList(l.ctx, { sessionId: "s-1", json: false, limit: 20 });

    assert.equal(code, EXIT_CODES.USAGE);
    assert.doesNotMatch(text(l), /nothing queued/);
    assert.match(l.err.join(""), /could not be read/);
    // The refusal has to name the distinction, or the person retries forever.
    assert.match(l.err.join(""), /not an empty one/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("drop removes exactly the named message and says it will not be sent", async () => {
  const l = lab();
  try {
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "keep me", json: false });
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "drop me", json: false });
    l.out.length = 0;
    const code = await handleQueueDrop(l.ctx, { sessionId: "s-1", id: "q-1", json: false });

    assert.equal(code, EXIT_CODES.OK);
    assert.match(text(l), /dropped q-1; it will not be sent/);
    l.out.length = 0;
    await handleQueueList(l.ctx, { sessionId: "s-1", json: false, limit: 20 });
    assert.doesNotMatch(text(l), /keep me/);
    assert.match(text(l), /drop me/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("dropping an id that is not queued is a usage error with the remedy", async () => {
  const l = lab();
  try {
    await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "hi", json: false });
    const code = await handleQueueDrop(l.ctx, { sessionId: "s-1", id: "q-nope", json: false });
    assert.equal(code, EXIT_CODES.USAGE);
    assert.match(l.err.join(""), /no queued message has that id/);
    assert.match(l.err.join(""), /queue list --session <id>/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a full queue is refused with the number, and the number is the shared cap", async () => {
  const l = lab();
  try {
    const queue = createFileBackgroundQueue({
      path: l.queueFile,
      clock: { now: l.ctx.now, newId: l.ctx.newId },
    });

    for (let i = 0; i < MAX_QUEUED_MESSAGES; i += 1) {
      const put = await queue.enqueue(`m${i}`);
      assert.equal(put.ok, true, `message ${i} should have been accepted`);
    }

    await queue.release();
    const code = await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "one too many", json: false });

    assert.equal(code, EXIT_CODES.USAGE);
    assert.match(l.err.join(""), new RegExp(`full \\(${MAX_QUEUED_MESSAGES} messages\\)`));
    assert.match(l.err.join(""), /queue list --session <id>/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("a held lock is temporary and names the other writer instead of retrying", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.root, "home", ".trylo", "queue"), { recursive: true });
    // Existence is the whole lock predicate, so a file is enough to hold it —
    // including one left by a process that died.
    writeFileSync(`${l.queueFile}.lock`, "999999");
    const code = await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "hi", json: false });

    assert.equal(code, EXIT_CODES.TEMPORARY);
    assert.match(l.err.join(""), /another writer is holding/);
    // "Delete the lock" is advice with a precondition attached. Without the
    // precondition it is advice to lose a message.
    assert.match(l.err.join(""), /once you are sure nothing is running/);
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});

test("one refused verb does not leave the queue unusable", async () => {
  const l = lab();
  try {
    mkdirSync(join(l.root, "home", ".trylo", "queue"), { recursive: true });
    writeFileSync(`${l.queueFile}.lock`, "999999");
    assert.equal(
      await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "hi", json: false }),
      EXIT_CODES.TEMPORARY,
    );
    rmSync(`${l.queueFile}.lock`);
    // The refusal belonged to the operation, not to the queue. If the handler
    // kept the lock past it, this add would fail with nothing left to fix.
    assert.equal(
      await handleQueueAdd(l.ctx, { sessionId: "s-1", text: "hi", json: false }),
      EXIT_CODES.OK,
    );
  } finally {
    rmSync(l.root, { recursive: true, force: true });
  }
});
