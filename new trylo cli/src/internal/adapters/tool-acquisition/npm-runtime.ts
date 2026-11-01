import path from "node:path";
import type { JsonValue } from "../../protocol/envelope.js";
import type { IsolationPort } from "../../ports/isolation.js";
import type { CandidateExecution } from "../../learning/domains/tool/evolution/execution.js";
import { decodeNpmToolProductionPlan, type NpmToolProductionPlan } from "../../learning/domains/tool/evolution/npm-production-plan.js";
import { isJsonValue, jsonBytes, keysAre, recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { npmInstallId } from "../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan } from "./npm-install-plan.js";
import { readNpmInstall } from "./npm-install-files.js";
import { npmBin } from "./npm-tree-package-check.js";
import { runNpmSnapshot } from "./npm-snapshot.js";
import type { NpmInstallTarget } from "../../tooling/contract/npm-tree.js";
import { contentHashOf } from "../../learning/control/hash.js";

export type NpmRuntimeOptions = { readonly installationRoot: string; readonly scratchRoot: string; readonly nodeExecutable: string; readonly isolation: IsolationPort; readonly target: NpmInstallTarget };

/** Fresh byte-verified package snapshot and a child without FS-write, subprocess, native-addon or secret grants. */
export async function executeNpmTool(raw: NpmToolProductionPlan, input: JsonValue, options: NpmRuntimeOptions, signal: AbortSignal): Promise<CandidateExecution> {
  if (signal.aborted) return { kind: "cancelled" };
  const plan = decodeNpmToolProductionPlan(raw);
  if (plan === undefined || decodeNpmInstallPlan(plan.installation) === undefined || contentHashOf(plan.installation.tree.target) !== contentHashOf(options.target)
    || !validInput(plan, input)) return { kind: "protocol_error", detail: "invalid frozen npm interface, host target or input" };
  try {
    const installed = await readNpmInstall(path.join(options.installationRoot, npmInstallId(plan.installation)), plan.installation);
    if (installed === undefined) return { kind: "unavailable", detail: "reviewed installation is missing" };
    const prefix = `${plan.installation.tree.root.location}/`, packageFiles = installed.files.filter(row => row.path.startsWith(prefix)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
    const manifestFile = packageFiles.find(row => row.path === "package.json");
    const manifest: unknown = manifestFile === undefined ? undefined : JSON.parse(Buffer.from(manifestFile.body).toString("utf8"));
    if (!recordOf(manifest) || npmBin(manifest, plan.runtime.bin, packageFiles) !== plan.runtime.entrypoint) return { kind: "protocol_error", detail: "npm bin is not the exact reviewed entrypoint" };
    return await runNpmSnapshot({ files: installed.files, entrypoint: `${plan.installation.tree.root.location}/${plan.runtime.entrypoint}`,
      runtime: plan.runtime, schema: plan.candidate.inputSchema, timeoutMs: plan.manifest.timeoutMs }, input, options, signal);
  } catch {
    return signal.aborted ? { kind: "cancelled" } : { kind: "unavailable", detail: "reviewed npm bytes, interface or confined runtime could not be established" };
  }
}
function validInput(plan: NpmToolProductionPlan, input: JsonValue): boolean {
  if (!isJsonValue(input) || jsonBytes(input) > 16_384 || !recordOf(input)) return false;
  return plan.runtime.profile !== "confined_npm_cli_v1" || (keysAre(input, ["argv", "stdin"]) && Array.isArray(input.argv) && input.argv.length <= 32
    && input.argv.every(arg => typeof arg === "string" && arg.length <= 1024 && !arg.includes("\0")) && typeof input.stdin === "string" && input.stdin.length <= 8192);
}
