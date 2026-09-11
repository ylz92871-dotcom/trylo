// Trylo Work — artifact canonicalization + unified store
// tests (M3 closure spec §9.2, fixing M3-P2-07 / M3-P1-05).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalAbsolutePath,
  relativeArtifactPath,
  artifactDisplayName,
} from "../src/artifact-paths.js";
import { WorkArtifactStore } from "../src/work-artifact-store.js";

describe("canonicalAbsolutePath (§9.2)", () => {
  it("unifies drive casing, separators and trailing slashes", () => {
    const forms = [
      "d:\\repo\\.trylo\\out\\a.md",
      "D:/repo/.trylo/out/a.md",
      "D:\\repo/.trylo/out/a.md/",
      "d:/repo//.trylo/./out/a.md",
    ];
    const canonical = canonicalAbsolutePath(forms[0]);
    assert.equal(canonical, "D:/repo/.trylo/out/a.md");
    for (const form of forms) {
      assert.equal(canonicalAbsolutePath(form), canonical, form);
    }
  });

  it("keeps POSIX absolute paths absolute", () => {
    assert.equal(canonicalAbsolutePath("/repo/out/a.md"), "/repo/out/a.md");
    assert.equal(canonicalAbsolutePath("/repo//out/./a.md"), "/repo/out/a.md");
  });

  it("rejects empty and whitespace input", () => {
    assert.equal(canonicalAbsolutePath(""), undefined);
    assert.equal(canonicalAbsolutePath("   "), undefined);
    assert.equal(canonicalAbsolutePath(undefined), undefined);
  });
});

describe("relativeArtifactPath (§9.2, M3-P2-07)", () => {
  it("computes the relative form inside the root", () => {
    assert.equal(
      relativeArtifactPath("D:/repo/.trylo/out/a.md", "D:/repo"),
      ".trylo/out/a.md",
    );
  });

  it("is case-insensitive on the Windows drive letter", () => {
    assert.equal(
      relativeArtifactPath("D:/REPO/out/a.md", "d:/repo"),
      "out/a.md",
    );
  });

  it("rejects sibling roots at the SEGMENT boundary", () => {
    // The pre-fix startsWith bug: 'D:/repo2/a.md' starts
    // with 'D:/repo' but is NOT inside it.
    assert.equal(relativeArtifactPath("D:/repo2/a.md", "D:/repo"), undefined);
  });

  it("rejects paths outside or equal to the root", () => {
    assert.equal(relativeArtifactPath("D:/repo", "D:/repo"), undefined);
    assert.equal(relativeArtifactPath("C:/x/a.md", "D:/repo"), undefined);
  });

  it("rejects malformed sides", () => {
    assert.equal(relativeArtifactPath("", "D:/repo"), undefined);
    assert.equal(relativeArtifactPath("D:/repo/a.md", ""), undefined);
  });
});

describe("artifactDisplayName", () => {
  it("returns the last canonical segment", () => {
    assert.equal(artifactDisplayName("d:\\repo\\out\\report.md"), "report.md");
    assert.equal(artifactDisplayName(""), "");
  });
});

describe("WorkArtifactStore (scoped, P2-1 §8)", () => {
  const PROJECT = "ws-P";
  const ROOT = "D:/repo";

  function scope(
    runId: string,
    conversationId = "c1",
    turnId = "t1",
    startedAt = 1000,
  ): import("../src/work-artifact-store.js").WorkArtifactScope {
    return {
      projectKey: PROJECT,
      projectRoot: ROOT,
      conversationId,
      taskId: "task-x",
      runId,
      turnId,
      startedAt,
    };
  }

  function scanned(
    rel: string,
    size = 10,
    modifiedMs = 1,
    hint?: string,
  ): import("../src/work-artifact-store.js").ScannedArtifact {
    return {
      target: { kind: "file", relativePath: rel },
      id: rel,
      displayName: rel.split("/").pop() ?? rel,
      artifactKind: (hint as import("../src/work-artifact-store.js").WorkArtifactKind) ?? "file",
      absolutePath: `${ROOT}/${rel}`,
      signature: { size, modifiedMs },
    };
  }

  function eventArtifact(rel: string, runId: string, kind = "document"): import("../src/work-artifact-store.js").WorkArtifactUpsert {
    return {
      rawPath: `${ROOT}/${rel}`,
      artifactKind: kind,
      at: 1000,
      runId,
      turnId: "t1",
    };
  }

  it("isolates the same path across different conversations", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1", "c1"), [scanned("a.md")]);
    store.finishRun(scope("r1", "c1"), { artifacts: [scanned("a.md")], truncated: false });
    store.beginRun(scope("r1", "c2"), [scanned("a.md")]);
    store.finishRun(scope("r1", "c2"), { artifacts: [scanned("a.md")], truncated: false });
    assert.equal(store.snapshot(PROJECT, "c1").artifacts.length, 1);
    assert.equal(store.snapshot(PROJECT, "c2").artifacts.length, 1);
    // clearProject must not touch the other project.
    const store2 = new WorkArtifactStore();
    store2.beginRun(scope("r1", "c1"), []);
    store2.upsertEvent(scope("r1", "c1"), eventArtifact("a.md", "r1"));
    store2.finishRun(scope("r1", "c1"), null);
    store2.clearProject("ws-OTHER");
    assert.ok(store2.snapshot(PROJECT, "c1").artifacts.length > 0);
    store2.clearProject(PROJECT);
    assert.equal(store2.snapshot(PROJECT, "c1").artifacts.length, 0);
  });

  it("event + scan in the same run merge into ONE record without a version bump", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    // event first, then the scan confirms the same file.
    assert.equal(store.upsertEvent(scope("r1"), eventArtifact("a.md", "r1")), true);
    const result = store.finishRun(scope("r1"), { artifacts: [scanned("a.md")], truncated: false });
    const record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    // sources order is fixed event → scan → recovery, and stays one record.
    assert.deepEqual(record.sources, ["event", "scan"]);
    assert.equal(record.version, 1);
    assert.equal(record.lastChange, "created");
  });

  it("repeating the SAME event within a run is idempotent (no duplicate source)", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    store.upsertEvent(scope("r1"), eventArtifact("a.md", "r1"));
    store.upsertEvent(scope("r1"), eventArtifact("a.md", "r1"));
    const result = store.finishRun(scope("r1"), null);
    assert.equal(result.artifacts.length, 1);
    const record = result.artifacts[0];
    assert.ok(record);
    assert.deepEqual(record.sources, ["event"]);
  });

  it("a follow-up that changes a file bumps the version to v2 (updated)", () => {
    const store = new WorkArtifactStore();
    // Run 1 creates a.md at size 10.
    store.beginRun(scope("r1"), []);
    store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 10, 1)], truncated: false });
    let record = store.snapshot(PROJECT, "c1").artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 1);

    // Run 2 (follow-up, new runId) baseline has size 10; terminal shows size 20.
    store.beginRun(scope("r2", "c1", "t2", 2000), [scanned("a.md", 10, 1)]);
    const result = store.finishRun(scope("r2", "c1", "t2", 2000), {
      artifacts: [scanned("a.md", 20, 2)],
      truncated: false,
    });
    record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 2);
    assert.equal(record.lastChange, "updated");
    assert.deepEqual(result.latestRun?.updatedIds, ["a.md"]);
  });

  it("a pre-existing file that stayed unchanged does NOT bump the version", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 10, 1)], truncated: false });
    let record = store.snapshot(PROJECT, "c1").artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 1);

    store.beginRun(scope("r2", "c1", "t2", 2000), [scanned("a.md", 10, 1)]);
    const result = store.finishRun(scope("r2", "c1", "t2", 2000), {
      artifacts: [scanned("a.md", 10, 1)],
      truncated: false,
    });
    record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 1);
    assert.equal(record.lastChange, "created"); // unchanged keeps prior change
    assert.equal(result.latestRun?.updatedIds.length, 0);
  });

  it("recovery with no baseline marks first-seen files as discovered, not created", () => {
    const store = new WorkArtifactStore();
    // No beginRun for r9 (recovery path) — terminal scan directly.
    const result = store.finishRun(scope("r9"), { artifacts: [scanned("a.md", 10, 1)], truncated: false });
    const record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.lastChange, "discovered");
    assert.deepEqual(record.sources, ["recovery"]);
    assert.deepEqual(result.latestRun?.discoveredIds, ["a.md"]);
  });

  it("recovery signature drift on a persisted record marks updated and bumps version", () => {
    const store = new WorkArtifactStore();
    // A persisted result from a previous session, hydrated.
    store.hydrate(`${PROJECT}::c1`, {
      latestRun: {
        runId: "r0", turnId: "t0", startedAt: 1, finishedAt: 2, status: "completed",
        createdIds: ["a.md"], updatedIds: [], discoveredIds: [],
      },
      artifacts: [{
        id: "a.md",
        target: { kind: "file", relativePath: "a.md" },
        displayName: "a.md",
        artifactKind: "file",
        version: 1,
        firstSeenAt: 1,
        updatedAt: 2,
        firstRunId: "r0",
        lastRunId: "r0",
        lastTurnId: "t0",
        lastChange: "created",
        sources: ["scan"],
        signature: { size: 10, modifiedMs: 1 },
      }],
      artifactCountTotal: 1,
      truncated: false,
    });
    const result = store.finishRun(scope("r9"), { artifacts: [scanned("a.md", 20, 2)], truncated: false });
    const record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 2);
    assert.equal(record.lastChange, "updated");
    assert.deepEqual(result.latestRun?.updatedIds, ["a.md"]);
  });

  it("keeps distinct files distinct and source order is stable", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    store.upsertEvent(scope("r1"), eventArtifact("a.md", "r1"));
    const result = store.finishRun(scope("r1"), {
      artifacts: [scanned("a.md"), scanned("b.txt")],
      truncated: false,
    });
    assert.equal(result.artifacts.length, 2);
    const a = result.artifacts.find((x) => x.id === "a.md");
    assert.ok(a);
    assert.deepEqual(a.sources, ["event", "scan"]);
  });

  it("does not collide URL and file keys", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    assert.equal(store.upsertEvent(scope("r1"), { rawPath: "https://x.test/a.md", at: 1, runId: "r1", turnId: "t1", artifactKind: "web" }), true);
    assert.equal(store.upsertEvent(scope("r1"), eventArtifact("a.md", "r1")), true);
    const result = store.finishRun(scope("r1"), { artifacts: [scanned("a.md")], truncated: false });
    assert.equal(result.artifacts.length, 2);
    const url = result.artifacts.find((x) => x.target.kind === "url");
    assert.ok(url);
    assert.equal(url.target.kind, "url");
    assert.equal(url.version, 1);
  });

  it("terminal scan failure (failRun) keeps event records and marks degraded", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    store.upsertEvent(scope("r1"), eventArtifact("a.md", "r1"));
    const result = store.failRun(scope("r1"), "scan failed");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.latestRun?.status, "degraded");
    assert.equal(result.latestRun?.warning, "scan failed");
  });

  it("finishRun is exactly-once per runId (no double version bump)", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 10, 1)], truncated: false });
    store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 20, 2)], truncated: false });
    const record = store.snapshot(PROJECT, "c1").artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 1);
  });

  it("rejects malformed / out-of-root event paths", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    assert.equal(store.upsertEvent(scope("r1"), { rawPath: "", at: 1, runId: "r1", turnId: "t1" }), false);
    assert.equal(store.upsertEvent(scope("r1"), { rawPath: "D:/other/a.md", at: 1, runId: "r1", turnId: "t1" }), false);
    assert.equal(store.snapshot(PROJECT, "c1").artifacts.length, 0);
  });
});

describe("WorkArtifactStore lifecycle state machine (C-Core, audit P2-2)", () => {
  const PROJECT = "ws-P";
  const ROOT = "D:/repo";

  function scope(
    runId: string,
    conversationId = "c1",
    turnId = "t1",
    startedAt = 1000,
  ): import("../src/work-artifact-store.js").WorkArtifactScope {
    return {
      projectKey: PROJECT,
      projectRoot: ROOT,
      conversationId,
      taskId: "task-x",
      runId,
      turnId,
      startedAt,
    };
  }

  function scanned(
    rel: string,
    size = 10,
    modifiedMs = 1,
  ): import("../src/work-artifact-store.js").ScannedArtifact {
    return {
      target: { kind: "file", relativePath: rel },
      id: rel,
      displayName: rel.split("/").pop() ?? rel,
      artifactKind: "file",
      absolutePath: `${ROOT}/${rel}`,
      signature: { size, modifiedMs },
    };
  }

  it("duplicate finishRun is a deterministic no-op (same snapshot, no churn)", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    const first = store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 10, 1)], truncated: false });
    // A second terminal with DIFFERENT scan content must not move anything.
    const second = store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 99, 9)], truncated: false });
    assert.deepEqual(second, first);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r1"), "finished");
  });

  it("finished is immutable: failRun after finishRun cannot degrade it", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    const finished = store.finishRun(scope("r1"), { artifacts: [scanned("a.md")], truncated: false });
    const after = store.failRun(scope("r1"), "late scan failure");
    assert.equal(after.latestRun?.status, "completed");
    assert.equal(after.latestRun?.warning, undefined);
    assert.deepEqual(after.artifacts, finished.artifacts);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r1"), "finished");
  });

  it("failRun is idempotent for a degraded run", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    const first = store.failRun(scope("r1"), "scan failed");
    const second = store.failRun(scope("r1"), "a different warning");
    assert.equal(second.latestRun?.status, "degraded");
    // The FIRST warning wins — repeated degradation is a no-op.
    assert.equal(second.latestRun?.warning, "scan failed");
    assert.deepEqual(second.artifacts, first.artifacts);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r1"), "degraded");
  });

  it("failed → finished is the ONE authoritative correction (baseline kept)", () => {
    const store = new WorkArtifactStore();
    // Baseline pins a.md@10; the terminal scan fails → degraded.
    store.beginRun(scope("r1"), [scanned("a.md", 10, 1)]);
    store.failRun(scope("r1"), "scan failed");
    assert.equal(store.runTerminalState(PROJECT, "c1", "r1"), "degraded");

    // The retry succeeds with real content a.md@20 → the correction must
    // compute the TRUE cross-run delta against the KEPT baseline.
    const corrected = store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 20, 2)], truncated: false });
    assert.equal(store.runTerminalState(PROJECT, "c1", "r1"), "finished");
    assert.equal(corrected.latestRun?.status, "completed");
    assert.equal(corrected.latestRun?.warning, undefined);
    assert.deepEqual(corrected.latestRun?.updatedIds, ["a.md"]);
    const record = corrected.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.version, 2);
    assert.equal(record.lastChange, "updated");

    // And the corrected run is now immutable like any finished run.
    const again = store.finishRun(scope("r1"), { artifacts: [scanned("a.md", 30, 3)], truncated: false });
    assert.deepEqual(again.artifacts, corrected.artifacts);
  });

  it("event-only artifact in recovery gets an honest `discovered` lastChange", () => {
    const store = new WorkArtifactStore();
    // No beginRun — recovery. The event reports a file the (missing)
    // terminal scan cannot corroborate.
    store.upsertEvent(scope("r9"), { rawPath: `${ROOT}/a.md`, at: 5, runId: "r9", turnId: "t9" });
    const result = store.finishRun(scope("r9"), null);
    assert.deepEqual(result.latestRun?.discoveredIds, ["a.md"]);
    const record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    // The record's change semantics MUST agree with the delta it is in:
    // discovered, never `created` without a scan.
    assert.equal(record.lastChange, "discovered");
  });

  it("event-only artifact WITH a baseline that proves absence stays created", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    store.upsertEvent(scope("r1"), { rawPath: `${ROOT}/a.md`, at: 5, runId: "r1", turnId: "t1" });
    // Terminal scan misses the event file, but the baseline proves it did
    // not exist at run start → honestly `created`.
    const result = store.finishRun(scope("r1"), { artifacts: [], truncated: false });
    assert.deepEqual(result.latestRun?.createdIds, ["a.md"]);
    const record = result.artifacts.find((a) => a.id === "a.md");
    assert.ok(record);
    assert.equal(record.lastChange, "created");
  });

  it("event-only artifact that existed at baseline claims NO change", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), [scanned("a.md", 10, 1)]);
    store.upsertEvent(scope("r1"), { rawPath: `${ROOT}/a.md`, at: 5, runId: "r1", turnId: "t1" });
    const result = store.finishRun(scope("r1"), { artifacts: [], truncated: false });
    // Pre-existing file, no scan evidence → no change claim at all.
    assert.equal(result.latestRun?.createdIds.length, 0);
    assert.equal(result.latestRun?.updatedIds.length, 0);
    assert.equal(result.latestRun?.discoveredIds.length, 0);
  });

  it("terminal-run bookkeeping is bounded per conversation (FIFO eviction)", () => {
    const store = new WorkArtifactStore();
    for (let i = 0; i < 70; i += 1) {
      store.beginRun(scope(`r${i}`, "c1", `t${i}`, 1000 + i), []);
      store.finishRun(scope(`r${i}`, "c1", `t${i}`, 1000 + i), { artifacts: [], truncated: false });
    }
    // Bounded to the documented cap; oldest evicted first.
    assert.equal(store.trackedTerminalRunCount(PROJECT, "c1"), 64);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r0"), undefined);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r5"), undefined);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r6"), "finished");
    assert.equal(store.runTerminalState(PROJECT, "c1", "r69"), "finished");
  });

  it("artifact records are bounded; eviction never loses the visible newest or the total", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1"), []);
    for (let i = 0; i < 210; i += 1) {
      store.upsertEvent(scope("r1"), { rawPath: `${ROOT}/e${i}.md`, at: 1000 + i, runId: "r1", turnId: "t1" });
    }
    const result = store.finishRun(scope("r1"), { artifacts: [], truncated: false });
    // The map is capped at the display bound...
    assert.equal(result.artifacts.length, 200);
    // ...the monotonic total still tells the truth...
    assert.equal(result.artifactCountTotal, 210);
    assert.equal(result.truncated, true);
    // ...and eviction took the OLDEST updatedAt, never a current one.
    const ids = new Set(result.artifacts.map((a) => a.id));
    for (let i = 0; i < 10; i += 1) assert.equal(ids.has(`e${i}.md`), false, `e${i}.md evicted`);
    for (let i = 10; i < 210; i += 1) assert.equal(ids.has(`e${i}.md`), true, `e${i}.md kept`);
  });

  it("hydrate restores the monotonic total without reviving evicted records", () => {
    const store = new WorkArtifactStore();
    store.hydrate(`${PROJECT}::c1`, {
      artifacts: [{
        id: "a.md",
        target: { kind: "file", relativePath: "a.md" },
        displayName: "a.md",
        artifactKind: "file",
        version: 1,
        firstSeenAt: 1,
        updatedAt: 2,
        firstRunId: "r0",
        lastRunId: "r0",
        lastTurnId: "t0",
        lastChange: "created",
        sources: ["scan"],
        signature: { size: 10, modifiedMs: 1 },
      }],
      artifactCountTotal: 250,
      truncated: true,
    });
    const snap = store.snapshot(PROJECT, "c1");
    assert.equal(snap.artifactCountTotal, 250);
    assert.equal(snap.truncated, true);
    assert.equal(snap.artifacts.length, 1);
  });

  it("clearConversation drops one conversation and leaves siblings intact", () => {
    const store = new WorkArtifactStore();
    store.beginRun(scope("r1", "c1"), []);
    store.finishRun(scope("r1", "c1"), { artifacts: [scanned("a.md")], truncated: false });
    store.beginRun(scope("r1", "c2"), []);
    store.finishRun(scope("r1", "c2"), { artifacts: [scanned("a.md")], truncated: false });

    store.clearConversation(PROJECT, "c1");
    assert.equal(store.snapshot(PROJECT, "c1").artifacts.length, 0);
    assert.equal(store.runTerminalState(PROJECT, "c1", "r1"), undefined);
    assert.equal(store.trackedTerminalRunCount(PROJECT, "c1"), 0);
    // Sibling conversation untouched.
    assert.equal(store.snapshot(PROJECT, "c2").artifacts.length, 1);
    assert.equal(store.runTerminalState(PROJECT, "c2", "r1"), "finished");
  });
});
