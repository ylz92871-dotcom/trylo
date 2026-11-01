import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../../protocol/envelope.js";
import type { IsolationOutcome, IsolationPort } from "../../ports/isolation.js";
import type { CandidateExecution } from "../../learning/domains/tool/evolution/execution.js";
import type { NpmToolRuntime } from "../../learning/domains/tool/evolution/npm-production-plan.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { isJsonValue, jsonBytes, keysAre, recordOf } from "../../learning/domains/tool/evolution/parse.js";
import type { PackageFile } from "./ustar-reader.js";
import { materializeNpmFiles } from "./npm-install-files.js";
import { NPM_HARNESS } from "./npm-harness-source.js";
import { snapshotNpmMcpClient } from "./npm-runtime-files.js";
import { checkQuarantineAncestors, ensureQuarantineDirectory, isMissing } from "./quarantine-files.js";

export type NpmSnapshotOptions = { readonly scratchRoot: string; readonly nodeExecutable: string; readonly isolation: IsolationPort };
export type NpmSnapshot = { readonly files: readonly PackageFile[]; readonly entrypoint: string; readonly runtime: NpmToolRuntime; readonly schema: JsonValue; readonly timeoutMs: number; readonly operation?: "inspect_mcp" };

/** One launch mechanism shared by reviewed runtime packages and the checker's fixed adversarial probes. */
export async function runNpmSnapshot(snapshot: NpmSnapshot, input: JsonValue, options: NpmSnapshotOptions, signal: AbortSignal): Promise<CandidateExecution> {
  if (signal.aborted) return { kind: "cancelled" };
  if (!path.isAbsolute(options.scratchRoot) || !path.isAbsolute(options.nodeExecutable)) return { kind: "unavailable", detail: "managed npm runtime requires absolute owned scratch and Node paths" };
  let directory: string | undefined, result: CandidateExecution;
  try {
    const ready = await options.isolation.probe();
    if (signal.aborted) return { kind: "cancelled" };
    if (ready.state !== "ready") return { kind: "unavailable", detail: "required OS isolation is unavailable" };
    await checkQuarantineAncestors(options.scratchRoot); await ensureQuarantineDirectory(options.scratchRoot);
    directory = await mkdtemp(path.join(options.scratchRoot, "npm-run-"));
    // Once the directory exists, every outcome passes through the same private-data cleanup below.
    result = await invoke(snapshot, input, options, directory, signal);
  } catch {
    result = signal.aborted ? { kind: "cancelled" } : { kind: "unavailable", detail: "private npm snapshot or confined broker could not be established" };
  }
  if (directory !== undefined && !(await removeOwnedSnapshot(options.scratchRoot, directory))) return { kind: "unavailable", detail: "confined invocation ended but private snapshot cleanup failed; inspect the owned scratch before another attempt" };
  return result;
}
async function invoke(snapshot: NpmSnapshot, input: JsonValue, options: NpmSnapshotOptions, directory: string, signal: AbortSignal): Promise<CandidateExecution> {
  await materializeNpmFiles(directory, snapshot.files, signal);
  if (snapshot.runtime.profile === "confined_npm_mcp_v1") await snapshotNpmMcpClient(path.join(directory, "trylo"));
  await writeFile(path.join(directory, "harness.mjs"), NPM_HARNESS, { flag: "wx" });
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ node: options.nodeExecutable, cwd: directory, packageRoot: path.join(directory, "node_modules"),
    entrypoint: path.join(directory, ...snapshot.entrypoint.split("/")), runtime: snapshot.runtime, schema: snapshot.schema, input, operation: snapshot.operation }), { flag: "wx", mode: 0o600 });
  const result = await options.isolation.run({ argv: [options.nodeExecutable, "--no-warnings", "--permission", `--allow-fs-read=${directory}`, "--allow-child-process", path.join(directory, "harness.mjs")], cwd: directory,
    files: { writableRoots: [directory], denyReadPaths: [], denyWritePaths: [] }, network: { allowedDomains: [], deniedDomains: [], egressFenceVerified: true }, env: {}, timeoutMs: snapshot.timeoutMs, signal });
  return classify(result, signal);
}
async function removeOwnedSnapshot(root: string, directory: string): Promise<boolean> {
  try {
    const basename = path.basename(directory);
    if (path.dirname(path.resolve(directory)) !== path.resolve(root) || !/^npm-run-[A-Za-z0-9]{6}$/.test(basename)) return false;
    const info = await lstat(directory).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (info === undefined) return true;
    if (info.isSymbolicLink() || !info.isDirectory() || path.relative(await realpath(root), await realpath(directory)) !== basename) return false;
    // Both lexical ownership and resolved containment were checked before recursive deletion.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); return true;
  } catch { return false; }
}
function classify(result: IsolationOutcome, signal: AbortSignal): CandidateExecution {
  if (signal.aborted || result.outcome === "cancelled") return { kind: "cancelled" };
  if (result.outcome !== "completed" || result.cleanupFailure !== undefined) return { kind: "unavailable", detail: "required isolation start or cleanup failed" };
  if (result.timedOut) return { kind: "timeout", detail: "managed npm invocation exceeded its deadline" };
  if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 65_536 || Buffer.byteLength(result.stderr) > 65_536) return { kind: "protocol_error", detail: "trusted npm broker exit or capture failure" };
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { return { kind: "protocol_error", detail: "trusted npm broker returned no single bounded JSON result" }; }
  if (!isJsonValue(raw) || jsonBytes(raw) > 65_536 || !recordOf(raw)) return { kind: "protocol_error", detail: "invalid broker result" };
  if (raw.kind === "value" && keysAre(raw, ["kind", "value"])) return { kind: "value", value: raw.value! };
  if (raw.kind === "tool_error" && keysAre(raw, ["kind", "code"], ["diagnostics", "message"]) && typeof raw.code === "string" && raw.code.length <= 200
    && (raw.message === undefined || (typeof raw.message === "string" && raw.message.length <= 2048))) return { kind: "tool_error", code: raw.code, ...(raw.message === undefined ? {} : { message: raw.message }) };
  return { kind: "protocol_error", detail: `managed npm broker refused response ${contentHashOf(raw).slice(0, 12)}` };
}
