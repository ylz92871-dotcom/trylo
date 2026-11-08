/**
 * Verification Authority 测试夹具。
 *
 * 与 `fixtures.ts` 分开的理由：这里需要真实 durable registry（临时目录 + 真实
 * 文件），而 `fixtures.ts` 保持纯函数。用真实文件而不是内存 fake 是刻意的
 * （WP-F §9「不加内存 fake 生产降级」）：如果测试用内存实现，就无法证明
 * 「registry 文件损坏 → fail closed」这类行为。
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFileVerificationRegistry,
  type FileVerificationRegistry,
} from "../../adapters/verification-authority-store/index.js";
import type {
  ReceiptIssuanceInput,
  VerificationReceipt,
} from "../../learning/verification-authority/contracts.js";
import type { ValidationRecord } from "../../tooling/contract/types.js";

/** 显式时钟：测试不得依赖真实时间。 */
export function fixedClock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return `2026-09-13T00:00:${String(tick % 60).padStart(2, "0")}.000Z`;
  };
}

/** 显式 id 工厂：可预测、可断言，且由 authority 侧生成而非调用方。 */
export function sequentialReceiptIds(prefix = "receipt:test"): (domain: string) => string {
  let counter = 0;
  return (domain: string) => {
    counter += 1;
    return `${prefix}-${domain}-${String(counter)}`;
  };
}

export type RegistryHarness = {
  readonly registry: FileVerificationRegistry;
  readonly root: string;
  readonly close: () => Promise<void>;
};

export async function openRegistryHarness(): Promise<RegistryHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-authority-"));
  return {
    root,
    registry: createFileVerificationRegistry({
      path: path.join(root, "receipts.ndjson"),
      clock: fixedClock(),
      idFactory: sequentialReceiptIds(),
    }),
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type IssuedReceipt = {
  readonly receiptId: string;
  readonly receipt: VerificationReceipt;
};

/** 签发一条 agent_method 收据（工具包版本的独立验证）。 */
export async function issueAgentMethodReceipt(
  harness: RegistryHarness,
  record: ValidationRecord,
  overrides: {
    readonly scope?: string;
    readonly subjectVersion?: string;
    readonly verifierId?: string;
    readonly generatorId?: string;
  } = {},
): Promise<IssuedReceipt> {
  const input: ReceiptIssuanceInput = {
    domain: "agent_method",
    subject: {
      subjectKind: "tool_package_version",
      subjectId: record.packageVersionId,
      subjectVersion: overrides.subjectVersion ?? record.packageVersionId,
      scope: overrides.scope ?? "docs",
    },
    verifierId: overrides.verifierId ?? "tool-validation-pipeline",
    generatorId: overrides.generatorId ?? "candidate-builder",
    issuedAt: "2026-09-13T00:00:00.000Z",
    validationRecord: record,
  };
  const issued = await harness.registry.issue(input);
  if (!issued.ok) {
    throw new Error(`fixture receipt issuance failed: ${issued.code} ${issued.message}`);
  }

  return { receiptId: issued.receipt.receiptId, receipt: issued.receipt };
}

/** 签发一条 user_explicit 收据（执行绑定事实或用户明令）。 */
export async function issueUserExplicitReceipt(
  harness: RegistryHarness,
  overrides: {
    readonly subjectId?: string;
    readonly subjectVersion?: string;
    readonly scope?: string;
    readonly sourceFactRef?: string;
  } = {},
): Promise<IssuedReceipt> {
  const input: ReceiptIssuanceInput = {
    domain: "user_explicit",
    subject: {
      subjectKind: "content_candidate",
      subjectId: overrides.subjectId ?? "prop-1",
      subjectVersion: overrides.subjectVersion ?? "cand-1",
      scope: overrides.scope ?? "ts-unit-fix",
    },
    verifierId: "execution-evidence-recorder",
    generatorId: "learning-user-pipeline",
    issuedAt: "2026-09-13T00:00:00.000Z",
    sourceFactRef: overrides.sourceFactRef ?? "execution:turn-1",
  };
  const issued = await harness.registry.issue(input);
  if (!issued.ok) {
    throw new Error(`fixture receipt issuance failed: ${issued.code} ${issued.message}`);
  }

  return { receiptId: issued.receipt.receiptId, receipt: issued.receipt };
}
