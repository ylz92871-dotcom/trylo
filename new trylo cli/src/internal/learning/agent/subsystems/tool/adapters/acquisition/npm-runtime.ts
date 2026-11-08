import path from "node:path";
import type { JsonValue } from "../../../../../../protocol/envelope.js";
import type { IsolationPort } from "../../../../../../ports/isolation.js";
import type { CandidateExecution } from "../../domain/evolution/execution.js";
import { decodeNpmToolProductionPlan, type NpmToolProductionPlan } from "../../domain/evolution/npm-production-plan.js";
import { isJsonValue, jsonBytes, keysAre, recordOf } from "../../domain/evolution/parse.js";
import { npmInstallId } from "../../../../../../tooling/contract/npm-install.js";
import { decodeNpmInstallPlan } from "./npm-install-plan.js";
import { readNpmInstall } from "./npm-install-files.js";
import { npmBin } from "./npm-tree-package-check.js";
import { runNpmSnapshot } from "./npm-snapshot.js";
import type { NpmInstallTarget } from "../../../../../../tooling/contract/npm-tree.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { NPM_LIBRARY_ENTRYPOINT } from "../../domain/evolution/npm-adaptation.js";
import { adaptNpmFiles, NpmAdaptationError } from "./npm-adaptation-files.js";

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

    const files = adaptNpmFiles(plan, installed.files);

    if (plan.runtime.profile === "confined_npm_library_v1") return await runNpmSnapshot({ files, entrypoint: `node_modules/${NPM_LIBRARY_ENTRYPOINT}`,
      runtime: plan.runtime, schema: plan.candidate.inputSchema, timeoutMs: plan.manifest.timeoutMs }, input, options, signal);

    const prefix = `${plan.installation.tree.root.location}/`, packageFiles = installed.files.filter(row => row.path.startsWith(prefix)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
    const manifestFile = packageFiles.find(row => row.path === "package.json");
    const manifest: unknown = manifestFile === undefined ? undefined : JSON.parse(Buffer.from(manifestFile.body).toString("utf8"));
    if (!recordOf(manifest) || npmBin(manifest, plan.runtime.bin, packageFiles) !== plan.runtime.entrypoint) return { kind: "protocol_error", detail: "npm bin is not the exact reviewed entrypoint" };

    return await runNpmSnapshot({ files, entrypoint: `${plan.installation.tree.root.location}/${plan.runtime.entrypoint}`,
      runtime: plan.runtime, schema: plan.candidate.inputSchema, timeoutMs: plan.manifest.timeoutMs }, input, options, signal);
  } catch (error) {
    if (error instanceof NpmAdaptationError) return { kind: "protocol_error", detail: error.code };
    return signal.aborted ? { kind: "cancelled" } : { kind: "unavailable", detail: "reviewed npm bytes, interface or confined runtime could not be established" };
  }
}

function validInput(plan: NpmToolProductionPlan, input: JsonValue): boolean {
  if (!isJsonValue(input) || jsonBytes(input) > 16_384) return false;
  if (plan.runtime.profile === "confined_npm_library_v1") return true;
  if (!recordOf(input)) return false;
  return plan.runtime.profile !== "confined_npm_cli_v1" || (keysAre(input, ["argv", "stdin"]) && Array.isArray(input.argv) && input.argv.length <= 32
    && input.argv.every(arg => typeof arg === "string" && arg.length <= 1024 && !arg.includes("\0")) && typeof input.stdin === "string" && input.stdin.length <= 8192);
}
