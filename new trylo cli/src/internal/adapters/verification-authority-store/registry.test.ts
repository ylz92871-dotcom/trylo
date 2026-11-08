import assert from "node:assert/strict";
import test from "node:test";
import { decodeRegistry, registryKeySets } from "./index.js";
import {
  EXPECTED,
  createRegistry,
  issuePass,
  openRegistryFileHarness,
  readRaw,
  type RegistryHarness,
} from "./registry-harness.js";

/**
 * durable receipt registry 的**持久性与语义**证据（WP-F §7 D2 退出门）：
 * 重启可查、未知收据不臆造 verdict、撤销闭合晋升、只存声明过的键。
 *
 * 损坏 / torn tail / 序列断裂 / 未知键 / 未知版本 / 锁冲突这类**故障**证据在
 * `registry-corruption.test.ts`——拆分理由见 `registry-harness.ts` 顶部注释
 * （外审 R3 §3 P3-3 的单文件长度纪律）。
 */

test("a receipt survives a brand new registry instance on the same file", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);
    const reopened = createRegistry(harness.file);
    const verified = await reopened.verify({ receiptId }, EXPECTED);

    assert.equal(verified.ok, true);

    if (verified.ok) {
      assert.equal(verified.receipt.receiptId, receiptId);
      assert.equal(verified.receipt.verdict, "pass");
      assert.equal(verified.receipt.sequence, 1);
    }
  } finally {
    await harness.close();
  }
});

test("an unknown receipt is refused and never fabricates a verdict", async () => {
  const harness: RegistryHarness = await openRegistryFileHarness();
  try {
    await issuePass(harness);
    const verified = await harness.registry.verify({ receiptId: "receipt:ghost" }, EXPECTED);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.equal(verified.code, "unknown_receipt");
    }
  } finally {
    await harness.close();
  }
});

test("revoking a receipt closes promotion, and revoke reports its own failures", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);
    const revoked = await harness.registry.revoke(receiptId, "2026-09-13T01:00:00.000Z", "audit");

    assert.equal(revoked.ok, true);

    const after = await harness.registry.verify({ receiptId }, EXPECTED);

    assert.equal(after.ok, false);

    if (!after.ok) {
      assert.equal(after.code, "receipt_revoked");
    }

    const again = await harness.registry.revoke(receiptId, "2026-09-13T01:00:00.000Z", "audit");

    assert.equal(again.ok, false);

    if (!again.ok) {
      assert.equal(again.code, "receipt_revoked");
    }

    const ghost = await harness.registry.revoke("receipt:ghost", "2026-09-13T01:00:00.000Z", "audit");

    assert.equal(ghost.ok, false);

    if (!ghost.ok) {
      assert.equal(ghost.code, "unknown_receipt");
    }
  } finally {
    await harness.close();
  }
});

test("the registry stores only the declared keys, never raw content", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const issued = await harness.registry.issue({
      domain: "user_explicit",
      subject: {
        subjectKind: "content_candidate",
        subjectId: "prop-1",
        subjectVersion: "cand-1",
        scope: "ts-unit-fix",
      },
      verifierId: "execution-evidence-recorder",
      generatorId: "learning-user-pipeline",
      issuedAt: "2026-09-13T00:00:00.000Z",
      sourceFactRef: "user_explicit:please-fix-ts-1234",
    });

    assert.equal(issued.ok, true);

    const decoded = decodeRegistry(await readRaw(harness));

    assert.equal(decoded.ok, true);

    if (!decoded.ok) {
      return;
    }

    assert.equal(decoded.events.length, 1);
    const [event] = decoded.events;

    assert.notEqual(event, undefined);

    if (event === undefined) {
      return;
    }

    assert.deepEqual(Object.keys(event).sort(), [...registryKeySets().issued].sort());
    // 只存摘要/引用，不存原始正文：用户的原始输入不进入 registry。
    assert.equal(JSON.stringify(event).includes("please-fix-ts-1234"), false);
  } finally {
    await harness.close();
  }
});
