import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { ReceiptFailureCode } from "../../learning/verification-authority/contracts.js";

export type RegistryLockErr = Extract<
  ReceiptFailureCode,
  "registry_lock_conflict" | "registry_write_failed" | "registry_multi_writer"
>;

export type RegistryLock =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly code: RegistryLockErr; readonly detail: string };

/**
 * 单 writer 锁。在 read–validate–append 周期前获取、在 `finally` 释放，
 * 因此正常返回不会留下陈锁。
 *
 * 进程若在临界区内死亡，锁文件会残留；下一个 writer 得到
 * `registry_lock_conflict`，而不是去猜那次中断的 append 是否真的落盘
 * ——宁可要求重新签发，也不接受一次「可能已写、可能没写」的收据。
 *
 * 锁文件里写入持有者 pid：同一进程内的第二个 writer 会得到
 * `registry_multi_writer`（这是同进程重入，不是跨进程竞争；两者的处置不同：
 * 前者是组合根缺陷，后者是等待与人工恢复）。
 *
 * 不提供自动过期/自动清理：陈锁的人工恢复策略见 PERSISTENCE-AND-RECOVERY.md，
 * 在没有可证明安全的自动方案前不猜测（WP-F §7 D4.6）。
 */
export function tryAcquireRegistryLock(lockPath: string): RegistryLock {
  let fd: number;

  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      return inspectExisting(lockPath);
    }
    return { ok: false, code: "registry_write_failed", detail: describe(error) };
  }

  try {
    writeSync(fd, `${process.pid}\n`);
  } catch (error) {
    closeSync(fd);
    return { ok: false, code: "registry_write_failed", detail: describe(error) };
  }

  return {
    ok: true,
    release() {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (!isCode(error, "ENOENT")) {
          throw error;
        }
      }
    },
  };
}

function inspectExisting(lockPath: string): RegistryLock {
  let holder = "";

  try {
    holder = readFileSync(lockPath, "utf8").trim();
  } catch {
    // An unreadable holder is treated as a foreign holder: the lock stays
    // with whoever holds it, and this caller fails closed on conflict below.
    holder = "";
  }

  if (holder === String(process.pid)) {
    return {
      ok: false,
      code: "registry_multi_writer",
      detail: `this process already holds ${lockPath}`,
    };
  }

  return { ok: false, code: "registry_lock_conflict", detail: lockPath };
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
