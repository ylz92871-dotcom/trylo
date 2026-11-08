import assert from "node:assert/strict";
import test from "node:test";

import { isValidWatchId, parseWatch, resolveWatchTrigger } from "./args-watch.js";

/**
 * `trylo watch` parsing — the contract the handler can rely on.
 *
 * Each case drives the parser only: no files, no clock. A bad trigger is a
 * usage error here, never a watch left half-armed.
 */

test("add parses every trigger shape", () => {
  const base = ["add", "--message", "hi", "--session", "s-1"];

  assert.equal(parseWatch([...base, "--file-exists", "build.txt"]).verb, "add");
  assert.equal(parseWatch([...base, "--file-contains", "a.txt", "--needle", "ok"]).verb, "add");
  assert.equal(parseWatch([...base, "--exit-code", "0"]).verb, "add");
  assert.equal(parseWatch([...base, "--flag", "ready"]).verb, "add");
  assert.equal(parseWatch([...base, "--at", "2026-10-09T00:00:00Z"]).verb, "add");
  assert.equal(parseWatch([...base, "--in", "10s"]).verb, "add");
});

test("add requires message, session, and exactly one trigger", () => {
  const noMessage = parseWatch(["add", "--session", "s-1", "--flag", "x"]);

  assert.equal(noMessage.verb, "error");
  const noSession = parseWatch(["add", "--message", "hi", "--flag", "x"]);

  assert.equal(noSession.verb, "error");
  const noTrigger = parseWatch(["add", "--message", "hi", "--session", "s-1"]);

  assert.equal(noTrigger.verb, "error");
  const twoTriggers = parseWatch(["add", "--message", "hi", "--session", "s-1", "--flag", "a", "--at", "2026-10-09T00:00:00Z"]);

  assert.equal(twoTriggers.verb, "error");

  if (twoTriggers.verb === "error") {
    assert.match(twoTriggers.message, /exactly one trigger/);
  }
});

test("file-contains without needle and bad exit-code are usage errors", () => {
  const noNeedle = parseWatch(["add", "--message", "hi", "--session", "s-1", "--file-contains", "a.txt"]);
  assert.equal(noNeedle.verb, "error");
  const badExit = parseWatch(["add", "--message", "hi", "--session", "s-1", "--exit-code", "999"]);
  assert.equal(badExit.verb, "error");
  const badExitText = parseWatch(["add", "--message", "hi", "--session", "s-1", "--exit-code", "x"]);
  assert.equal(badExitText.verb, "error");
});

test("cancel/check/forget validate the watch id shape", () => {
  for (const verb of ["cancel", "check", "forget"] as const) {
    const parsed = parseWatch([verb, "w_abc123"]);
    assert.equal(parsed.verb, verb);
  }

  const bad = parseWatch(["cancel", "not-an-id"]);

  assert.equal(bad.verb, "error");

  if (bad.verb === "error") {
    assert.match(bad.message, /is not a watch id/);
  }

  const missing = parseWatch(["check"]);

  assert.equal(missing.verb, "error");
});

test("list accepts an optional session filter and --json", () => {
  const listed = parseWatch(["list", "--session", "s-1", "--json"]);

  assert.equal(listed.verb, "list");

  if (listed.verb === "list") {
    assert.equal(listed.options.sessionId, "s-1");
    assert.equal(listed.options.json, true);
  }

  const bare = parseWatch(["list"]);

  assert.equal(bare.verb, "list");
});

test("help and unknown subcommands", () => {
  assert.equal(parseWatch([]).verb, "help");
  assert.equal(parseWatch(["--help"]).verb, "help");
  const unknown = parseWatch(["watch"]);
  assert.equal(unknown.verb, "error");
});

test("watch ids are w_ plus hex", () => {
  assert.equal(isValidWatchId("w_abc123"), true);
  assert.equal(isValidWatchId("w_0"), true);
  assert.equal(isValidWatchId("w1"), false);
  assert.equal(isValidWatchId("sch_abcdef12"), false);
  assert.equal(isValidWatchId("w_ZZ"), false);
});

test("resolveWatchTrigger parses --at and --in without touching the clock", () => {
  const at = resolveWatchTrigger(1000, { kind: "deadline_at", atText: "2026-10-09T00:00:00Z" });

  assert.ok("trigger" in at && at.trigger.kind === "deadline");
  const badAt = resolveWatchTrigger(1000, { kind: "deadline_at", atText: "not-a-time" });

  assert.ok("verb" in badAt);
  const within = resolveWatchTrigger(1000, { kind: "deadline_in", inText: "10s" });

  assert.ok("trigger" in within && within.trigger.kind === "deadline");

  if ("trigger" in within && within.trigger.kind === "deadline") {
    assert.equal(within.trigger.atMs, 11000);
  }

  const badIn = resolveWatchTrigger(1000, { kind: "deadline_in", inText: "ten" });

  assert.ok("verb" in badIn);
});
