import path from "node:path";
import type { CandidateExecution } from "../../learning/domains/tool/evolution/execution.js";
import type { NpmInstallPlan } from "../../tooling/contract/npm-install.js";
import { npmInstallId } from "../../tooling/contract/npm-install.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { McpProtocolVersion } from "../../ports/mcp-client.js";
import { isSupportedProtocolVersion } from "../../ports/mcp-client.js";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { decodeNpmInstallPlan } from "./npm-install-plan.js";
import { readNpmInstall } from "./npm-install-files.js";
import { npmBin } from "./npm-tree-package-check.js";
import { runNpmSnapshot } from "./npm-snapshot.js";
import type { NpmRuntimeOptions } from "./npm-runtime.js";

/** Explicit authorized inspection is not verification, a tool call, a signed receipt or activation. */
export async function inspectInstalledNpmMcp(plan: NpmInstallPlan, bin: string, protocolVersion: McpProtocolVersion, options: NpmRuntimeOptions, signal: AbortSignal): Promise<CandidateExecution> {
  if (signal.aborted) return { kind: "cancelled" };
  if (decodeNpmInstallPlan(plan) === undefined || contentHashOf(plan.tree.target) !== contentHashOf(options.target) || !isSupportedProtocolVersion(protocolVersion)) return { kind: "protocol_error", detail: "invalid exact installation, host target or MCP revision" };
  try {
    const installed = await readNpmInstall(path.join(options.installationRoot, npmInstallId(plan)), plan);
    if (installed === undefined) return { kind: "unavailable", detail: "reviewed installation is missing" };
    const prefix = `${plan.tree.root.location}/`, files = installed.files.filter(row => row.path.startsWith(prefix)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
    const file = files.find(row => row.path === "package.json"), manifest: unknown = file === undefined ? undefined : JSON.parse(Buffer.from(file.body).toString("utf8"));
    const entrypoint = recordOf(manifest) ? npmBin(manifest, bin, files) : undefined;
    if (entrypoint === undefined) return { kind: "protocol_error", detail: "bin is not an actual frozen package entrypoint" };
    return await runNpmSnapshot({ files: installed.files, entrypoint: `${plan.tree.root.location}/${entrypoint}`, runtime: { profile: "confined_npm_mcp_v1", bin, entrypoint, toolName: "inspection_only", protocolVersion },
      schema: {}, timeoutMs: 15_000, operation: "inspect_mcp" }, {}, options, signal);
  } catch { return signal.aborted ? { kind: "cancelled" } : { kind: "unavailable", detail: "reviewed installation inspection could not be established" }; }
}
