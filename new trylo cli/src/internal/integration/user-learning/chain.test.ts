import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCeilingBudgetPort,
  createFlagCollectionPort,
  createLocalWorkOrderPort,
  type UserLearningPorts,
} from "../../learning/domains/user/scheduler-ports.js";
import { deriveUserPolicy, evidenceInScope } from "./chain.js";
import { createFileLedgerPort } from "./ledger-file.js";
import { createUserLearningRuntime, type UserLearningRuntime } from "./runtime.js";

/**
 * P1-1 跨工作区隔离的**整机**证据。
 *
 * 外部复核发现的泄漏向量是具体的：用户账本是**单一物理文件**、不按 workspace 分键，
 * 而旧的 `deriveUserPolicy` 把读到的**全部**证据用当前运行时的 `userId+workspaceId`
 * 重新盖戳合成——于是工作区 A 写的偏好会被建模成工作区 B 的模型与规则。
 *
 * 所以这里刻意用**真的** `createFileLedgerPort`（临时目录里的真文件），让 A 与 B 共享
 * 同一份物理账本：只有跑通这条真实路径，才能证明「来源戳写在证据身上 + 读出来按戳过滤」
 * 真的堵住了串用，而不是又在内存里造了一个不会泄漏的替身。
 */

const PREF = "以后周报都先说结论，再展开依据";
const CEILING = 1200;
const NOW = 1_700_000_000_000;

function runtimeFor(
  ports: UserLearningPorts,
  workspaceId: string,
): UserLearningRuntime {
  return createUserLearningRuntime({
    policyMode: "legacy",
    ports,
    userId: "local-user",
    workspaceId,
    now: () => NOW,
    warn: () => undefined,
  });
}

function journalEvent(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  ids: { readonly sessionId: string; readonly turnId: string; readonly eventId: string },
): Parameters<UserLearningRuntime["capture"]>[0] {
  return { kind, eventId: ids.eventId, sessionId: ids.sessionId, turnId: ids.turnId, payload };
}

test("P1-1: workspace A's preference in a shared ledger never becomes workspace B's model", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-user-scope-"));
  try {
    // ONE physical ledger file shared by both workspaces — the exact leakage vector.
    const ledger = createFileLedgerPort(dir);
    const ports: UserLearningPorts = {
      collection: createFlagCollectionPort(true),
      budget: createCeilingBudgetPort(CEILING),
      workOrder: createLocalWorkOrderPort(true, CEILING),
      ledger,
    };

    // Workspace A states a collaboration preference; it lands as evidence stamped ws-A.
    const a = runtimeFor(ports, "ws-A");

    a.capture(journalEvent("turn_start", { turnId: "t-a", text: PREF }, { sessionId: "s-a", turnId: "t-a", eventId: "e-a" }));
    a.capture(journalEvent("terminal", { reason: "completed" }, { sessionId: "s-a", turnId: "t-a", eventId: "e-a2" }));
    a.finishTurn();

    const read = ledger.read();

    assert.equal(read.ok, true);
    const records = read.ok ? read.records : [];
    const evidence = records.filter((item) => item.record === "evidence");

    assert.equal(evidence.length, 1, "A's preference is in the shared physical ledger");

    if (evidence[0]?.record === "evidence") {
      assert.equal(evidence[0].evidence.source.workspaceId, "ws-A", "stamped with the workspace it was born in");
    }

    // A derives from the same ledger: the preference is in scope, so the deep chain grows
    // a model and a rule. This proves the scope filter is not a blanket drop.
    const policyA = deriveUserPolicy({ records, userId: "local-user", workspaceId: "ws-A", now: NOW });

    assert.equal(policyA.evidence.length, 1);
    assert.equal(policyA.models.length > 0, true, "A sees its own preference");
    assert.equal(policyA.rules.length > 0, true, "A compiles a rule from it");

    // B reads the SAME physical ledger. A's evidence carries source ws-A, so it is
    // isolated: B derives no evidence, no model, no rule — and would inject nothing.
    const policyB = deriveUserPolicy({ records, userId: "local-user", workspaceId: "ws-B", now: NOW });

    assert.equal(policyB.evidence.length, 0, "B must not adopt A's evidence");
    assert.equal(policyB.models.length, 0, "no B model is built from A's preference");
    assert.equal(policyB.rules.length, 0, "no B rule is compiled from A's preference");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1-1: legacy evidence with an unknown source stays isolated, never promoted to the current scope", () => {
  // A pre-M1 evidence record carries no workspaceId. Unknown source must NOT be treated
  // as "belongs to whichever workspace is reading now" — that is the silent promotion the
  // fix forbids. It is excluded for every workspace, including the one that happens to run.
  const legacy = {
    record: "evidence" as const,
    evidence: {
      id: "ev-legacy",
      rawText: PREF,
      claim: "先给结论",
      eventKind: "explicit_statement" as const,
      durability: "long_term_candidate" as const,
      signalKind: "collaboration_preference" as const,
      answers: { semantic: null, relevance: null, contextInformedness: null, governance: null, scopeNarrowness: null },
      source: { sessionId: "s-old", turnId: "t-old" },
      sourceHash: "h",
      textHash: "h",
      createdAt: NOW,
    },
  };

  assert.deepEqual(evidenceInScope([legacy.evidence], "ws-A"), [], "unknown source is isolated, not adopted");
  assert.deepEqual(evidenceInScope([legacy.evidence], "ws-B"), []);
});
