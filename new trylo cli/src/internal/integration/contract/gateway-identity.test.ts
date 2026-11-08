import assert from "node:assert/strict";
import test from "node:test";
import { openRegistryHarness, type RegistryHarness } from "../testing/authority-fixtures.js";
import { validationRecord } from "../testing/fixtures.js";

/**
 * 身份独立性专项证据（外审 R3 §3 P2-1）。
 *
 * 从 `gateway.test.ts` 拆出的理由（外审 R3 §3 P3-3 的单文件长度纪律）：身份归一化
 * 既是**已关闭**的缺口（NFC + trim），也是**已登记**的残留（大小写 / 同形字），
 * 两条方向相反的断言放在一起才不会被误读成「别名已全部拒绝」。把它们独立成一屏，
 * 是为了让 P2-1 的结论只有一个读法。
 */

const AT = "2026-09-13T00:00:00.000Z";
const VERSION_ID = "pkg:pdf-lint:1.0.0";

async function withHarness(run: (harness: RegistryHarness) => Promise<void>): Promise<void> {
  const harness = await openRegistryHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

/** 以给定 verifier / generator 组合签发一条 agent_method 收据。 */
function issueWithIdentities(harness: RegistryHarness, verifierId: string, generatorId: string) {
  return harness.registry.issue({
    domain: "agent_method",
    subject: {
      subjectKind: "tool_package_version",
      subjectId: VERSION_ID,
      subjectVersion: VERSION_ID,
      scope: "docs",
    },
    verifierId,
    generatorId,
    issuedAt: AT,
    validationRecord: validationRecord(),
  });
}

test("generator and verifier cannot be the same identity, and a whitespace alias does not help", async () => {
  await withHarness(async (harness) => {
    const sameIdentity = await issueWithIdentities(harness, "one-agent", "one-agent");

    assert.equal(sameIdentity.ok, false);

    if (!sameIdentity.ok) {
      assert.equal(sameIdentity.code, "generator_is_verifier");
    }

    // 别名（尾随空白 / NFC 未合成序列）**不能**把同一身份写成两个身份：
    // 外审 R3 §3 P2-1 的反例是这条收据曾经签发成功并晋升成功。
    const alias = await issueWithIdentities(harness, "one-agent ", "one-agent");

    assert.equal(alias.ok, false, "a trailing-space alias is the same identity");

    if (!alias.ok) {
      assert.equal(alias.code, "generator_is_verifier");
    }
  });
});

test("identity independence is NFC+trim only: case and homoglyph aliases are still accepted", async () => {
  await withHarness(async (harness) => {
    // 这是一条**登记已知残留**的用例，不是宣称安全：本包只关闭「同一身份的书写差异」
    // 这一类别名。大小写（`One-Agent`）与 Unicode 同形字（西里尔 `а`）仍被当作
    // 两个不同身份，关闭它们需要额外的身份目录/治理，属本包范围之外。
    // 该残留登记在 `HANDOFF-MANIFEST.md` §OPEN 的 P2-1 行。**不得**把它改写成
    // 「别名已全部拒绝」——那正是外审 R3 §3 P2-1 指出的过度声明。
    const caseAlias = await issueWithIdentities(harness, "One-Agent", "one-agent");

    assert.equal(caseAlias.ok, true, "case folding is a documented residual, not a closed gap");

    const homoglyphAlias = await issueWithIdentities(harness, "one-\u0430gent", "one-agent");

    assert.equal(homoglyphAlias.ok, true, "homoglyphs are a documented residual, not a closed gap");
  });
});
