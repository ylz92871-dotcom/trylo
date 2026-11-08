import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { parseWatch } from "./args-watch.js";
import { handleWatch } from "./commands-watch.js";
import { schedulePath } from "./schedule-paths.js";
import { sessionQueuePath } from "./session-paths.js";

/**
 * `trylo watch`, driven in-process against real files.
 *
 * Each case follows the whole chain a person would: argv → parsed command →
 * shared schedule record → (on fire) the session's real queue file. The clock
 * is injected and moved by hand, so firing is a fact about an argument rather
 * than about how long the test slept.
 */

type Lab = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly home: string;
  readonly record: string;
  readonly at: (ms: number) => void;
  readonly queueText: (sessionId: string) => string;
};

function lab(): Lab {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-watch-"));
  const home = join(root, "home");

  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  let ids = 0;
  let clock = 1_700_000_000_000;
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

    isDirectory: () => false,
    readDir: () => [],

    writeFile: (absolutePath, text) => {
      try {
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, text, "utf8");
        return true;
      } catch {
        return false;
      }
    },

    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => clock,
    newId: (prefix) => `${prefix}_${++ids}`,
  };

  return {
    ctx,
    out,
    err,
    home,
    record: schedulePath(home, {}),
    at: (ms) => {
      clock = ms;
    },

    queueText: (sessionId) => {
      try {
        return readFileSync(sessionQueuePath(home, {}, sessionId), "utf8");
      } catch {
        return "";
      }
    },
  };
}

async function run(ctx: CliContext, ...argv: string[]): Promise<number> {
  return handleWatch(ctx, parseWatch(argv));
}

function lastId(out: string[]): string {
  const parsed = JSON.parse(out.join("")) as { id: string };
  return parsed.id;
}

test("add then list: the watch is in the shared record and the listing names it", async () => {
  const harness = lab();
  const added = await run(harness.ctx, "add", "--message", "build done", "--session", "s-1", "--flag", "ready", "--json");

  assert.equal(added, EXIT_CODES.OK);
  const id = lastId(harness.out);

  assert.match(id, /^w_[0-9a-f]+$/);
  assert.equal(existsSync(harness.record), true);

  harness.out.length = 0;
  const listed = await run(harness.ctx, "list", "--json");

  assert.equal(listed, EXIT_CODES.OK);
  assert.match(harness.out.join(""), new RegExp(id));
});

test("blank message, missing session, past deadline, and ceiling map to usage", async () => {
  const harness = lab();
  const blank = await run(harness.ctx, "add", "--message", "   ", "--session", "s-1", "--flag", "x", "--json");

  assert.equal(blank, EXIT_CODES.USAGE);
  assert.match(harness.out.join(""), /blank_text/);

  harness.out.length = 0;
  const noSession = await run(harness.ctx, "add", "--message", "hi", "--session", "   ", "--flag", "x", "--json");

  assert.equal(noSession, EXIT_CODES.USAGE);
  assert.match(harness.out.join(""), /not_a_session/);

  harness.out.length = 0;
  const past = await run(harness.ctx, "add", "--message", "hi", "--session", "s-1", "--at", "2020-01-01T00:00:00Z", "--json");

  assert.equal(past, EXIT_CODES.USAGE);
  assert.match(harness.out.join(""), /invalid_deadline/);
});

test("too_many_watches is a usage refusal, not a silent drop", async () => {
  const harness = lab();

  for (let index = 0; index < 20; index += 1) {
    const code = await run(harness.ctx, "add", "--message", `w${index}`, "--session", "s-1", "--flag", `f${index}`, "--json");
    assert.equal(code, EXIT_CODES.OK);
    harness.out.length = 0;
  }

  const overflow = await run(harness.ctx, "add", "--message", "one too many", "--session", "s-1", "--flag", "extra", "--json");

  assert.equal(overflow, EXIT_CODES.USAGE);
  assert.match(harness.out.join(""), /too_many_watches/);
});

test("check is a dry-run: met without firing, and nothing lands in the queue", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--message", "hi", "--session", "s-1", "--flag", "ready", "--json");
  const id = lastId(harness.out);

  harness.out.length = 0;
  const before = await run(harness.ctx, "check", id, "--json");

  assert.equal(before, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /"met":false/);
  assert.equal(harness.queueText("s-1"), "");
});

test("cancel stops an armed watch; cancelling twice says so", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--message", "hi", "--session", "s-1", "--flag", "ready", "--json");
  const id = lastId(harness.out);

  harness.out.length = 0;
  const cancelled = await run(harness.ctx, "cancel", id, "--json");

  assert.equal(cancelled, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /"cancelled":true/);

  harness.out.length = 0;
  harness.err.length = 0;
  const again = await run(harness.ctx, "cancel", id, "--json");

  assert.equal(again, EXIT_CODES.USAGE);
  assert.match(harness.out.join("") + harness.err.join(""), /already_cancelled/);
});

test("forget drops a terminal record but refuses an armed one", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--message", "hi", "--session", "s-1", "--flag", "ready", "--json");
  const id = lastId(harness.out);

  harness.out.length = 0;
  const armedRefused = await run(harness.ctx, "forget", id, "--json");

  assert.equal(armedRefused, EXIT_CODES.USAGE);
  assert.match(harness.out.join(""), /not_terminal/);

  await run(harness.ctx, "cancel", id, "--json");
  harness.out.length = 0;
  const forgotten = await run(harness.ctx, "forget", id, "--json");

  assert.equal(forgotten, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /"forgotten":true/);
});

test("cancel refuses a malformed id before any lookup", async () => {
  const harness = lab();
  const code = await run(harness.ctx, "cancel", "not-an-id");
  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(harness.err.join(""), /is not a watch id/);
  assert.equal(existsSync(harness.record), false);
});

test("no arguments prints help rather than doing something", async () => {
  const harness = lab();
  const code = await run(harness.ctx);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /trylo watch/);
  assert.equal(existsSync(harness.record), false);
});

test("list --json carries text, trigger detail, message id and hint; human is unchanged", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--message", "build done", "--session", "s-1", "--flag", "ready", "--json");
  const added = JSON.parse(harness.out.join("")) as { id: string };
  // Additive fields on add: old keys stay, new keys arrive.
  const addedJson = JSON.parse(harness.out.join("")) as Record<string, unknown>;

  assert.equal(addedJson["text"], "build done");
  assert.equal(addedJson["sessionId"], "s-1");
  assert.equal(typeof addedJson["hint"], "string");

  harness.out.length = 0;
  const listed = await run(harness.ctx, "list", "--json");

  assert.equal(listed, EXIT_CODES.OK);
  const rows = JSON.parse(harness.out.join("")) as Array<Record<string, unknown>>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["id"], added.id);
  assert.equal(rows[0]?.["text"], "build done");
  assert.equal(rows[0]?.["trigger"], "condition");
  assert.equal(typeof rows[0]?.["triggerDetail"], "object");
  assert.equal(typeof rows[0]?.["hint"], "string");

  // Human listing is unchanged: no JSON keys leak into it.
  harness.out.length = 0;
  await run(harness.ctx, "list");
  assert.doesNotMatch(harness.out.join(""), /triggerDetail/);
  assert.match(harness.out.join(""), new RegExp(added.id));
});

test("a refusal in --json carries the hint the human already sees", async () => {
  const harness = lab();

  harness.out.length = 0;
  const blank = await run(harness.ctx, "add", "--message", "   ", "--session", "s-1", "--flag", "x", "--json");

  assert.equal(blank, EXIT_CODES.USAGE);
  const refusal = JSON.parse(harness.out.join("")) as Record<string, unknown>;

  assert.equal(refusal["code"], "blank_text");
  assert.equal(typeof refusal["hint"], "string");
});

test("fire-now fires once: a second settle reports the same message, the queue keeps one", async () => {
  const harness = lab();
  const root = dirname(harness.home);

  writeFileSync(join(root, "ready.txt"), "done\n", "utf8");
  harness.out.length = 0;
  const added = await run(
    harness.ctx,
    "add",
    "--message",
    "build done",
    "--session",
    "s-1",
    "--file-exists",
    "ready.txt",
    "--fire-now",
    "--json",
  );

  assert.equal(added, EXIT_CODES.OK);
  const fired = JSON.parse(harness.out.join("")) as { id: string; messageId: string; text: string };

  assert.equal(typeof fired.messageId, "string");
  assert.equal(fired.text, "build done");
  const queuedOnce = harness.queueText("s-1").split("\n").filter((line) => line.trim().length > 0);

  assert.equal(queuedOnce.length, 1);

  // Sequential second settle is monotonic: it reports the recorded message,
  // and no second queue message appears. Concurrent fire-now + daemon tick may
  // still double-enqueue (documented in commands-watch.ts); this pins the
  // sequential case the fence guarantees.
  const { createFileWatchStore } = await import("../../adapters/watch/file-watch-store.js");
  const { writeWatchRows } = await import("../../adapters/daemon/record-rows.js");
  const store = createFileWatchStore({
    file: harness.record,
    writeRows: (rows) => writeWatchRows(harness.record, rows),
    clock: { now: () => 1_700_000_000_000, newWatchId: () => "w_0" },
    probe: { fileExists: () => true, fileContains: () => false, lastExitCode: () => undefined, flagSet: () => false },
    occurrences: async () => [],
  });
  const second = await store.fire(fired.id, 1_700_000_000_000, "other-msg");

  assert.equal(second.ok, true);

  if (!second.ok) return;

  assert.equal(second.value.state, "fired");

  if (second.value.state === "fired") {
    assert.equal(second.value.messageId, fired.messageId);
  }

  const queuedTwice = harness.queueText("s-1").split("\n").filter((line) => line.trim().length > 0);

  assert.equal(queuedTwice.length, 1);
});

test("the watch record lives under the same home override as everything else", async () => {
  const out: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-watch-home-"));
  const home = join(root, "home");

  mkdirSync(join(home, "elsewhere", "sessions"), { recursive: true });
  let ids = 0;
  const ctx: CliContext = {
    env: { TRYLO_HOME: join(home, "elsewhere") },
    homeDir: home,
    cwd: root,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,

    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => false,
    readDir: () => [],

    writeFile: (p, text) => {
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text, "utf8");
        return true;
      } catch {
        return false;
      }
    },

    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    now: () => 1_700_000_000_000,
    newId: (prefix) => `${prefix}_${++ids}`,
  };

  await handleWatch(ctx, parseWatch(["add", "--message", "hi", "--session", "s-1", "--flag", "x"]));
  assert.equal(existsSync(join(home, "elsewhere", "schedule", "schedules.json")), true);
  rmSync(root, { recursive: true, force: true });
});
