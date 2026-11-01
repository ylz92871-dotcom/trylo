import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHashOf } from "../../learning/control/hash.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../../learning/domains/tool/evolution/parse.js";
import { decodeNpmQuarantinePlan, quarantinePlanId, safePackagePath, type NpmQuarantinePlan } from "./npm-quarantine-plan.js";
import { sha256Bytes } from "./npm-package-check.js";
import type { PackageFile } from "./ustar-reader.js";
import { isIso8601 } from "../../ports/approval-consumption.js";

export class QuarantineFileError extends Error {
  constructor(readonly code: "quarantine_unavailable" | "quarantine_corrupt" | "quarantine_busy") { super(code); }
}
export type NpmQuarantineReceipt = {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly plan: NpmQuarantinePlan;
  readonly acquiredAt: string;
  readonly approvalGrantId: string;
  readonly verification: "not_production_verified";
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
};

/** Only directories in our owned quarantine subtree; never follow a stored reparse point. */
export async function ensureQuarantineDirectory(root: string): Promise<void> {
  const parent = path.dirname(root);
  if (parent !== root) {
    const info = await lstat(parent).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (info === undefined) await ensureQuarantineDirectory(parent);
    else if (info.isSymbolicLink() || !info.isDirectory()) throw new QuarantineFileError("quarantine_unavailable");
  }
  try { await mkdir(root); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new QuarantineFileError("quarantine_unavailable");
}

export async function checkQuarantineAncestors(root: string): Promise<void> {
  for (let current = path.resolve(root);;) {
    const info = await lstat(current).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (info !== undefined && (info.isSymbolicLink() || !info.isDirectory())) throw new QuarantineFileError("quarantine_unavailable");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function readNpmQuarantine(root: string, plan: NpmQuarantinePlan): Promise<NpmQuarantineReceipt | undefined> {
  const info = await lstat(root).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (info === undefined) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  const receiptPath = path.join(root, "receipt.json"), receiptInfo = await lstat(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 262_144) throw new QuarantineFileError("quarantine_corrupt");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedReadFile(receiptPath, 262_144))); } catch { throw new QuarantineFileError("quarantine_corrupt"); }
  const receipt = decodeReceipt(value);
  if (receipt === undefined || receipt.planId !== quarantinePlanId(plan) || contentHashOf(receipt.plan) !== contentHashOf(plan)) throw new QuarantineFileError("quarantine_corrupt");
  const found = await walkFiles(path.join(root, "package"));
  if (found.size !== receipt.files.length) throw new QuarantineFileError("quarantine_corrupt");
  for (const file of receipt.files) {
    const absolute = found.get(file.path);
    if (absolute === undefined) throw new QuarantineFileError("quarantine_corrupt");
    const fileInfo = await lstat(absolute);
    if (fileInfo.size !== file.bytes || sha256Bytes(await boundedReadFile(absolute, file.bytes)) !== file.sha256) throw new QuarantineFileError("quarantine_corrupt");
  }
  return receipt;
}

/** Atomic publication of a complete private tree. Failed staging is retained for inspection. */
export async function writeNpmQuarantine(root: string, receipt: NpmQuarantineReceipt, files: readonly PackageFile[], signal: AbortSignal): Promise<void> {
  const stage = `${root}.staging`;
  try { await mkdir(stage); }
  catch { throw new QuarantineFileError("quarantine_busy"); }
  await mkdir(path.join(stage, "package"));
  for (const file of files) {
    if (signal.aborted) throw new QuarantineFileError("quarantine_unavailable");
    const absolute = path.join(stage, "package", ...file.path.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.body, { flag: "wx", mode: 0o600 });
  }
  const handle = await open(path.join(stage, "receipt.json"), "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); } finally { await handle.close(); }
  if (signal.aborted) throw new QuarantineFileError("quarantine_unavailable");
  await rename(stage, root);
}

export async function lockNpmQuarantine(root: string): Promise<() => Promise<void>> {
  const lockPath = `${root}.lock`;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch { throw new QuarantineFileError("quarantine_busy"); }
  return async () => { await handle.close(); await unlink(lockPath); };
}

function decodeReceipt(value: unknown): NpmQuarantineReceipt | undefined {
  if (!isJsonValue(value) || !recordOf(value) || !keysAre(value, ["schemaVersion", "planId", "plan", "acquiredAt", "approvalGrantId", "verification", "files"])
    || value.schemaVersion !== 1 || !textOf(value.planId, 100) || decodeNpmQuarantinePlan(value.plan) === undefined || !textOf(value.acquiredAt, 64) || !isIso8601(value.acquiredAt)
    || !textOf(value.approvalGrantId, 200) || value.verification !== "not_production_verified" || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 256) return undefined;
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!recordOf(file) || !keysAre(file, ["path", "sha256", "bytes"]) || typeof file.path !== "string" || !safePackagePath(file.path)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0 || paths.has(file.path.toLowerCase())) return undefined;
    bytes += file.bytes; paths.add(file.path.toLowerCase());
    if (bytes > 10_000_000) return undefined;
  }
  return structuredClone(value) as NpmQuarantineReceipt;
}
async function walkFiles(root: string, prefix = "", result = new Map<string, string>(), budget = { nodes: 0 }): Promise<Map<string, string>> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (++budget.nodes > 512) throw new QuarantineFileError("quarantine_corrupt");
    const relative = `${prefix}${item.name}`, absolute = path.join(root, item.name);
    if (!safePackagePath(relative) || item.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
    if (item.isDirectory()) await walkFiles(absolute, `${relative}/`, result, budget);
    else if (item.isFile()) result.set(relative, absolute);
    else throw new QuarantineFileError("quarantine_corrupt");
    if (result.size > 256) throw new QuarantineFileError("quarantine_corrupt");
  }
  return result;
}
export async function boundedReadFile(file: string, limit: number): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > limit) throw new QuarantineFileError("quarantine_corrupt");
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
export function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
