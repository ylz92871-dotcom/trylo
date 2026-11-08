import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFileSync } from "node:fs";
import { command, userRuleDraft } from "../../learning/control/fixtures.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { createBoardReader, createFileBoardStore, withBoardWriter } from "./file-event-store.js";
import { encodeRecord } from "./codec.js";
import { sha256Hex } from "../../learning/control/hash.js";

test("append-only apply survives process reload", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });
    const applied = await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));

    assert.equal(applied.ok, true);
    await store.close();
    const reopened = openStore(dir);
    const loaded = await reopened.load();

    assert.equal(loaded.ok, true);

    if (loaded.ok) {
      assert.equal(loaded.state.proposals[0]?.proposalId, "p1");
    }

    await reopened.close();
  });
});

test("torn tail record is discarded", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    appendFileSync(path.join(dir, "board-events.ndjson"), "abc incomplete", "utf8");
    const loaded = await store.load();

    assert.equal(loaded.ok, true);

    if (loaded.ok) {
      assert.equal(loaded.state.proposals.length, 1);
    }
  });
});

test("checksum mismatch fail closed", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    appendFileSync(
      path.join(dir, "board-events.ndjson"),
      "deadbeef {\"sequence\":2,\"commandId\":\"c2\"}\n",
      "utf8",
    );
    const loaded = await store.load();

    assert.equal(loaded.ok, false);

    if (!loaded.ok) {
      assert.equal(loaded.reason, "checksum_mismatch");
    }
  });
});

test("sequence gap fail closed", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });
    const applied = await store.apply(
      command("submit_proposal", { proposal: draft, commandId: "c1" }),
    );

    assert.equal(applied.ok, true);

    if (!applied.ok) {
      return;
    }

    const rogue = encodeRecord({
      sequence: 9,
      commandId: "c9",
      command: command("quarantine", { proposalId: "p1", commandId: "c9" }),
      events: [],
    });

    appendFileSync(path.join(dir, "board-events.ndjson"), rogue, "utf8");
    const loaded = await store.load();

    assert.equal(loaded.ok, false);

    if (!loaded.ok) {
      assert.equal(loaded.reason, "sequence_gap");
    }
  });
});

test("second writer fail closed", async () => {
  await withStore(async (dir) => {
    const second = createFileBoardStore(dir);
    assert.equal("ok" in second && second.ok === false, true);
    if ("ok" in second && second.ok === false) {
      assert.equal(second.reason, "multi_writer");
    }
  });
});

test("duplicate command after reload is idempotent", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });
    const submit = command("submit_proposal", { proposal: draft, commandId: "c1" });

    await store.apply(submit);
    await store.close();
    const reopened = openStore(dir);
    const again = await reopened.apply(submit);

    assert.equal(again.ok, true);

    if (again.ok) {
      assert.equal(again.idempotent, true);
      assert.equal(again.state.proposals.length, 1);
    }

    await reopened.close();
  });
});

test("snapshot lag replays newer events", async () => {
  await withStore(async (_dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    const snapped = await store.snapshot(0);

    assert.equal(snapped.ok, true);
    await store.apply(command("fast_lane_validate", { proposalId: "p1", commandId: "c2" }));
    const loaded = await store.load();

    assert.equal(loaded.ok, true);

    if (loaded.ok) {
      assert.equal(loaded.state.proposals[0]?.lifecycle, "validated");
      assert.equal(loaded.state.sequence > 1, true);
    }
  });
});

test("compaction does not change replay result", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    await store.apply(command("fast_lane_validate", { proposalId: "p1", commandId: "c2" }));
    const before = await store.load();

    assert.equal(before.ok, true);

    if (!before.ok) {
      return;
    }

    const compacted = await store.compact(0);

    assert.equal(compacted.ok, true);
    await store.apply(
      command("commit_asset", {
        proposalId: "p1",
        versionId: "v1",
        content: { text: "rule" },
        schemaVersion: 1,
        commandId: "c3",
      }),
    );
    const after = await store.load();

    assert.equal(after.ok, true);

    if (after.ok && before.ok) {
      assert.equal(after.state.proposals[0]?.lifecycle, "validated");
      assert.equal(after.state.assets[0]?.versionId, "v1");
      assert.equal(after.state.sequence > before.state.sequence, true);
    }

    const log = await readFile(path.join(dir, "board-events.ndjson"), "utf8");

    assert.equal(log.includes("\"commandId\":\"c1\""), false);
  });
});

test("snapshot state equals replay of the same commands", async () => {
  await withStore(async (_dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    await store.apply(command("fast_lane_validate", { proposalId: "p1", commandId: "c2" }));
    const before = await store.load();

    assert.equal(before.ok, true);
    const snapped = await store.snapshot(0);

    assert.equal(snapped.ok, true);
    const after = await store.load();

    assert.equal(after.ok, true);

    if (before.ok && after.ok) {
      assert.equal(before.state.sequence, after.state.sequence);
      assert.equal(before.state.proposals[0]?.lifecycle, after.state.proposals[0]?.lifecycle);
      assert.equal(before.state.appliedCommands.length, after.state.appliedCommands.length);
    }
  });
});

test("activate suspend rollback survive reload", async () => {
  await withStore(async (dir, store) => {
    const first = userRuleDraft({ proposalId: "p1" });
    const second = userRuleDraft({ proposalId: "p2" });
    const steps = [
      command("submit_proposal", { proposal: first, commandId: "c1" }),
      command("fast_lane_validate", { proposalId: "p1", commandId: "c2" }),
      command("commit_asset", {
        proposalId: "p1",
        versionId: "v1",
        content: { text: "one" },
        schemaVersion: 1,
        commandId: "c3",
      }),
      command("activate", { proposalId: "p1", versionId: "v1", commandId: "c4" }),
      command("suspend", { proposalId: "p1", breakerReason: "swap", commandId: "c5" }),
      command("submit_proposal", { proposal: second, commandId: "c6" }),
      command("fast_lane_validate", { proposalId: "p2", commandId: "c7" }),
      command("commit_asset", {
        proposalId: "p2",
        versionId: "v2",
        content: { text: "two" },
        schemaVersion: 1,
        commandId: "c8",
      }),
      command("activate", { proposalId: "p2", versionId: "v2", commandId: "c9" }),
      command("suspend", { proposalId: "p2", breakerReason: "neg", commandId: "c10" }),
      command("rollback", { proposalId: "p2", reason: "restore", commandId: "c11" }),
    ];

    for (const step of steps) {
      const applied = await store.apply(step);
      assert.equal(applied.ok, true, step.commandId);
    }

    await store.close();
    const reopened = openStore(dir);
    const loaded = await reopened.load();

    assert.equal(loaded.ok, true);

    if (loaded.ok) {
      assert.equal(loaded.state.activations[0]?.versionId, "v1");
      assert.equal(loaded.state.activations[0]?.pointer, "active");
      assert.equal(
        loaded.state.proposals.find((item) => item.proposalId === "p2")?.lifecycle,
        "rolled_back",
      );
    }

    await reopened.close();
  });
});

test("corrupt snapshot is ignored in favor of the event log", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    await writeFile(
      path.join(dir, "board-snapshot.json"),
      JSON.stringify({
        generation: 1,
        sequence: 99,
        checksum: "nope",
        state: { sequence: 99, appliedCommands: [], proposals: [] },
      }),
      "utf8",
    );
    const loaded = await store.load();

    assert.equal(loaded.ok, true);

    if (loaded.ok) {
      assert.equal(loaded.state.proposals[0]?.proposalId, "p1");
      assert.notEqual(loaded.state.sequence, 99);
    }
  });
});

async function withStore(
  run: (dir: string, store: BoardStore) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-board-"));
  const store = openStore(dir);

  try {
    await run(dir, store);
  } finally {
    try {
      await store.close();
    } catch (err) {
      if (!isClosedFd(err)) {
        throw err;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function openStore(dir: string): BoardStore {
  const store = createFileBoardStore(dir);
  if ("apply" in store) {
    return store;
  }
  throw new Error(store.reason);
}

function isClosedFd(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    ((err as { code: unknown }).code === "EBADF" ||
      (err as { code: unknown }).code === "ENOENT")
  );
}

test("an unparseable record with a valid checksum fails closed", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    // Only a writer bug or a tamper that recomputed the checksum can produce
    // this line: the bytes match their checksum, but they are not JSON. The
    // read boundary must fail closed, never leak a raw SyntaxError upward.
    const payload = "not json at all";

    appendFileSync(path.join(dir, "board-events.ndjson"), `${sha256Hex(payload)} ${payload}\n`, "utf8");
    const loaded = await store.load();

    assert.equal(loaded.ok, false);

    if (!loaded.ok) {
      assert.equal(loaded.reason, "snapshot_corrupt");
    }
  });
});

test("a foreign-shaped record with a valid checksum fails closed", async () => {
  await withStore(async (dir, store) => {
    const draft = userRuleDraft({ proposalId: "p1" });

    await store.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    // Checksum valid, sequence right, but no `command` and no `events`: the
    // shape no writer of this format produces. Guarding the structure is the
    // read boundary's job; the board reducer keeps the command semantics.
    const payload = JSON.stringify({ sequence: 2, commandId: "c2" });

    appendFileSync(path.join(dir, "board-events.ndjson"), `${sha256Hex(payload)} ${payload}\n`, "utf8");
    const loaded = await store.load();

    assert.equal(loaded.ok, false);

    if (!loaded.ok) {
      assert.equal(loaded.reason, "snapshot_corrupt");
    }
  });
});

/**
 * P1-4: every IO phase at the adapter boundary is collected into a typed result,
 * never thrown into the caller's task. Each case below is triggered by a REAL
 * filesystem fault (no injected seam), and each names the phase it proves and the
 * write-outcome class the boundary must report:
 *
 *  - create/lock → `board_unavailable` (definitely-not-written: it failed before a
 *    single command was applied);
 *  - read        → `board_unavailable` (the authoritative log could not be read, so
 *    nothing is fabricated — fail closed);
 *  - run body    → `board_unavailable` (unknown: earlier commands in the sequence may
 *    already be on the log, so the adapter reports the fault and releases the lock
 *    without blind retry — deciding to retry is the caller's).
 *
 * The partially-written class (`archive_write_failed`, raised when an append throws
 * mid-sequence) is proven separately by the P2-3 append-seam cases in
 * `integration/method/board-writer.test.ts`.
 */

test("P1-4: a board root that cannot be created is a typed board_unavailable, not a throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-board-p14create-"));
  try {
    // A real create/lock-phase fault: the board root is an ordinary file, so
    // `mkdirSync(rootDir, {recursive:true})` throws (EEXIST on Windows, EEXIST/ENOTDIR
    // on POSIX). Before P1-4 this escaped `createFileBoardStore` → `withBoardWriter` →
    // the write port → the loop and failed the user's task.
    const fileRoot = path.join(dir, "board-is-a-file");

    await writeFile(fileRoot, "not a directory", "utf8");
    const store = createFileBoardStore(fileRoot);

    assert.equal("ok" in store && store.ok === false, true, "create must fail closed, not throw");

    if ("ok" in store && store.ok === false) {
      assert.equal(store.reason, "board_unavailable");
      assert.equal(typeof store.detail, "string");
      assert.equal(store.detail.length > 0, true, "the detail carries the IO diagnosis");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1-4: a log path that is a directory degrades to board_unavailable on read, not a throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-board-p14read-"));
  try {
    // A real read-phase fault: the authoritative log is a directory, so `readFile`
    // throws EISDIR (not ENOENT, which would legitimately mean "empty archive").
    // `load` must collect it into a typed `board_unavailable` and fail closed rather
    // than leaking a raw filesystem error upward.
    await mkdir(path.join(dir, "board-events.ndjson"), { recursive: true });
    const loaded = await createBoardReader(dir).load();

    assert.equal(loaded.ok, false);

    if (!loaded.ok) {
      assert.equal(loaded.reason, "board_unavailable");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1-4: a throw out of the writer run is collected as board_unavailable and the lock is released", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-board-p14run-"));
  try {
    // The outcome is UNKNOWN when the run body throws mid-sequence: earlier commands
    // may already be appended. `withBoardWriter` must surface a typed failure rather
    // than propagate, must NOT blind-retry, and must still release the lock so the
    // next writer is not wedged.
    const result = await withBoardWriter(dir, async () => {
      throw new Error("run body blew up");
    });

    assert.equal("ok" in result && result.ok === false, true, "a run-body throw must not propagate");

    if ("ok" in result && result.ok === false) {
      assert.equal(result.reason, "board_unavailable");
      assert.equal(result.detail, "run body blew up");
    }

    // The lock was released best-effort in `finally`: a fresh writer can take it.
    const reopened = createFileBoardStore(dir);

    assert.equal("apply" in reopened, true, "the lock must be released after a run-body throw");

    if ("apply" in reopened) {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
