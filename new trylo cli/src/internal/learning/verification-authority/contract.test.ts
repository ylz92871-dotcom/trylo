import assert from "node:assert/strict";
import test from "node:test";
import { VALIDATION_STAGE_ORDER } from "../../tooling/contract/types.js";
import type { ValidationRecord } from "../../tooling/contract/types.js";
import { checkReceiptBinding } from "./binding.js";
import {
  VERIFICATION_AUTHORITY_FORMAT_VERSION,
  type ReceiptExpectation,
  type VerificationReceipt,
} from "./contracts.js";
import { checkIssuance, receiptFromDraft } from "./issuance.js";
import { parseVerificationReceipt } from "./parse.js";
import { deriveChecksDigest, deriveSourceDigest } from "./validation-record.js";

/**
 * 合同层单元证据（WP-F §7 D1.6：伪造、错 domain、错 version、错 scope、错 subject、
 * generator=verifier、stale、revoked、unknown ref 先红后绿）。
 *
 * 「revoked」与「unknown ref」属于持久层（见 `adapters/verification-authority-store`），
 * 这里覆盖的是纯函数合同：解析、签发派生、绑定核对。
 */

function passRecord(packageVersionId = "pkg:1"): ValidationRecord {
  return {
    validationId: "val-1",
    packageVersionId,
    stages: VALIDATION_STAGE_ORDER.map((stage) => ({
      stage,
      passed: true,
      detail: `${stage} ok`,
    })),
    verdict: "pass",
    actor: "verifier",
  };
}

function canonicalReceipt(): Record<string, unknown> {
  return {
    formatVersion: VERIFICATION_AUTHORITY_FORMAT_VERSION,
    receiptId: "receipt:1",
    domain: "agent_method",
    subjectKind: "tool_package_version",
    subjectId: "pkg:1",
    subjectVersion: "pkg:1",
    scope: "docs",
    verifierId: "tool-validation-pipeline",
    generatorId: "candidate-builder",
    verdict: "pass",
    checksDigest: "checks:abc",
    sourceDigest: "source:abc",
    issuedAt: "2026-09-13T00:00:00.000Z",
    sequence: 1,
  };
}

function receiptOf(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  const parsed = parseVerificationReceipt(canonicalReceipt());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    throw new Error("fixture receipt must parse");
  }
  return { ...parsed.value, ...overrides };
}

const AGENT_EXPECTATION: ReceiptExpectation = {
  domain: "agent_method",
  subjectKind: "tool_package_version",
  subjectId: "pkg:1",
  subjectVersion: "pkg:1",
  scope: "docs",
};

test("a canonical receipt parses, and every field is re-validated at runtime", () => {
  const parsed = parseVerificationReceipt(canonicalReceipt());

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.value.receiptId, "receipt:1");
    assert.equal(parsed.value.subject.subjectId, "pkg:1");
    assert.equal(parsed.value.sequence, 1);
  }
});

test("the parser refuses unknown keys, unknown versions and malformed fields", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown key", { ...canonicalReceipt(), injected: "x" }],
    ["unknown format version", { ...canonicalReceipt(), formatVersion: 99 }],
    ["unknown domain", { ...canonicalReceipt(), domain: "third_party" }],
    ["unknown subject kind", { ...canonicalReceipt(), subjectKind: "workflow" }],
    ["empty subject id", { ...canonicalReceipt(), subjectId: " " }],
    ["missing digests", { ...canonicalReceipt(), sourceDigest: "" }],
    ["unknown verdict", { ...canonicalReceipt(), verdict: "maybe" }],
    ["impossible calendar date", { ...canonicalReceipt(), issuedAt: "2026-02-30T00:00:00.000Z" }],
    ["zero sequence", { ...canonicalReceipt(), sequence: 0 }],
    ["non-object", "receipt"],
  ];
  for (const [label, value] of cases) {
    const parsed = parseVerificationReceipt(value);
    assert.equal(parsed.ok, false, label);
    if (!parsed.ok) {
      assert.equal(parsed.reason, "registry_corrupt", label);
    }
  }
});

test("binding refuses every single-field mismatch", () => {
  const receipt = receiptOf();

  assert.equal(checkReceiptBinding(receipt, AGENT_EXPECTATION).ok, true);
  const mismatches: ReadonlyArray<readonly [string, ReceiptExpectation]> = [
    ["domain", { ...AGENT_EXPECTATION, domain: "user_explicit" }],
    ["subject kind", { ...AGENT_EXPECTATION, subjectKind: "content_candidate" }],
    ["subject id", { ...AGENT_EXPECTATION, subjectId: "pkg:2" }],
    ["version", { ...AGENT_EXPECTATION, subjectVersion: "pkg:2" }],
    ["scope", { ...AGENT_EXPECTATION, scope: "other" }],
  ];

  for (const [label, expectation] of mismatches) {
    const check = checkReceiptBinding(receipt, expectation);
    assert.equal(check.ok, false, label);
  }
});

test("a receipt whose verifier is its own generator is refused on the read path", () => {
  const check = checkReceiptBinding(
    receiptOf({ verifierId: "same-identity", generatorId: "same-identity" }),
    AGENT_EXPECTATION,
  );

  assert.equal(check.ok, false);

  if (!check.ok) {
    assert.equal(check.code, "receipt_identity_not_independent");
  }
});

test("identity independence compares normalized identities, never raw strings", () => {
  // 签发侧：尾随/前导空白、不换行空格与 NFC 未合成序列都是**同一身份**。
  // 外审 R3 §3 P2-1 的反例是 `"one-agent "`（尾随空格）当年能签发成功并晋升成功。
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ["same ", "same"],
    [" same", "same"],
    ["same\u00a0", "same"],
    ["cafe\u0301", "caf\u00e9"],
  ];

  for (const [verifierId, generatorId] of aliases) {
    const checked = checkIssuance({ ...agentInput(passRecord()), verifierId, generatorId });
    assert.equal(checked.ok, false, `issuance must refuse verifier=${JSON.stringify(verifierId)}`);
    if (!checked.ok) {
      assert.equal(checked.code, "generator_is_verifier");
    }
  }

  // 读路径：本函数是纯函数，可能被以手工构造的收据直接调用（绕过解析器），
  // 因此必须自己归一化，而不能假设上游已经做过。
  const read = checkReceiptBinding(
    receiptOf({ verifierId: "cafe\u0301", generatorId: "caf\u00e9" }),
    AGENT_EXPECTATION,
  );

  assert.equal(read.ok, false);

  if (!read.ok) {
    assert.equal(read.code, "receipt_identity_not_independent");
  }

  // 未关闭的残留（登记在 `HANDOFF-MANIFEST.md` §OPEN P2-1，不得写成已关闭）：
  // 归一化只做 NFC + trim，大小写与 Unicode 同形字仍是两个身份。
  assert.equal(
    checkReceiptBinding(receiptOf({ verifierId: "SAME", generatorId: "same" }), AGENT_EXPECTATION).ok,
    true,
    "case folding is a documented residual",
  );
  assert.equal(
    checkReceiptBinding(receiptOf({ verifierId: "one-\u0430gent", generatorId: "one-agent" }), AGENT_EXPECTATION).ok,
    true,
    "homoglyphs are a documented residual",
  );
});

test("the parser canonicalizes identity fields at the read boundary", () => {
  // 解析器是外部记录的唯一边界：手写的 `"one-agent "` 在这里就被归一化，
  // 于是下游的身份比较不可能再被字面层别名骗过。
  const parsed = parseVerificationReceipt({
    ...canonicalReceipt(),
    verifierId: "one-agent ",
    generatorId: "one-agent",
  });

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.value.verifierId, "one-agent");
    assert.equal(parsed.value.generatorId, "one-agent");
  }
});

test("issuance derives the verdict and digests instead of echoing the caller", () => {
  const record = passRecord();
  const draft = signAgentMethod(record);

  assert.equal(draft.domain, "agent_method");
  assert.equal(draft.verdict, "pass");
  assert.equal(draft.subject.subjectId, record.packageVersionId);
  // 调用方没有提供 verdict / digest；它们必须等于从记录重算的值。
  assert.equal(draft.checksDigest, deriveChecksDigest(record));
  assert.equal(draft.sourceDigest, deriveSourceDigest(record));
});

test("issuance refuses identity collapse, bad timestamps and mis-shaped domains", () => {
  const base = agentInput(passRecord());
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["generator is verifier", { ...base, verifierId: "same", generatorId: "same" }],
    ["missing generator", { ...base, generatorId: " " }],
    ["bad timestamp", { ...base, issuedAt: "2026-09-13" }],
    ["unknown domain", { ...base, domain: "third_party" }],
    ["wrong subject kind", { ...base, subject: { ...subject(), subjectKind: "content_candidate" } }],
    ["subject is not the record", { ...base, subject: { ...subject(), subjectId: "pkg:other" } }],
    ["missing validation record", { ...base, validationRecord: undefined }],
    [
      "record with a failed stage",
      {
        ...base,
        validationRecord: { ...passRecord(), verdict: "fail" },
      },
    ],
  ];

  for (const [label, input] of cases) {
    const checked = checkIssuance(input);
    assert.equal(checked.ok, false, label);
  }
});

test("user_explicit issuance only accepts execution-bound or user-stated facts", () => {
  const accepted = checkIssuance({
    ...userExplicitInput("execution:turn-1"),
  });

  assert.equal(accepted.ok, true);
  const stated = checkIssuance(userExplicitInput("user_explicit:fix-types"));

  assert.equal(stated.ok, true);

  for (const ref of ["independent_verifier:made-up", "validation:val-attacker", ""]) {
    const checked = checkIssuance(userExplicitInput(ref));
    assert.equal(checked.ok, false, ref);
  }

  const wrongKind = checkIssuance({
    ...userExplicitInput("execution:turn-1"),
    subject: { ...subject(), subjectKind: "tool_package_version" },
  });

  assert.equal(wrongKind.ok, false);
});

test("user_explicit digests are derived, so the registry never stores the raw fact ref", () => {
  const input = userExplicitInput("user_explicit:please-fix-typescript-1234");
  const checked = checkIssuance(input);

  assert.equal(checked.ok, true);

  if (!checked.ok) {
    return;
  }

  assert.equal(checked.draft.checksDigest.includes("please-fix-typescript-1234"), false);
  assert.equal(checked.draft.sourceDigest.includes("please-fix-typescript-1234"), false);
  assert.match(checked.draft.checksDigest, /^checks:[0-9a-f]{32}$/);
  assert.match(checked.draft.sourceDigest, /^source:[0-9a-f]{32}$/);

  // 同一事实引用 → 同一 sourceDigest（可做审计关联）；不同主体 → 不同 checksDigest。
  const again = checkIssuance(input);

  assert.equal(again.ok, true);

  if (again.ok) {
    assert.equal(again.draft.sourceDigest, checked.draft.sourceDigest);
  }

  const otherSubject = checkIssuance({
    ...input,
    subject: { ...contentSubject(), subjectId: "prop-2" },
  });

  assert.equal(otherSubject.ok, true);

  if (otherSubject.ok) {
    assert.notEqual(otherSubject.draft.checksDigest, checked.draft.checksDigest);
  }
});

test("digests are deterministic and insensitive to key order, but not to stage order", () => {
  const record = passRecord();
  const sameKeysReordered: ValidationRecord = {
    ...record,
    stages: record.stages.map((stage) => ({
      detail: stage.detail,
      passed: stage.passed,
      stage: stage.stage,
    })),
  };

  assert.equal(deriveChecksDigest(sameKeysReordered), deriveChecksDigest(record));

  const first = record.stages[0];
  const second = record.stages[1];

  assert.notEqual(first, undefined);
  assert.notEqual(second, undefined);

  if (first === undefined || second === undefined) {
    return;
  }

  const reordered: ValidationRecord = {
    ...record,
    stages: [second, first, ...record.stages.slice(2)],
  };

  assert.notEqual(deriveChecksDigest(reordered), deriveChecksDigest(record));
});

function subject(): Record<string, unknown> {
  return {
    subjectKind: "tool_package_version",
    subjectId: "pkg:1",
    subjectVersion: "pkg:1",
    scope: "docs",
  };
}

function contentSubject(): Record<string, unknown> {
  return {
    subjectKind: "content_candidate",
    subjectId: "prop-1",
    subjectVersion: "cand-1",
    scope: "ts-unit-fix",
  };
}

function agentInput(record: ValidationRecord): Record<string, unknown> {
  return {
    domain: "agent_method",
    // receiptId 由 authority 侧生成；这里预置是为了让断言落在被考察的规则上，
    // 而不是落在「缺 receiptId」这条更早的守卫。
    receiptId: "receipt:1",
    subject: subject(),
    verifierId: "tool-validation-pipeline",
    generatorId: "candidate-builder",
    issuedAt: "2026-09-13T00:00:00.000Z",
    validationRecord: record,
  };
}

function userExplicitInput(sourceFactRef: string): Record<string, unknown> {
  return {
    domain: "user_explicit",
    receiptId: "receipt:1",
    subject: contentSubject(),
    verifierId: "execution-evidence-recorder",
    generatorId: "learning-user-pipeline",
    issuedAt: "2026-09-13T00:00:00.000Z",
    sourceFactRef,
  };
}

function signAgentMethod(record: ValidationRecord) {
  const checked = checkIssuance(agentInput(record));
  assert.equal(checked.ok, true);
  if (!checked.ok) {
    throw new Error("expected an issuance draft");
  }
  return receiptFromDraft(checked.draft, 1);
}
