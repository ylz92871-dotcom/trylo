import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256Hex } from "../../learning/control/hash.js";
import {
  checkApprovalConsumption,
  checkGrantIssuance,
  consumptionErr,
  consumptionOk,
  epochMs,
  isNonEmptyString,
  type ApprovalConsumptionFailure,
  type ApprovalConsumptionOutcome,
  type ApprovalConsumptionPort,
  type ApprovalConsumptionReceipt,
  type ApprovalConsumptionRequest,
  type GrantIssuanceInput,
  type PermissionGrant,
  type PermissionGrantLookup,
} from "../../ports/approval-consumption.js";
import {
  decodeStoreLedger,
  deriveGrantId,
  encodeStoreEvent,
  grantConsumedEvent,
  grantIssuedEvent,
  grantRevokedEvent,
  resolveGrant,
  type PermissionStoreEvent,
} from "./codec.js";
import { tryAcquireLedgerLock } from "./lock.js";

export type FilePermissionStoreOptions = {
  /** Append-only event file. Grant issuance, revocation and consumption share it. */
  readonly path: string;
};

/**
 * Derive the store identity from the store file path.
 *
 * This is the **only** source of store identity (external audit R3 §3 P2-3). An
 * earlier revision accepted a caller-supplied `storeId`; when two stores were
 * constructed with the same value, they derived the same grant ids from the same
 * facts and the same sequence, which reopened the cross-store double consumption
 * that R2 P2-R4 had closed. The injection point is gone: no caller can influence
 * store identity, so distinct store files are structurally unable to share a
 * global grant reference.
 */
export function storeIdFromPath(storePath: string): string {
  return `store:${sha256Hex(resolve(storePath)).slice(0, 32)}`;
}

export type StoreFailure = {
  readonly code: ApprovalConsumptionFailure;
  readonly message: string;
};

export type FilePermissionStore = ApprovalConsumptionPort & {
  /** Issue a new single-use grant. Returns the grant; only the reference leaves the Permission side. */
  readonly issue: (input: GrantIssuanceInput) => Promise<PermissionIssueOutcome>;
  /** Revoke a grant. Idempotent for already-revoked/consumed grants. */
  readonly revoke: (grantId: string, now: string) => Promise<PermissionRevokeOutcome>;
  /**
   * Read the current grant facts. Callers never construct these themselves.
   *
   * Returns a discriminated result (external audit R2 §4.3): the old signature
   * returned `undefined` both for "no such grant" and for "the ledger is
   * unreadable", which silently swallowed corruption on the read path. The
   * consume path already reported `ledger_corrupt`; the read path must not be
   * weaker.
   */
  readonly getGrant: (grantId: string) => Promise<PermissionGrantLookup>;
};

export type PermissionIssueOutcome =
  | { readonly ok: true; readonly grant: PermissionGrant }
  | { readonly ok: false; readonly code: ApprovalConsumptionFailure; readonly message: string };

export type PermissionRevokeOutcome =
  | { readonly ok: true; readonly grantId: string; readonly status: "revoked" | "consumed" }
  | { readonly ok: false; readonly code: ApprovalConsumptionFailure; readonly message: string };

type LockedStep<T> = (
  events: readonly PermissionStoreEvent[],
) => Promise<{ value: T } | { failure: StoreFailure }>;

/** Everything the module-level store operations need; one instance per store file. */
type StoreContext = {
  readonly path: string;
  readonly storeId: string;
  readonly withLock: <T>(step: LockedStep<T>) => Promise<{ value: T } | { failure: StoreFailure }>;
};

/**
 * Durable Permission store: the canonical owner of grant facts and of the
 * one-time consumption ledger, in a single checksummed append-only file under
 * a single-writer lock.
 *
 * Contract (external audit P0-1): `consume` only accepts a grant *reference*.
 * Every authorization fact is read back from this store, so a caller-supplied
 * object can never assert its own authority. The reference resolves in exactly
 * one store (the issuing one), which closes cross-path double consumption
 * (audit P1-4).
 *
 * Crash semantics: the consumption event is fsynced *before* the protected call
 * site performs any effect. A crash between append and effect leaves the grant
 * consumed and forces re-authorization — never a silent second effect.
 */
export function createFilePermissionStore(options: FilePermissionStoreOptions): FilePermissionStore {
  const ctx: StoreContext = {
    path: options.path,
    // 身份只从路径派生，没有注入点（外审 R3 §3 P2-3）：否则组合根传同一个值时，
    // 两个 store 会从相同事实 + 相同序号派生出同一个 grantId，跨店双消费重新打开。
    storeId: storeIdFromPath(options.path),
    withLock: makeWithLock(options.path),
  };
  return {
    consume: (request) => consumeFromStore(ctx, request),
    issue: (input) => issueFromStore(ctx, input),
    revoke: (grantId, now) => revokeFromStore(ctx, grantId, now),
    getGrant: (grantId) => getGrantFromStore(ctx, grantId),
  };
}

/** Read–validate–append under the single-writer lock; every store operation goes through here. */
function makeWithLock(storePath: string) {
  const lockPath = `${storePath}.lock`;
  return async function withLock<T>(
    step: LockedStep<T>,
  ): Promise<{ value: T } | { failure: StoreFailure }> {
    try {
      await mkdir(dirname(storePath), { recursive: true });
      await ensureDirectoryDurability(dirname(storePath));
    } catch (error) {
      return { failure: { code: "ledger_write_failed", message: describe(error) } };
    }

    const lock = tryAcquireLedgerLock(lockPath);
    if (!lock.ok) {
      return { failure: { code: lock.reason, message: lock.detail } };
    }

    // 解码与业务步骤共用同一个 try/finally：早期版本在「解码失败」分支直接 return，
    // 跳过了锁释放，于是**损坏的账本会把锁永久留给本进程**，之后所有操作都报
    // ledger_lock_conflict —— 一个损坏文件把整个 store 变成不可用，而且掩盖了真正的
    // 失败原因。回归证据见 file-ledger.test.ts「a corrupted ledger does not leak the writer lock」。
    try {
      const raw = await readStoreText(storePath);
      const decoded = decodeStoreLedger(raw);
      if (!decoded.ok) {
        return { failure: { code: decoded.reason, message: decoded.detail } };
      }
      return await step(decoded.events);
    } catch (error) {
      return { failure: { code: "ledger_write_failed", message: describe(error) } };
    } finally {
      // Release errors must not overwrite the explicit outcome (audit P1-6).
      // A release failure leaves the lock file behind; the next writer then
      // fails closed with ledger_lock_conflict until it is cleaned up.
      releaseQuietly(lock.release);
    }
  };
}

async function consumeFromStore(
  ctx: StoreContext,
  request: ApprovalConsumptionRequest,
): Promise<ApprovalConsumptionOutcome> {
  if (request.token === undefined) {
    return consumptionErr("missing_token", "a grant reference is required");
  }

  if (!isNonEmptyString(request.token.grantId)) {
    return consumptionErr("invalid_token", "grant reference must carry a non-empty grantId");
  }

  const grantId = request.token.grantId;
  const result = await ctx.withLock(async (events) => {
    const grant = resolveGrant(events, grantId);
    if (grant === undefined) {
      return { failure: { code: "unknown_grant" as const, message: `no grant ${grantId} in this Permission store` } };
    }

    const checked = checkApprovalConsumption(grant, request);
    if (!checked.ok) {
      return { failure: checked };
    }

    const sequence = lastSequence(events) + 1;

    await appendEvent(ctx.path, grantConsumedEvent({
      sequence,
      kind: "grant_consumed",
      grantId,
      action: request.action,
      candidateId: request.candidateId,
      packageVersionId: request.packageVersionId,
      scope: request.scope,
      consumedAt: request.now,
    }));
    const receipt: ApprovalConsumptionReceipt = {
      grantId,
      action: request.action,
      candidateId: request.candidateId,
      packageVersionId: request.packageVersionId,
      scope: request.scope,
      consumedAt: request.now,
      sequence,
    };

    return { value: consumptionOk(receipt) };
  });
  if ("failure" in result) {
    return consumptionErr(result.failure.code, result.failure.message);
  }

  return result.value;
}

async function issueFromStore(
  ctx: StoreContext,
  input: GrantIssuanceInput,
): Promise<PermissionIssueOutcome> {
  const checked = checkGrantIssuance(input);
  if (!checked.ok) {
    return { ok: false, code: checked.code, message: checked.message };
  }

  const result = await ctx.withLock(async (events) => {
    const sequence = lastSequence(events) + 1;
    const grantId = deriveGrantId(input, sequence, ctx.storeId);

    await appendEvent(ctx.path, grantIssuedEvent({
      sequence,
      kind: "grant_issued",
      grantId,
      action: input.action,
      candidateId: input.candidateId,
      packageVersionId: input.packageVersionId,
      scope: input.scope,
      issuedAt: input.issuedAt,
      expiry: input.expiry,
    }));

    return { value: { ok: true as const, grant: { ...input, grantId, status: "active" as const } } };
  });
  if ("failure" in result) {
    return { ok: false, code: result.failure.code, message: result.failure.message };
  }

  return result.value;
}

async function revokeFromStore(
  ctx: StoreContext,
  grantId: string,
  now: string,
): Promise<PermissionRevokeOutcome> {
  if (!isNonEmptyString(grantId) || epochMs(now) === undefined) {
    return { ok: false, code: "invalid_token", message: "revoke needs a grantId and a strict ISO-8601 timestamp" };
  }

  const result = await ctx.withLock(async (events) => {
    const grant = resolveGrant(events, grantId);
    if (grant === undefined) {
      return { failure: { code: "unknown_grant" as const, message: `no grant ${grantId} in this Permission store` } };
    }

    if (grant.status !== "active") {
      return { value: { ok: true as const, grantId, status: grant.status } };
    }

    await appendEvent(ctx.path, grantRevokedEvent({
      sequence: lastSequence(events) + 1,
      kind: "grant_revoked",
      grantId,
      revokedAt: now,
    }));

    return { value: { ok: true as const, grantId, status: "revoked" as const } };
  });
  if ("failure" in result) {
    return { ok: false, code: result.failure.code, message: result.failure.message };
  }

  return result.value;
}

async function getGrantFromStore(
  ctx: StoreContext,
  grantId: string,
): Promise<PermissionGrantLookup> {
  let raw: string;

  try {
    raw = await readStoreText(ctx.path);
  } catch (error) {
    return { ok: false, code: "ledger_write_failed", message: describe(error) };
  }

  const decoded = decodeStoreLedger(raw);
  if (!decoded.ok) {
    return { ok: false, code: decoded.reason, message: decoded.detail };
  }

  return { ok: true, grant: resolveGrant(decoded.events, grantId) };
}

function lastSequence(events: readonly PermissionStoreEvent[]): number {
  const last = events[events.length - 1];
  return last === undefined ? 0 : last.sequence;
}

async function readStoreText(storePath: string): Promise<string> {
  try {
    return await readFile(storePath, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

/**
 * Append with a full-write loop (audit P1-5): `handle.write` may write fewer
 * bytes than requested; ignoring `bytesWritten` could silently truncate the
 * ledger and break the one-time-use guarantee.
 */
async function appendEvent(storePath: string, event: PermissionStoreEvent): Promise<void> {
  const line = encodeStoreEvent(event);
  const bytes = Buffer.from(line, "utf8");
  const handle = await open(storePath, "a");

  try {
    let written = 0;

    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
      if (bytesWritten <= 0) {
        throw new Error(`zero-byte write into permission store after ${String(written)} of ${String(bytes.length)} bytes`);
      }
      written += bytesWritten;
    }

    if (written !== bytes.length) {
      throw new Error(`partial write into permission store: ${String(written)} of ${String(bytes.length)} bytes`);
    }

    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Prove directory durability after first creation (audit P1-5). On POSIX the
 * directory fd can be fsynced; on Windows opening a directory fails with EPERM
 * and NTFS metadata journaling already makes entry creation durable, so the
 * attempt is skipped there instead of being silently pretended.
 */
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
    // Cleanup-only failure: the outcome is already recorded, and a leftover
    // lock file makes the next writer fail closed with ledger_lock_conflict.
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
