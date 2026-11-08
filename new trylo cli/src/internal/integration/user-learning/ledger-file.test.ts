import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileLedgerPort, USER_LEDGER_FILE } from "./ledger-file.js";
import { matchesTask } from "../../learning/domains/user/prepare.js";
import type { UserLearningRecord } from "../../learning/domains/user/scheduler-ports.js";

/**
 * E0 回归：损坏拒绝 + 跨 scope 不串用。
 *
 * 按纪律先红后绿：本文件在未修复码上必须红（坏 receipt/坏枚举直通），
 * 随 `ledger-file.ts` 完整解码变绿。
 */

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "trylo-user-ledger-e0-"));
}

function cleanup(d: string): void {
  rmSync(d, { recursive: true, force: true });
}

function writeLines(d: string, lines: readonly string[]): void {
  writeFileSync(path.join(d, USER_LEDGER_FILE), lines.join(""), "utf8");
}

const EVIDENCE: UserLearningRecord = {
  record: "evidence",
  evidence: {
    id: "e1",
    rawText: "以后周报先说结论",
    claim: "周报先说结论",
    eventKind: "explicit_statement",
    durability: "long_term_candidate",
    signalKind: "collaboration_preference",
    answers: {
      semantic: 1,
      relevance: 1,
      contextInformedness: "pre_task",
      governance: 3,
      scopeNarrowness: "narrow",
    },
    source: { sessionId: "s1" },
    sourceHash: "h1",
    textHash: "t1",
    createdAt: 1_700_000_000_000,
  },
};

const SIGNAL: UserLearningRecord = {
  record: "signal",
  signal: "correction",
  eventId: "evt-1",
  at: 1_700_000_000_000,
};

const POLICY: UserLearningRecord = {
  record: "policy",
  adopted: true,
  ruleIds: ["r1"],
  matched: 1,
  chars: 10,
  scopeFingerprint: "fp-a",
  bundleChecksum: "cs1",
  at: 1_700_000_000_000,
};

const RECEIPT: UserLearningRecord = {
  record: "receipt",
  receipt: {
    id: "rc1",
    commitmentId: "c1",
    commitmentVersion: 1,
    dedupeKey: "c1::1::created",
    reason: "created",
    scopeLabel: "ws",
    effectSummary: "x",
    revokeActions: ["pause"],
    message: "m",
    createdAt: 1_700_000_000_000,
  },
};

const OBSERVATION: UserLearningRecord = {
  record: "observation",
  observation: {
    id: "o1",
    commitmentId: "c1",
    signal: "explicit_helpful",
    attribution: "direct",
    createdAt: 1_700_000_000_000,
  },
};

test("E0: bare receipt shell is rejected as unreadable", () => {
  const d = dir();
  try {
    writeLines(d, [`{"record":"receipt"}\n`]);
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 0);
      assert.equal(read.unreadable, 1);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: receipt with unknown reason is rejected", () => {
  const d = dir();
  try {
    const bad = JSON.stringify({
      record: "receipt",
      receipt: { ...(RECEIPT as { receipt: Record<string, unknown> }).receipt, reason: "super_helpful" },
    });

    writeLines(d, [`${bad}\n`]);
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 0);
      assert.equal(read.unreadable, 1);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: observation with unknown signal is rejected", () => {
  const d = dir();
  try {
    const bad = JSON.stringify({
      record: "observation",
      observation: {
        ...(OBSERVATION as { observation: Record<string, unknown> }).observation,
        signal: "vibes_good",
      },
    });

    writeLines(d, [`${bad}\n`]);
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 0);
      assert.equal(read.unreadable, 1);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: policy missing scopeFingerprint is rejected", () => {
  const d = dir();
  try {
    const { scopeFingerprint: _drop, ...rest } = POLICY as unknown as Record<string, unknown>;

    void _drop;
    writeLines(d, [`${JSON.stringify({ ...rest, record: "policy" })}\n`]);
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 0);
      assert.equal(read.unreadable, 1);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: signal with unknown kind is rejected", () => {
  const d = dir();
  try {
    writeLines(d, [`${JSON.stringify({ record: "signal", signal: "telepathy", eventId: "e", at: 1 })}\n`]);
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 0);
      assert.equal(read.unreadable, 1);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: evidence missing source identity is rejected", () => {
  const d = dir();
  try {
    const bad = JSON.stringify({
      record: "evidence",
      evidence: { id: "e9", rawText: "x", textHash: "t" },
    });

    writeLines(d, [`${bad}\n`]);
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 0);
      assert.equal(read.unreadable, 1);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: valid records of every kind are accepted", () => {
  const d = dir();
  try {
    writeLines(d, [EVIDENCE, SIGNAL, POLICY, RECEIPT, OBSERVATION].map((r) => `${JSON.stringify(r)}\n`));
    const read = createFileLedgerPort(d).read();

    assert.equal(read.ok, true);

    if (read.ok) {
      assert.equal(read.records.length, 5);
      assert.equal(read.unreadable, 0);
    }
  } finally {
    cleanup(d);
  }
});

test("E0: rule from another scope fingerprint does not match", () => {
  const rule = {
    id: "r1",
    bundleId: "b1",
    domain: "reporting_information_density" as const,
    kind: "prompt_directive" as const,
    strength: "strong_default" as const,
    originMark: "explicit" as const,
    instruction: "先说结论",
    sourceUserModelIds: ["m1"],
    sourceConclusionIds: ["k1"],
    sourceEvidenceIds: ["e1"],
    sourceCommitmentIds: ["c1"],
    status: "active" as const,
    version: 1,
    createdAt: 1_700_000_000_000,
  };
  const models = [
    {
      id: "m1",
      userId: "local-user",
      statement: "周报先说结论",
      dimension: "reporting_information_density" as const,
      scopeFingerprint: "fp-a",
      truth: { score: 1, band: "high" as const },
      scope: { score: 1, band: "high" as const },
      effectiveness: "unknown" as const,
      confirmation: "user_confirmed" as const,
      distance: "D0" as const,
      alternativeExplanations: [],
      derivedFromConclusionIds: ["k1"],
      counterevidence: [],
      status: "active" as const,
      version: 1,
      stableKey: "k",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  ];

  assert.equal(matchesTask(rule, "帮我写这周的周报，先说结论", "fp-a", models), true);
  assert.equal(matchesTask(rule, "帮我写这周的周报，先说结论", "fp-b", models), false);
});
