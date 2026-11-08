import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  VERIFICATION_AUTHORITY_FORMAT_VERSION,
  type ReceiptExpectation,
  type ReceiptFailureCode,
  type ReceiptIssuanceInput,
  type ReceiptIssuanceResult,
  type ReceiptReference,
  type ReceiptRevocationResult,
  type ReceiptVerificationResult,
  type VerificationAuthorityReader,
  type VerificationAuthorityWriter,
} from "../../learning/verification-authority/contracts.js";
import { checkIssuance, receiptFromDraft } from "../../learning/verification-authority/issuance.js";
import { checkReceiptBinding } from "../../learning/verification-authority/binding.js";
import { isNonEmptyString } from "../../learning/verification-authority/parse.js";
import { epochMs } from "../../ports/approval-consumption.js";
import {
  decodeRegistry,
  encodeRegistryEvent,
  lastSequence,
  resolveReceipt,
  type RegistryEvent,
} from "./codec.js";
import { tryAcquireRegistryLock } from "./lock.js";

export type FileVerificationRegistryOptions = {
  /** 追加式 registry 文件。签发与撤销共享同一事件流。 */
  readonly path: string;
  /** 显式注入的时钟；测试不得依赖真实时间竞争。 */
  readonly clock: () => string;
  /** 显式注入的收据 id 工厂：authority 负责身份，不采信调用方给 id。 */
  readonly idFactory: (domain: ReceiptIssuanceInput["domain"]) => string;
};

/**
 * 持久 Verification Authority registry。
 *
 * 与 Permission store 的关系是「并列且分权」，不是「复用」：
 * - 这里只持有验证收据事实，不持有任何授权事实；
 * - reader 与 writer 是**分开的类型**（{@link VerificationAuthorityReader} /
 *   {@link VerificationAuthorityWriter}），组合根必须显式选择把哪一个交给谁；
 * - `verify` 只暴露单能力，不能枚举记录。
 */
export type FileVerificationRegistry = VerificationAuthorityReader &
  VerificationAuthorityWriter & {
    readonly path: string;
  };

export function createFileVerificationRegistry(
  options: FileVerificationRegistryOptions,
): FileVerificationRegistry {
  const context: RegistryContext = {
    path: options.path,
    clock: options.clock,
    idFactory: options.idFactory,
    withLock: makeWithLock(options.path),
  };
  return {
    path: options.path,
    verify: (reference, expected) => verifyFromRegistry(context, reference, expected),
    issue: (input) => issueIntoRegistry(context, input),
    revoke: (receiptId, revokedAt, reason) =>
      revokeInRegistry(context, receiptId, revokedAt, reason),
  };
}

type StoreFailure = { readonly code: ReceiptFailureCode; readonly message: string };

type LockedStep<T> = (
  events: readonly RegistryEvent[],
) => Promise<{ value: T } | { failure: StoreFailure }>;

type RegistryContext = {
  readonly path: string;
  readonly clock: () => string;
  readonly idFactory: (domain: ReceiptIssuanceInput["domain"]) => string;
  readonly withLock: <T>(
    step: LockedStep<T>,
  ) => Promise<{ value: T } | { failure: StoreFailure }>;
};

function makeWithLock(registryPath: string) {
  const lockPath = `${registryPath}.lock`;
  return async function withLock<T>(
    step: LockedStep<T>,
  ): Promise<{ value: T } | { failure: StoreFailure }> {
    try {
      await mkdir(dirname(registryPath), { recursive: true });
      await ensureDirectoryDurability(dirname(registryPath));
    } catch (error) {
      return { failure: { code: "registry_write_failed", message: describe(error) } };
    }

    const lock = tryAcquireRegistryLock(lockPath);
    if (!lock.ok) {
      return { failure: { code: lock.code, message: lock.detail } };
    }

    // 解码与 step 必须共用同一个 try/finally：早期版本在「解码失败」分支直接
    // return，跳过了释放，于是损坏的 registry 会把锁永久留给本进程，后续调用
    // 全部报 registry_multi_writer —— 一个损坏文件把服务变成不可用。
    try {
      const decoded = decodeRegistry(await readRegistryText(registryPath));
      if (!decoded.ok) {
        return { failure: { code: decoded.code, message: decoded.detail } };
      }
      return await step(decoded.events);
    } catch (error) {
      return { failure: { code: "registry_write_failed", message: describe(error) } };
    } finally {
      releaseQuietly(lock.release);
    }
  };
}

async function issueIntoRegistry(
  context: RegistryContext,
  input: ReceiptIssuanceInput,
): Promise<ReceiptIssuanceResult> {
  // 身份由 authority 生成，调用方传入的 receiptId（若存在）一律被覆盖。
  const withIdentity = { ...(input as object), receiptId: context.idFactory(input.domain) };
  const checked = checkIssuance(withIdentity);
  if (!checked.ok) {
    return { ok: false, code: checked.code, message: checked.message };
  }

  const result = await context.withLock<ReceiptIssuanceResult>(
    async (events): Promise<{ value: ReceiptIssuanceResult } | { failure: StoreFailure }> => {
    const sequence = lastSequence(events) + 1;
    const receipt = receiptFromDraft(checked.draft, sequence);

    await appendEvent(context.path, {
      formatVersion: VERIFICATION_AUTHORITY_FORMAT_VERSION,
      kind: "receipt_issued",
      sequence,
      receiptId: receipt.receiptId,
      domain: receipt.domain,
      subjectKind: receipt.subject.subjectKind,
      subjectId: receipt.subject.subjectId,
      subjectVersion: receipt.subject.subjectVersion,
      scope: receipt.subject.scope,
      verifierId: receipt.verifierId,
      generatorId: receipt.generatorId,
      verdict: receipt.verdict,
      checksDigest: receipt.checksDigest,
      sourceDigest: receipt.sourceDigest,
      issuedAt: receipt.issuedAt,
    });

    return { value: { ok: true as const, receipt } };
  });
  if ("failure" in result) {
    return { ok: false, code: result.failure.code, message: result.failure.message };
  }

  return result.value;
}

async function verifyFromRegistry(
  context: RegistryContext,
  reference: unknown,
  expected: ReceiptExpectation,
): Promise<ReceiptVerificationResult> {
  if (reference === undefined || reference === null) {
    return verifyErr("missing_receipt_ref", "a receipt reference is required");
  }

  const receiptId = (reference as Partial<ReceiptReference>).receiptId;
  if (!isNonEmptyString(receiptId)) {
    return verifyErr("invalid_receipt_ref", "receipt reference must carry a non-empty receiptId");
  }

  const result = await context.withLock<ReceiptVerificationResult>(
    async (events): Promise<{ value: ReceiptVerificationResult } | { failure: StoreFailure }> => {
    const resolved = resolveReceipt(events, receiptId);
    if (resolved === undefined) {
      return {
        failure: {
          code: "unknown_receipt" as const,
          message: `no receipt ${receiptId} in this registry`,
        },
      };
    }

    if (resolved.status === "revoked") {
      return {
        failure: {
          code: "receipt_revoked" as const,
          message: `receipt ${receiptId} was revoked`,
        },
      };
    }

    const binding = checkReceiptBinding(resolved.receipt, expected);
    if (!binding.ok) {
      return { failure: { code: binding.code, message: binding.message } };
    }

    return { value: { ok: true as const, receipt: resolved.receipt } };
  });
  if ("failure" in result) {
    return verifyErr(result.failure.code, result.failure.message);
  }

  return result.value;
}

async function revokeInRegistry(
  context: RegistryContext,
  receiptId: string,
  revokedAt: string,
  reason: string,
): Promise<ReceiptRevocationResult> {
  if (!isNonEmptyString(receiptId) || !isNonEmptyString(reason) || epochMs(revokedAt) === undefined) {
    return {
      ok: false,
      code: "missing_issuance_field",
      message: "revoke needs a receiptId, a reason and a strict ISO-8601 timestamp",
    };
  }

  const result = await context.withLock<ReceiptRevocationResult>(
    async (events): Promise<{ value: ReceiptRevocationResult } | { failure: StoreFailure }> => {
    const resolved = resolveReceipt(events, receiptId);
    if (resolved === undefined) {
      return { failure: { code: "unknown_receipt" as const, message: `no receipt ${receiptId}` } };
    }

    if (resolved.status === "revoked") {
      return {
        failure: {
          code: "receipt_revoked" as const,
          message: `receipt ${receiptId} was already revoked`,
        },
      };
    }

    await appendEvent(context.path, {
      formatVersion: VERIFICATION_AUTHORITY_FORMAT_VERSION,
      kind: "receipt_revoked",
      sequence: lastSequence(events) + 1,
      receiptId,
      revokedAt,
      reason,
    });

    return { value: { ok: true as const, receiptId, status: "revoked" as const } };
  });
  if ("failure" in result) {
    return { ok: false, code: result.failure.code, message: result.failure.message };
  }

  return result.value;
}

function verifyErr(code: ReceiptFailureCode, message: string): ReceiptVerificationResult {
  return { ok: false, code, message };
}

async function readRegistryText(registryPath: string): Promise<string> {
  try {
    return await readFile(registryPath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

/** 整写循环：`handle.write` 可能少写；忽略 `bytesWritten` 会静默截断 registry。 */
async function appendEvent(registryPath: string, event: RegistryEvent): Promise<void> {
  const bytes = Buffer.from(encodeRegistryEvent(event), "utf8");
  const handle = await open(registryPath, "a");

  try {
    let written = 0;

    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);

      if (bytesWritten <= 0) {
        throw new Error(
          `zero-byte write into receipt registry after ${String(written)} of ${String(bytes.length)} bytes`,
        );
      }

      written += bytesWritten;
    }

    if (written !== bytes.length) {
      throw new Error(
        `partial write into receipt registry: ${String(written)} of ${String(bytes.length)} bytes`,
      );
    }

    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryDurability(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const handle = await open(directory, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function releaseQuietly(release: () => void): void {
  try {
    release();
  } catch (error) {
    // 清理失败不影响已确定的结果；残留锁文件会让下一个 writer fail closed。
    void error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
