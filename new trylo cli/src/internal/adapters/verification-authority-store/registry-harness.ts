/**
 * durable receipt registry 的测试夹具（真实文件，非内存 fake）。
 *
 * 与 `../../integration/testing/authority-fixtures.ts` 的分工：那个夹具服务于
 * gateway 的端到端准入；这里的夹具服务于 registry 自身的编解码/损坏/锁行为，
 * 因此把「原始文件文本」也暴露出来（`file`），供测试直接改写字节。
 *
 * 拆成独立模块的直接原因是外审 R3 §3 P3-3：`registry.test.ts` 一度因损坏用例
 * 堆叠超过单文件 400 行纪律。把 harness 抽出来后，durability 与 corruption 两个
 * 测试文件各自保持在一屏可读的规模。
 *
 * 用真实文件而不是内存实现是刻意的（WP-F §9「不做生产降级用内存 fake」）：
 * 只有真实文件才可能证明「registry 文件被改写 → fail closed」。
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { VALIDATION_STAGE_ORDER } from "../../tooling/contract/types.js";
import type { ValidationRecord } from "../../tooling/contract/types.js";
import {
  createFileVerificationRegistry,
  type FileVerificationRegistry,
  type RegistryEvent,
} from "./index.js";

/** 与 `issuePass` 签发的收据相匹配的绑定期望。 */
export const EXPECTED = {
  domain: "agent_method",
  subjectKind: "tool_package_version",
  subjectId: "pkg:1",
  subjectVersion: "pkg:1",
  scope: "docs",
} as const;

export function passRecord(packageVersionId = "pkg:1"): ValidationRecord {
  return {
    validationId: `val-${packageVersionId}`,
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

export type RegistryHarness = {
  readonly file: string;
  readonly registry: FileVerificationRegistry;
  readonly close: () => Promise<void>;
};

/** 每个用例独占一个临时目录，避免锁/状态互相污染。 */
export async function openRegistryFileHarness(): Promise<RegistryHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-registry-"));
  const file = path.join(root, "receipts.ndjson");

  return {
    file,
    registry: createRegistry(file),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

/** 显式 clock/idFactory：身份与时间由 authority 侧派生，测试可预测、可断言。 */
export function createRegistry(file: string): FileVerificationRegistry {
  let counter = 0;
  return createFileVerificationRegistry({
    path: file,
    clock: () => "2026-09-13T00:00:00.000Z",
    idFactory: (domain) => {
      counter += 1;
      return `receipt:${domain}:${String(counter)}`;
    },
  });
}

/** 签发一条 agent_method pass 收据，返回其 receiptId。 */
export async function issuePass(harness: RegistryHarness): Promise<string> {
  const issued = await harness.registry.issue({
    domain: "agent_method",
    subject: {
      subjectKind: "tool_package_version",
      subjectId: "pkg:1",
      subjectVersion: "pkg:1",
      scope: "docs",
    },
    verifierId: "tool-validation-pipeline",
    generatorId: "candidate-builder",
    issuedAt: "2026-09-13T00:00:00.000Z",
    validationRecord: passRecord(),
  });
  if (!issued.ok) {
    throw new Error(`fixture receipt issuance failed: ${issued.code} ${issued.message}`);
  }

  return issued.receipt.receiptId;
}

/** 用与 codec 相同的方式重新计算校验和，模拟「改写者也知道格式」。 */
export function line(event: RegistryEvent | Record<string, unknown>): string {
  const payload = canonicalJson(event);
  return `${sha256Hex(payload)} ${payload}`;
}

/** 读取 registry 文件的原始字节（损坏用例直接改写它）。 */
export function readRaw(harness: RegistryHarness): Promise<string> {
  return readFile(harness.file, "utf8");
}
