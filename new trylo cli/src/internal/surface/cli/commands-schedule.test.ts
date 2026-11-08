import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { parseSchedule } from "./args-schedule.js";
import { handleSchedule } from "./commands-schedule.js";
import { schedulePath } from "./schedule-paths.js";
import { sessionQueuePath } from "./session-paths.js";

/**
 * `trylo schedule`, driven in-process against real files.
 *
 * Each case follows the whole chain a person would: argv → parsed command → store
 * → durable record, and where a fire happens, → the session's real queue file.
 * The assertions read those files, because the claims that matter are about what
 * survives, not about which methods were called.
 *
 * The clock is injected and moved by hand, so "the schedule fired" is a fact
 * about an argument rather than a fact about how long the test slept.
 */

type Lab = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly root: string;
  readonly home: string;
  readonly record: string;
  readonly at: (ms: number) => void;
  readonly queueText: (sessionId: string) => string;
};

function lab(): Lab {
  const out: string[] = [];
  const err: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-schedule-"));
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
    root,
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

/** Drive the command exactly as argv would, and return the exit code. */
async function run(ctx: CliContext, ...argv: string[]): Promise<number> {
  return handleSchedule(ctx, parseSchedule(argv));
}

test("add then list: the schedule is on disk and the listing says when it next fires", async () => {
  const harness = lab();
  const added = await run(harness.ctx, "add", "--cron", "0 9 * * *", "--prompt", "check the build", "--session", "s-1");

  assert.equal(added, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /Scheduled sch_[0-9a-f]{8}/);

  // The record exists and holds the prompt, which is the part that has to
  // survive: an acknowledgement nobody can re-read is not an acknowledgement.
  assert.equal(existsSync(harness.record), true);
  const stored = JSON.parse(readFileSync(harness.record, "utf8")) as {
    schedules: ReadonlyArray<{ id: string; cron: string; prompt: string; sessionId?: string }>;
  };

  assert.equal(stored.schedules.length, 1);
  assert.equal(stored.schedules[0]?.prompt, "check the build");
  assert.equal(stored.schedules[0]?.cron, "0 9 * * *");
  assert.equal(stored.schedules[0]?.sessionId, "s-1");

  harness.out.length = 0;
  const listed = await run(harness.ctx, "list");

  assert.equal(listed, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /sch_[0-9a-f]{8}/);
  assert.match(harness.out.join(""), /Every day at/);
});

test("add refuses a bad expression before anything is written", async () => {
  const harness = lab();
  const code = await run(harness.ctx, "add", "--cron", "not a cron", "--prompt", "x", "--session", "s-1");
  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(harness.err.join(""), /cron expression/);
  // Nothing was created: a refused schedule must not leave a row behind.
  assert.equal(existsSync(harness.record), false);
});

test("run hands the prompt to the session's real queue, and the text lands there", async () => {
  const harness = lab();

  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "run the smoke tests", "--session", "s-1", "--json");

  // Nothing is due yet.
  const tooEarly = await run(harness.ctx, "run", "--json");

  assert.equal(tooEarly, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /"fired":\[\]/);
  assert.equal(harness.queueText("s-1"), "");

  // A minute later the occurrence is due, and firing writes to the queue the
  // session already reads — the same file `trylo queue --message` would write.
  harness.out.length = 0;
  harness.at(1_700_000_060_000);
  const fired = await run(harness.ctx, "run", "--json");

  assert.equal(fired, EXIT_CODES.OK);
  const report = JSON.parse(harness.out.join("")) as { fired: ReadonlyArray<{ outcome: string }> };

  assert.equal(report.fired.length, 1);
  assert.equal(report.fired[0]?.outcome, "completed");
  // The durable fact: the prompt is in the session's queue, byte for byte.
  const queued = harness.queueText("s-1");

  assert.match(queued, /run the smoke tests/);
});

test("the lease is released, so a second run can fire", async () => {
  const harness = lab();

  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick", "--session", "s-1");
  harness.at(1_700_000_060_000);
  const first = await run(harness.ctx, "run", "--json");

  assert.equal(first, EXIT_CODES.OK);
  // If the lease leaked, this would refuse with `not_owner` rather than firing.
  harness.at(1_700_000_120_000);
  harness.out.length = 0;
  const second = await run(harness.ctx, "run", "--json");

  assert.equal(second, EXIT_CODES.OK);
  assert.match(harness.err.join(""), /^$/);
  const report = JSON.parse(harness.out.join("")) as { fired: ReadonlyArray<{ outcome: string }> };

  assert.equal(report.fired.length, 1);
});

test("a removed schedule never fires again", async () => {
  const harness = lab();

  harness.out.length = 0;
  const added = await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick", "--session", "s-1", "--json");

  assert.equal(added, EXIT_CODES.OK);
  const created = JSON.parse(harness.out.join("")) as { id: string };

  const removed = await run(harness.ctx, "remove", created.id);

  assert.equal(removed, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /will not fire again/);

  harness.out.length = 0;
  harness.at(1_700_000_060_000);
  const afterDelete = await run(harness.ctx, "run", "--json");

  assert.equal(afterDelete, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /"fired":\[\]/);
  assert.equal(harness.queueText("s-1"), "");
});

test("removing twice says so instead of claiming a second deletion", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick", "--session", "s-1", "--json");
  const created = JSON.parse(harness.out.join("")) as { id: string };

  await run(harness.ctx, "remove", created.id);
  harness.err.length = 0;
  const again = await run(harness.ctx, "remove", created.id);

  assert.equal(again, EXIT_CODES.USAGE);
  assert.match(harness.err.join(""), /already deleted/);
});

test("remove refuses a malformed id as a usage error, not as a missing schedule", async () => {
  const harness = lab();
  const code = await run(harness.ctx, "remove", "not-an-id");

  // The id never reaches a lookup, so the person is told the real problem: it is
  // not a well-formed id, which is a different message from "no such schedule".
  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(harness.err.join(""), /is not a schedule id/);
  assert.doesNotMatch(harness.err.join(""), /no such schedule/);
  assert.equal(existsSync(harness.record), false);
});

test("a schedule with no session reports the real blocker when it fires", async () => {
  const harness = lab();

  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick");
  harness.out.length = 0;
  harness.at(1_700_000_060_000);
  const fired = await run(harness.ctx, "run", "--json");

  assert.equal(fired, EXIT_CODES.OK);
  const report = JSON.parse(harness.out.join("")) as { fired: ReadonlyArray<{ outcome: string }> };

  // "There is nowhere to put this" is a real answer; silently succeeding is not.
  assert.equal(report.fired[0]?.outcome, "failed");
});

test("an unreadable record is reported, never listed as empty", async () => {
  const harness = lab();

  mkdirSync(dirname(harness.record), { recursive: true });
  writeFileSync(harness.record, "{ not json", "utf8");
  const code = await run(harness.ctx, "list");

  // "You have nothing scheduled" and "I could not read your schedules" lead a
  // person to opposite conclusions, and only one is true.
  assert.equal(code, EXIT_CODES.USAGE);
  assert.match(harness.err.join(""), /could not be read/);
  assert.doesNotMatch(harness.out.join(""), /no schedules/);
});

test("list says so plainly when there is genuinely nothing scheduled", async () => {
  const harness = lab();
  const code = await run(harness.ctx, "list");
  assert.equal(code, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /no schedules/);
});

test("a recurring schedule does not replay every minute it missed", async () => {
  const harness = lab();

  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick", "--session", "s-1");
  harness.at(1_700_000_060_000);
  await run(harness.ctx, "run", "--json");
  const afterFirst = harness.queueText("s-1").split("\n").filter((line) => line.trim().length > 0).length;

  assert.equal(afterFirst, 1);

  // Two hours pass with nobody running the scheduler.
  harness.out.length = 0;
  harness.at(1_700_007_260_000);
  await run(harness.ctx, "run", "--json");
  const afterGap = harness.queueText("s-1").split("\n").filter((line) => line.trim().length > 0).length;

  // One owed occurrence, not one hundred and twenty.
  assert.equal(afterGap, 2);
});

test("--once produces a schedule that fires exactly one time", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "once", "--session", "s-1", "--once", "--json");
  const created = JSON.parse(harness.out.join("")) as { recurring: boolean };

  assert.equal(created.recurring, false);

  harness.at(1_700_000_060_000);
  await run(harness.ctx, "run", "--json");
  harness.at(1_700_000_120_000);
  harness.out.length = 0;
  await run(harness.ctx, "run", "--json");
  const report = JSON.parse(harness.out.join("")) as { fired: ReadonlyArray<unknown> };

  // A one-shot is done after it fires; a second run owes nothing.
  assert.equal(report.fired.length, 0);
});

test("remove is honest about unknown: human names reconciliation, deleting does not resolve it", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick", "--session", "s-1", "--json");
  const created = JSON.parse(harness.out.join("")) as { id: string };

  injectUnknown(harness.record, created.id);

  harness.out.length = 0;
  harness.err.length = 0;
  const removed = await run(harness.ctx, "remove", created.id);

  assert.equal(removed, EXIT_CODES.OK);
  const human = harness.out.join("");

  assert.match(human, /will not fire again/);
  assert.match(human, /unknown/);
  assert.match(human, /reconciliation/);
  assert.match(human, /does not resolve/);
});

test("remove --json counts unknown as work in flight", async () => {
  const harness = lab();

  harness.out.length = 0;
  await run(harness.ctx, "add", "--cron", "* * * * *", "--prompt", "tick", "--session", "s-1", "--json");
  const created = JSON.parse(harness.out.join("")) as { id: string };

  injectUnknown(harness.record, created.id);

  harness.out.length = 0;
  const removed = await run(harness.ctx, "remove", created.id, "--json");

  assert.equal(removed, EXIT_CODES.OK);
  const report = JSON.parse(harness.out.join("")) as { workInFlight: boolean; unknownInFlight: boolean };

  assert.equal(report.workInFlight, true);
  assert.equal(report.unknownInFlight, true);
});

/** Append an `unknown` occurrence for one schedule, the way a crash between run and settle leaves it. */
function injectUnknown(record: string, scheduleId: string): void {
  const parsed = JSON.parse(readFileSync(record, "utf8")) as {
    version: number;
    schedules: unknown[];
    occurrences: Array<Record<string, unknown>>;
  };

  parsed.occurrences.push({
    id: `${scheduleId}@1700000060000`,
    scheduleId,
    dueAtMs: 1_700_000_060_000,
    state: { state: "unknown", attemptId: "att_1", observedAtMs: 1_700_000_060_000, reason: "effect uncertain" },
    prompt: "tick",
    delivery: "queue",
    sessionId: "s-1",
  });
  writeFileSync(record, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

test("the schedule record lives under the same home override as everything else", async () => {
  const out: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-schedule-home-"));
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

  await handleSchedule(ctx, parseSchedule(["add", "--cron", "0 9 * * *", "--prompt", "x", "--session", "s-1"]));
  // One home formula: the override moves the schedule with sessions and queue,
  // rather than leaving the scheduler firing from a directory nobody uses.
  assert.equal(existsSync(join(home, "elsewhere", "schedule", "schedules.json")), true);
  rmSync(root, { recursive: true, force: true });
});

test("no arguments prints help rather than doing something", async () => {
  const harness = lab();
  const code = await run(harness.ctx);
  assert.equal(code, EXIT_CODES.OK);
  assert.match(harness.out.join(""), /trylo schedule/);
  assert.equal(existsSync(harness.record), false);
});
