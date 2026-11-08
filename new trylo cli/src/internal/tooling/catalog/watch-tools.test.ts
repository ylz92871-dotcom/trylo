import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import { createFileWatchStore } from "../../adapters/watch/file-watch-store.js";
import type { ApprovalConsumptionPort } from "../../ports/approval-consumption.js";
import type { Occurrence } from "../../ports/schedule.js";
import {
  BRIEF_BINDING,
  BRIEF_MAX_ATTACHMENTS,
  BRIEF_MAX_ATTACHMENT_BYTES,
  MONITOR_BINDING,
  SLEEP_BINDING,
  SUBSCRIBE_BINDING,
  briefIsConcurrencySafe,
  briefIsReadOnly,
  checkBriefAttachments,
  executeBriefTool,
  executeMonitorTool,
  executeSleepTool,
  executeSubscribeTool,
  monitorIsConcurrencySafe,
  monitorIsReadOnly,
  sleepIsConcurrencySafe,
  sleepIsReadOnly,
  subscribeIsConcurrencySafe,
  subscribeIsReadOnly,
} from "./watch-tools.js";

/**
 * A07 minimal tools: permission first, no local fakes.
 *
 * The gate is the whole contract: no port is `no_port`, a denial injects
 * nothing (no watch armed, no message queued), and `subscribe` stays
 * `remote_required` even when approved. Stores and queues are real files, so
 * "nothing was injected" is a fact about bytes on disk.
 */

const NOW_ISO = "2026-10-08T00:00:00.000Z";
const T0 = 1_700_000_000_000;

function lab() {
  const dir = mkdtempSync(join(tmpdir(), "wp-a07-tools-"));
  const file = join(dir, "schedules.json");
  let clock = T0;
  let ids = 0;
  const occurrences: Array<Occurrence> = [];
  const watches = createFileWatchStore({
    file,
    writeRows: (rows) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 1, schedules: rows, occurrences }, null, 2) + "\n", "utf8");
      return true;
    },
    clock: { now: () => clock, newWatchId: () => `w_${(++ids).toString(16)}` },
    probe: { fileExists: () => false, fileContains: () => false, lastExitCode: () => undefined, flagSet: () => false },
    occurrences: async () => occurrences,
  });
  const queueFor = (sessionId: string) =>
    createFileBackgroundQueue({
      path: join(dir, "queue", `${sessionId}.ndjson`),
      clock: { now: () => clock, newId: (prefix) => `${prefix}_${++ids}` },
    });

  return {
    watches,
    queueFor,
    file,
    at: (ms: number) => {
      clock = ms;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function grantingPort(): ApprovalConsumptionPort {
  return {
    consume: async () => ({
      ok: true,
      value: {
        grantId: "grant:test",
        action: "acquire",
        candidateId: "cand-a07",
        packageVersionId: "pkg:a07:1.0.0",
        scope: "watch",
        consumedAt: NOW_ISO,
        sequence: 1,
      },
    }),
  };
}

function denyingPort(): ApprovalConsumptionPort {
  return {
    consume: async () => ({ ok: false, code: "grant_revoked", message: "denied" }),
  };
}

const APPROVAL_BASE = {
  now: NOW_ISO,
  candidateId: "cand-a07",
  packageVersionId: "pkg:a07:1.0.0",
  scope: "watch",
};

test("read-only and concurrency flags are declared, and match the bindings", () => {
  assert.equal(sleepIsReadOnly(), false);
  assert.equal(sleepIsConcurrencySafe(), true);
  assert.equal(SLEEP_BINDING.sideEffect === "read_only", sleepIsReadOnly());
  assert.equal(SLEEP_BINDING.parallelSafe === true, sleepIsConcurrencySafe());

  assert.equal(monitorIsReadOnly(), false);
  assert.equal(monitorIsConcurrencySafe(), true);
  assert.equal(MONITOR_BINDING.sideEffect === "read_only", monitorIsReadOnly());

  assert.equal(briefIsReadOnly(), true);
  assert.equal(briefIsConcurrencySafe(), true);
  assert.equal(BRIEF_BINDING.sideEffect, "read_only");
  assert.equal(BRIEF_BINDING.parallelSafe, true);

  assert.equal(subscribeIsReadOnly(), true);
  assert.equal(subscribeIsConcurrencySafe(), true);
  assert.equal(SUBSCRIBE_BINDING.sideEffect, "read_only");
});

test("sleep without a port is no_port and arms nothing", async () => {
  const h = lab();
  try {
    const result = await executeSleepTool(
      { ...APPROVAL_BASE },
      { message: "wake me", sessionId: "s-1", durationMs: 60000 },
      { watches: h.watches, nowMs: () => T0 },
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "no_port");
    }

    const listed = await h.watches.list("s-1");

    assert.equal(listed.ok && listed.value.length, 0);
  } finally {
    h.cleanup();
  }
});

test("sleep denied injects nothing; granted arms a deadline watch", async () => {
  const h = lab();
  try {
    const denied = await executeSleepTool(
      { ...APPROVAL_BASE, approvalPort: denyingPort() },
      { message: "wake me", sessionId: "s-1", durationMs: 60000 },
      { watches: h.watches, nowMs: () => T0 },
    );

    assert.equal(denied.ok, false);
    const listedAfterDeny = await h.watches.list("s-1");

    assert.equal(listedAfterDeny.ok && listedAfterDeny.value.length, 0);

    const granted = await executeSleepTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "wake me", sessionId: "s-1", durationMs: 60000 },
      { watches: h.watches, nowMs: () => T0 },
    );

    assert.equal(granted.ok, true);
    const listed = await h.watches.list("s-1");

    assert.equal(listed.ok && listed.value.length, 1);
  } finally {
    h.cleanup();
  }
});

test("monitor creates a condition watch and dry-runs without firing", async () => {
  const h = lab();
  try {
    const result = await executeMonitorTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "build?", sessionId: "s-1", condition: { kind: "flag_set", flag: "ready" } },
      { watches: h.watches },
    );

    assert.equal(result.ok, true);

    if (result.ok) {
      assert.equal(result.value.met, false);
    }

    const listed = await h.watches.list("s-1");

    assert.equal(listed.ok && listed.value.length, 1);
    assert.equal(listed.ok && listed.value[0]?.state.state, "armed");
  } finally {
    h.cleanup();
  }
});

test("brief denied queues nothing; granted delivers the old shape over the new queue", async () => {
  const h = lab();
  try {
    const denied = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: denyingPort() },
      { message: "hello", sessionId: "s-1", status: "proactive" },
      { queueFor: h.queueFor },
    );

    assert.equal(denied.ok, false);

    const granted = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "hello", sessionId: "s-1", attachments: ["a.png"], status: "proactive" },
      { queueFor: h.queueFor },
    );

    assert.equal(granted.ok, true);
    const page = await h.queueFor("s-1").list(0, 20);

    assert.equal(page.ok && page.value.total, 1);
    assert.match(page.ok ? page.value.items[0]?.text ?? "" : "", /\[brief:proactive\] hello/);
    await h.queueFor("s-1").release();
  } finally {
    h.cleanup();
  }
});

test("brief rejects bad status and bad attachments before touching the queue", async () => {
  const h = lab();
  try {
    const badStatus = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "hi", sessionId: "s-1", status: "urgent" },
      { queueFor: h.queueFor },
    );

    assert.equal(badStatus.ok, false);
    const badAttachments = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "hi", sessionId: "s-1", attachments: [""] },
      { queueFor: h.queueFor },
    );

    assert.equal(badAttachments.ok, false);
  } finally {
    h.cleanup();
  }
});

test("brief attachments are confined: absolute and dot-dot are usage refusals, queue untouched", async () => {
  const h = lab();
  try {
    const outside = [
      "/etc/passwd",
      "C:/Windows/x.png",
      "C:\\Windows\\x.png",
      "\\\\server\\share\\x.png",
      "../secret.txt",
      "a/../b.png",
      "a\\..\\b.png",
      "..",
    ];

    for (const ref of outside) {
      const result = await executeBriefTool(
        { ...APPROVAL_BASE, approvalPort: grantingPort() },
        { message: "hi", sessionId: "s-1", attachments: [ref] },
        { queueFor: h.queueFor },
      );

      assert.equal(result.ok, false, `expected refusal for ${ref}`);

      if (!result.ok) {
        assert.equal(result.code, "invalid_arguments");
      }
    }

    const page = await h.queueFor("s-1").list(0, 20);

    assert.equal(page.ok && page.value.total, 0);
    await h.queueFor("s-1").release();
  } finally {
    h.cleanup();
  }
});

test("brief attachments are bounded: count and total bytes are usage refusals", async () => {
  assert.equal(BRIEF_MAX_ATTACHMENTS, 10);
  assert.equal(BRIEF_MAX_ATTACHMENT_BYTES, 200 * 1024);
  assert.match(checkBriefAttachments(Array.from({ length: 11 }, () => "a.png")) ?? "", /maximum of 10/);
  assert.match(checkBriefAttachments(["a".repeat(210 * 1024)]) ?? "", /bytes of path text/);
  const h = lab();

  try {
    const tooMany = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "hi", sessionId: "s-1", attachments: Array.from({ length: 11 }, (_, i) => `f${i}.png`) },
      { queueFor: h.queueFor },
    );

    assert.equal(tooMany.ok, false);

    if (!tooMany.ok) {
      assert.equal(tooMany.code, "invalid_arguments");
    }

    const tooBig = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "hi", sessionId: "s-1", attachments: ["a".repeat(210 * 1024)] },
      { queueFor: h.queueFor },
    );

    assert.equal(tooBig.ok, false);

    if (!tooBig.ok) {
      assert.equal(tooBig.code, "invalid_arguments");
    }

    const page = await h.queueFor("s-1").list(0, 20);

    assert.equal(page.ok && page.value.total, 0);
    await h.queueFor("s-1").release();
  } finally {
    h.cleanup();
  }
});

test("brief attachments are echo-only: a missing file is still delivered, never read", async () => {
  const h = lab();
  try {
    const result = await executeBriefTool(
      { ...APPROVAL_BASE, approvalPort: grantingPort() },
      { message: "see this", sessionId: "s-1", attachments: ["does-not-exist-12345.png"] },
      { queueFor: h.queueFor },
    );

    assert.equal(result.ok, true);
    const page = await h.queueFor("s-1").list(0, 20);

    assert.equal(page.ok && page.value.total, 1);
    assert.match(page.ok ? page.value.items[0]?.text ?? "" : "", /does-not-exist-12345\.png/);
    await h.queueFor("s-1").release();
  } finally {
    h.cleanup();
  }
});

test("subscribe is remote_required even when approved — never faked", async () => {
  const h = lab();
  try {
    const granted = await executeSubscribeTool({ ...APPROVAL_BASE, approvalPort: grantingPort() });

    assert.equal(granted.ok, false);

    if (!granted.ok) {
      assert.equal(granted.code, "remote_required");
    }

    const missing = await executeSubscribeTool({ ...APPROVAL_BASE });

    assert.equal(missing.ok, false);
  } finally {
    h.cleanup();
  }
});
