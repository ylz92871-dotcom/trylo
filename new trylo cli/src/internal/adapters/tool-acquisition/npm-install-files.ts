import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHashOf } from "../../learning/control/hash.js";
import { isIso8601 } from "../../ports/approval-consumption.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../../learning/domains/tool/evolution/parse.js";
import type { NpmInstallPlan, NpmInstallReceipt } from "../../tooling/contract/npm-install.js";
import { NPM_INSTALL_MAX_FILES } from "../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan, npmInstallId } from "./npm-install-plan.js";
import { boundedReadFile, checkQuarantineAncestors, isMissing, QuarantineFileError } from "./quarantine-files.js";
import { inspectNpmInstallContent, npmInstallFileIndex } from "./npm-install-content.js";
import { safePackagePath } from "./npm-quarantine-plan.js";
import { sha256Bytes } from "./npm-package-check.js";
import type { PackageFile } from "./ustar-reader.js";
import { publishNpmInstall, type NpmPublicationIo } from "./npm-install-publication.js";

const RECEIPT_LIMIT = 6 * 1024 * 1024;

/** Source archives, physical tree and receipt are atomically published together; failed stages are retained. */
export async function writeNpmInstall(root: string, receipt: NpmInstallReceipt, archives: ReadonlyMap<string, Uint8Array>, files: readonly PackageFile[], signal: AbortSignal, publicationIo?: NpmPublicationIo): Promise<void> {
  const stage = `${root}.staging`;
  try { await mkdir(stage); } catch { throw new QuarantineFileError("quarantine_busy"); }
  await mkdir(path.join(stage, ".archives"));
  for (const [location, body] of archives) {
    const review = receipt.plan.packages.find(row => row.location === location)?.review;
    if (review === undefined) throw new QuarantineFileError("quarantine_corrupt");
    const file = path.join(stage, ".archives", `${review.sha256}.tgz`);
    try { await writeFile(file, body, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  await materializeNpmFiles(stage, files, signal);
  const handle = await open(path.join(stage, "receipt.json"), "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); } finally { await handle.close(); }
  if (signal.aborted) throw new QuarantineFileError("quarantine_unavailable");
  await publishNpmInstall(root, signal, publicationIo);
}

/** A completed interrupted stage is reusable only after the same original-archive and physical-byte checks. */
export async function readNpmInstallStaging(destination: string, expected?: NpmInstallPlan) {
  const stage = `${destination}.staging`;
  await checkQuarantineAncestors(path.dirname(stage));
  const info = await lstat(stage).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (info === undefined) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  const receipt = await lstat(path.join(stage, "receipt.json")).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (receipt === undefined) throw new QuarantineFileError("quarantine_busy");
  return readNpmInstall(stage, expected);
}

export async function materializeNpmFiles(root: string, files: readonly PackageFile[], signal: AbortSignal): Promise<void> {
  for (const file of files) {
    if (signal.aborted) throw new QuarantineFileError("quarantine_unavailable");
    if (!safePackagePath(file.path)) throw new QuarantineFileError("quarantine_corrupt");
    const absolute = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.body, { flag: "wx", mode: 0o600 });
  }
}

/** Each reuse revalidates original archives and every physical byte, never merely trusting receipt checksums. */
export async function readNpmInstall(root: string, expected?: NpmInstallPlan) {
  await checkQuarantineAncestors(path.dirname(root));
  const info = await lstat(root).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (info === undefined) return undefined;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  const receiptPath = path.join(root, "receipt.json"); await requireFile(receiptPath, RECEIPT_LIMIT);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedReadFile(receiptPath, RECEIPT_LIMIT))); }
  catch { throw new QuarantineFileError("quarantine_corrupt"); }
  const receipt = decodeReceipt(raw);
  if (receipt === undefined || (expected !== undefined && contentHashOf(receipt.plan) !== contentHashOf(expected))) throw new QuarantineFileError("quarantine_corrupt");
  const archiveRoot = path.join(root, ".archives"), archiveInfo = await lstat(archiveRoot);
  if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  const archives = new Map<string, Uint8Array>(); let compressed = 0;
  for (const item of receipt.plan.packages) {
    const file = path.join(archiveRoot, `${item.review.sha256}.tgz`); await requireFile(file, 64 * 1024 * 1024);
    const body = await boundedReadFile(file, 64 * 1024 * 1024); compressed += body.length;
    if (compressed > 64 * 1024 * 1024) throw new QuarantineFileError("quarantine_corrupt");
    archives.set(item.location, body);
  }
  if ((await readdir(archiveRoot)).length !== new Set(receipt.plan.packages.map(row => row.review.sha256)).size) throw new QuarantineFileError("quarantine_corrupt");
  const files = inspectNpmInstallContent(receipt.plan, archives);
  if (contentHashOf(receipt.files) !== contentHashOf(npmInstallFileIndex(files))) throw new QuarantineFileError("quarantine_corrupt");
  const found = await walk(root);
  if (found.size !== files.length) throw new QuarantineFileError("quarantine_corrupt");
  for (const file of receipt.files) {
    const actual = found.get(file.path);
    if (actual === undefined) throw new QuarantineFileError("quarantine_corrupt");
    await requireFile(actual, file.bytes);
    if (sha256Bytes(await boundedReadFile(actual, file.bytes)) !== file.sha256) throw new QuarantineFileError("quarantine_corrupt");
  }
  return { receipt, files };
}

function decodeReceipt(raw: unknown): NpmInstallReceipt | undefined {
  if (!isJsonValue(raw, 48) || !recordOf(raw) || !keysAre(raw, ["type", "schemaVersion", "planId", "plan", "acquiredAt", "approvalGrantId", "verification", "files"])
    || raw.type !== "npm_install_receipt" || raw.schemaVersion !== 1 || !textOf(raw.acquiredAt, 64) || !isIso8601(raw.acquiredAt)
    || !textOf(raw.approvalGrantId, 200) || raw.verification !== "not_production_verified" || !Array.isArray(raw.files) || raw.files.length > NPM_INSTALL_MAX_FILES) return undefined;
  const plan = decodeNpmInstallPlan(raw.plan);
  if (plan === undefined || raw.planId !== npmInstallId(plan)) return undefined;
  // File rows are compared with a freshly derived archive index before they are used as paths or limits.
  return structuredClone(raw) as NpmInstallReceipt;
}
async function requireFile(file: string, limit: number): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new QuarantineFileError("quarantine_corrupt");
}
async function walk(root: string, prefix = "", found = new Map<string, string>(), budget = { nodes: 0 }): Promise<Map<string, string>> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (prefix === "" && ["receipt.json", ".archives"].includes(entry.name)) continue;
    if (++budget.nodes > NPM_INSTALL_MAX_FILES * 2) throw new QuarantineFileError("quarantine_corrupt");
    const relative = prefix + entry.name, absolute = path.join(root, entry.name);
    if (!safePackagePath(relative) || entry.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
    if (entry.isDirectory()) await walk(absolute, `${relative}/`, found, budget);
    else if (entry.isFile()) found.set(relative, absolute);
    else throw new QuarantineFileError("quarantine_corrupt");
  }
  return found;
}
