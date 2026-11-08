import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileVerificationRegistry } from "../../adapters/verification-authority-store/index.js";
import {
  fixedClock,
  issueAgentMethodReceipt,
  issueUserExplicitReceipt,
  openRegistryHarness,
  sequentialReceiptIds,
  type RegistryHarness,
} from "../testing/authority-fixtures.js";
import { evidenceAdmission, evidenceDraft, toolEvidenceAdmission, validationRecord } from "../testing/fixtures.js";
import { admitContentEvidence, admitToolEvidence } from "./gateway.js";

/**
 * 可信准入 gateway 的对抗测试（WP-F §7 D3 / §7 D5）。
 *
 * 威胁模型与外审 R2 一致：adapter 的调用方（同层代码）不可信，可自由构造
 * draft、admission 与入参。
 *
 * 结论的口径：这一层的测试证明「调用方自报字段完全失去独立证据权力」，
 * 而不是「不可能伪造任何东西」——伪造一张 registry 文件仍需写入权威目录，
 * 那由 `verification-authority-store` 的测试与架构扫描覆盖。
 *
 * 拆分（外审 R3 §3 P3-3 的单文件长度纪律）：身份独立性在 `gateway-identity.test.ts`，
 * 端到端晋升在 `gateway-promotion.test.ts`；本文件只留**准入形状与绑定**这一类证据。
 * 这三份都用同一套真实持久 registry 夹具（`../testing/authority-fixtures.js`）。
 */

const AT = "2026-09-13T00:00:00.000Z";
const VERSION_ID = "pkg:pdf-lint:1.0.0";

const evidenceDraftShape = { kind: "submit_evidence", evidenceId: "ev-tool-1", summary: "十段验证通过" } as const;

async function withHarness(run: (harness: RegistryHarness) => Promise<void>): Promise<void> {
  const harness = await openRegistryHarness();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

test("R1: a fully self-consistent forged record has no power without a registry receipt", async () => {
  await withHarness(async (harness) => {
    // 攻击者复制输出合同造一张结构自洽的记录——这正是外审 R2 §3.1 的反例。
    const forged = validationRecord();
    const result = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({
        // 旧合同里这里会放 validationRecord；新合同里它根本不存在，
        // 因此攻击者能控制的只剩一个引用字符串。
        receiptRef: "receipt:attacker-made-up",
        packageVersionId: forged.packageVersionId,
      }),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.reason, "verification_receipt_unavailable");
    }

    // 旧形状的字段被剥掉后也无法换回权力。
    const legacyShaped = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      {
        ...toolEvidenceAdmission({ receiptRef: "receipt:attacker-made-up" }),
        validationRecord: forged,
        provenance: "validation:val-attacker",
        kinds: ["external_verifier"],
        externalVerdict: "pass",
      } as unknown as Parameters<typeof admitToolEvidence>[2],
    );

    assert.equal(legacyShaped.ok, false);
  });
});

test("a real receipt cannot be replayed across subject, version, scope or domain", async () => {
  await withHarness(async (harness) => {
    const issued = await issueAgentMethodReceipt(harness, validationRecord(), { scope: "docs" });

    const mismatchedScope = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({ receiptRef: issued.receiptId, scope: "other-scope" }),
    );

    assert.equal(mismatchedScope.ok, false);

    if (!mismatchedScope.ok) {
      assert.equal(mismatchedScope.reason, "verification_binding_mismatch");
    }

    const mismatchedVersion = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({
        receiptRef: issued.receiptId,
        packageVersionId: "pkg:pdf-lint:9.9.9",
      }),
    );

    assert.equal(mismatchedVersion.ok, false);

    if (!mismatchedVersion.ok) {
      assert.equal(mismatchedVersion.reason, "verification_binding_mismatch");
    }

    // 用 D 的收据去喂 C 的准入：domain 不符，拒绝。
    const wrongDomain = await admitContentEvidence(
      harness.registry,
      evidenceDraft({ proposalId: "prop-1" }),
      evidenceAdmission({
        receiptRef: issued.receiptId,
        candidateVersion: VERSION_ID,
        scope: "docs",
      }),
    );

    assert.equal(wrongDomain.ok, false);

    if (!wrongDomain.ok) {
      assert.equal(wrongDomain.reason, "verification_binding_mismatch");
    }
  });
});

test("a pass receipt cannot be replayed onto a newer version of the same subject", async () => {
  await withHarness(async (harness) => {
    const issued = await issueAgentMethodReceipt(harness, validationRecord(), { scope: "docs" });
    // 同一 subject 的新版本：必须重新验证，不能复用旧 pass。
    const newer = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({
        receiptRef: issued.receiptId,
        packageVersionId: "pkg:pdf-lint:1.0.0",
        dataVersion: "validation-2026-09-14",
      }),
    );

    assert.equal(newer.ok, true, "the same version is still admissible");

    const stillOldVersion = await issueAgentMethodReceipt(
      harness,
      validationRecord({ packageVersionId: "pkg:pdf-lint:2.0.0" }),
      { scope: "docs", subjectVersion: "pkg:pdf-lint:1.0.0" },
    );
    const crossVersion = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({
        receiptRef: stillOldVersion.receiptId,
        packageVersionId: "pkg:pdf-lint:2.0.0",
      }),
    );

    assert.equal(crossVersion.ok, false);

    if (!crossVersion.ok) {
      assert.equal(crossVersion.reason, "verification_binding_mismatch");
    }
  });
});

test("a revoked receipt cannot promote anything", async () => {
  await withHarness(async (harness) => {
    const issued = await issueAgentMethodReceipt(harness, validationRecord(), { scope: "docs" });
    const revoked = await harness.registry.revoke(issued.receiptId, AT, "verifier withdrawn");

    assert.equal(revoked.ok, true);

    const result = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({ receiptRef: issued.receiptId }),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.reason, "verification_receipt_unavailable");
    }
  });
});

test("C: an agent checker pass cannot masquerade as user-explicit evidence", async () => {
  await withHarness(async (harness) => {
    // 攻击者用 agent_method 域签发（或伪造引用），然后拿去当用户证据。
    const agentReceipt = await issueAgentMethodReceipt(harness, validationRecord(), { scope: "docs" });
    const result = await admitContentEvidence(
      harness.registry,
      evidenceDraft({ proposalId: "prop-1" }),
      evidenceAdmission({ receiptRef: agentReceipt.receiptId, candidateVersion: "cand-1", scope: "docs" }),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.reason, "verification_binding_mismatch");
    }

    // user_explicit 域拒绝学习环自造来源：前缀不受支持的引用签不出发票。
    const selfInvented = await harness.registry.issue({
      domain: "user_explicit",
      subject: {
        subjectKind: "content_candidate",
        subjectId: "prop-1",
        subjectVersion: "cand-1",
        scope: "ts-unit-fix",
      },
      verifierId: "learning-user-pipeline",
      generatorId: "learning-user-pipeline-2",
      issuedAt: AT,
      sourceFactRef: "model-recall:the-user-probably-likes-this",
    });

    assert.equal(selfInvented.ok, false);

    if (!selfInvented.ok) {
      assert.equal(selfInvented.code, "missing_issuance_field");
    }
  });
});

test("D: a user-explicit receipt cannot masquerade as tool verification", async () => {
  await withHarness(async (harness) => {
    const userReceipt = await issueUserExplicitReceipt(harness);
    const result = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({ receiptRef: userReceipt.receiptId }),
    );

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.reason, "verification_binding_mismatch");
    }
  });
});

test("without an injected authority port no evidence command is produced", async () => {
  const result = await admitToolEvidence(undefined, evidenceDraftShape, toolEvidenceAdmission());

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "verification_authority_unavailable");
  }

  const content = await admitContentEvidence(
    undefined,
    evidenceDraft({ proposalId: "prop-1" }),
    evidenceAdmission(),
  );

  assert.equal(content.ok, false);

  if (!content.ok) {
    assert.equal(content.reason, "verification_authority_unavailable");
  }
});

test("a corrupted registry fails closed instead of granting a pass", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-authority-corrupt-"));
  try {
    const registryPath = path.join(root, "receipts.ndjson");
    const registry = createFileVerificationRegistry({
      path: registryPath,
      clock: fixedClock(),
      idFactory: sequentialReceiptIds(),
    });
    const issued = await issueAgentMethodReceipt({ registry, root, close: async () => undefined }, validationRecord(), {
      scope: "docs",
    });
    const raw = await readFile(registryPath, "utf8");

    // 中段改一个字节：checksum 不再匹配。
    await writeFile(registryPath, raw.replace("receipt_issued", "receipt_issuXed"), "utf8");
    const verified = await registry.verify(
      { receiptId: issued.receiptId },
      {
        domain: "agent_method",
        subjectKind: "tool_package_version",
        subjectId: VERSION_ID,
        subjectVersion: VERSION_ID,
        scope: "docs",
      },
    );

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_corrupt");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a receipt reference that is not even a string is refused", async () => {
  await withHarness(async (harness) => {
    for (const ref of ["", "   ", 42, undefined]) {
      const result = await admitToolEvidence(
        harness.registry,
        evidenceDraftShape,
        toolEvidenceAdmission({ receiptRef: ref as unknown as string }),
      );
      assert.equal(result.ok, false, `receiptRef ${String(ref)} must be refused`);
    }
  });
});
