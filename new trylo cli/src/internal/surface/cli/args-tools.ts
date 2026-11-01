import type { Platform } from "../../adapters/tool-acquisition/allowlist.js";
import type { RunCommandOptions } from "./args-primitives.js";
import { TOOL_EVOLUTION_MAX_GENERATION_MS } from "../../learning/domains/tool/evolution/contracts.js";
import { parseRun } from "./args-run.js";
import { parseToolCycle, type ToolCycleCommand } from "./args-tool-cycle.js";
import { parseToolAcquire, type ToolAcquireCommand } from "./args-tool-acquire.js";
import { parseToolProduction, type ToolProductionCommand } from "./args-tool-production.js";
import { parseToolInstall, type ToolInstallCommand } from "./args-tool-install.js";

export const TOOLS_USAGE = [
  "trylo tools search <capability> [--platform github|npm|pypi|mcp_registry] [--json]",
  "trylo tools acquire-plan <request.json> [--json]  review exact-byte npm quarantine only",
  "trylo tools acquire <request.json> --approve <planId> [--json]  download and unpack; never execute or activate",
  "trylo tools install-plan <request.json> [--json]  review complete exact npm runtime dependency closure",
  "trylo tools install <request.json> --approve <planId> [--json]  private byte-verified install, no hooks/execution/activation",
  "trylo tools install-show <planId> [--json]  revalidate source archives and every physical file",
  "trylo tools install-inspect <planId> <bin> [--protocol 2025-03-26|2024-11-05] [--allow-tools run_shell] [--json]  confined MCP initialize/list only",
  "trylo tools install-production <planId> <interface.json> <checks.json> [--json]  freeze a plan for existing production-verify/activate commands",
  "trylo tools evolve <request.json> [--provider <id>] [--model <id>] [--endpoint <url>] [--generation-timeout-ms <1..300000>] [--allow-tools run_shell] [--json]",
  "trylo tools candidates [--json]",
  "trylo tools recipe <request.json> [--auto] [--workspace] [--json]  freeze caller-owned checks; --auto opts into post-turn generation",
  "trylo tools recipes | jobs [--json]",
  "trylo tools status [--json]  bounded workspace projection for Desktop",
  "trylo tools production-list [--json]  bounded workspace production inventory for Desktop",
  "trylo tools queue <capability> [--scope id] [--json]",
  "trylo tools expire <jobId> [--json]  close an inspected lost worker without retrying",
  "trylo tools work [--scope id] [--max-jobs 1..3] [--provider id] [--model id] [--allow-tools run_shell] [--json]",
  "trylo tools trial <versionId> <request.json> [--allow-tools run_shell] [--json]",
  "trylo tools trials <versionId> [--json]",
  "trylo tools use <versionId> -- [run options] <message>  lend one experimental tool to this task",
  "trylo tools uses <versionId> [--json]  read actual use facts (quality remains unverified)",
  "trylo tools withdraw <versionId> [--json]  refuse subsequent experimental use of a lab candidate",
  "trylo tools improve <versionId> <request.json> [--provider <id>] [--model <id>] [--generation-timeout-ms <1..300000>] [--allow-tools run_shell] [--json]",
  "trylo tools production-plan <candidateVersion> <fresh-checks.json> --license MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD [--json]",
  "trylo tools production-verify <version> [--allow-tools run_shell] [--json]  run confined checks; never activates",
  "trylo tools production-show <version> [--json]  review source, receipt and exact activation reviewId",
  "trylo tools production-expire <version> <jobId> [--json]  close an inspected lost check without retrying",
  "trylo tools production-activate <version> --approve <reviewId> [--json]  explicitly enable or resume this exact workspace version",
  "trylo tools production-suspend | production-withdraw | production-rollback <version> [--json]",
  "Experimental candidates and acquired packages stay quarantined until independently verified and explicitly enabled.",
].join("\n");

export type ToolLabCommand =
  | ToolCycleCommand
  | ToolAcquireCommand
  | ToolProductionCommand
  | ToolInstallCommand
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "candidates" }
  | { readonly kind: "trials"; readonly versionId: string }
  | { readonly kind: "uses"; readonly versionId: string }
  | { readonly kind: "withdraw"; readonly versionId: string }
  | { readonly kind: "use"; readonly versionId: string; readonly run: RunCommandOptions }
  | { readonly kind: "trial"; readonly versionId: string; readonly requestFile: string; readonly run: RunCommandOptions }
  | { readonly kind: "improve"; readonly versionId: string; readonly requestFile: string; readonly run: RunCommandOptions; readonly generationTimeoutMs?: number }
  | { readonly kind: "search"; readonly capability: string; readonly platforms?: readonly Platform[] }
  | { readonly kind: "evolve"; readonly requestFile: string; readonly run: RunCommandOptions; readonly generationTimeoutMs?: number };

export function parseTools(argv: readonly string[]): ToolLabCommand {
  const action = argv[0];
  if (action === undefined || argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const install = parseToolInstall(argv);
  if (install !== undefined) return install;
  const acquire = parseToolAcquire(argv);
  if (acquire !== undefined) return acquire;
  const cycle = parseToolCycle(argv);
  if (cycle !== undefined) return cycle;
  const production = parseToolProduction(argv);
  if (production !== undefined) return production;
  if (action === "use") return parseUse(argv.slice(1));
  const tokens = argv.slice(1).filter(token => token !== "--json");
  if (action === "candidates") return tokens.length === 0 ? { kind: "candidates" } : { kind: "error", message: "candidates accepts only --json" };
  if (action === "search") return parseSearch(tokens);
  if (action === "trials") return tokens.length === 1 && position(tokens[0]) ? { kind: "trials", versionId: tokens[0] } : { kind: "error", message: "trials needs one versionId" };
  if (action === "uses") return tokens.length === 1 && position(tokens[0]) ? { kind: "uses", versionId: tokens[0] } : { kind: "error", message: "uses needs one versionId" };
  if (action === "withdraw") return tokens.length === 1 && position(tokens[0]) ? { kind: "withdraw", versionId: tokens[0] } : { kind: "error", message: "withdraw needs one versionId" };
  if (action !== "evolve" && action !== "trial" && action !== "improve") return { kind: "error", message: "expected tools search, evolve, candidates, trial, trials, or improve" };
  const offset = action === "evolve" ? 1 : 2;
  const versionId = tokens[0];
  const requestFile = tokens[offset - 1];
  if (!position(requestFile) || (action !== "evolve" && (!position(versionId) || versionId.length > 160))) return { kind: "error", message: `${action} needs ${action === "evolve" ? "request.json" : "versionId and request.json"}` };
  const values: Record<string, string> = {};
  const accepted = new Set(action === "trial" ? ["--allow-tools"] : ["--provider", "--model", "--endpoint", "--allow-tools", "--generation-timeout-ms"]);
  for (let index = offset; index < tokens.length; index += 2) {
    const flag = tokens[index] ?? "";
    const value = tokens[index + 1];
    if (!accepted.has(flag) || value === undefined || value.trim().length === 0 || value.startsWith("-") || values[flag] !== undefined
      || (flag === "--allow-tools" && value.split(",").some(name => name.trim().length === 0))) return { kind: "error", message: `invalid or repeated tools evolve option ${flag}` };
    values[flag] = value;
  }
  const timeout = values["--generation-timeout-ms"];
  if (timeout !== undefined && (!/^\d+$/.test(timeout) || Number(timeout) <= 0 || Number(timeout) > TOOL_EVOLUTION_MAX_GENERATION_MS)) return { kind: "error", message: "generation timeout must be an integer in 1..300000 ms" };
  const generation = timeout === undefined ? {} : { generationTimeoutMs: Number(timeout) };
  const run: RunCommandOptions = {
    message: [], readStdin: false,
    ...(values["--provider"] === undefined ? {} : { provider: values["--provider"] }),
    ...(values["--model"] === undefined ? {} : { model: values["--model"] }),
    ...(values["--endpoint"] === undefined ? {} : { endpoint: values["--endpoint"] }),
    ...(values["--allow-tools"] === undefined ? {} : { allowTools: values["--allow-tools"].split(",").map(name => name.trim()) }),
  };
  if (action === "trial") return { kind: "trial", versionId: versionId as string, requestFile, run };
  return action === "evolve" ? { kind: "evolve", requestFile, run, ...generation } : { kind: "improve", versionId: versionId as string, requestFile, run, ...generation };
}

function position(value: string | undefined): value is string { return value !== undefined && value.trim().length > 0 && !value.startsWith("-"); }

function parseUse(tokens: readonly string[]): ToolLabCommand {
  if (!position(tokens[0]) || tokens[0].length > 160 || tokens[1] !== "--" || tokens.length < 3) return { kind: "error", message: "use needs versionId -- [run options] message" };
  const run = parseRun(tokens.slice(2));
  if (run.kind !== "run") return { kind: "error", message: "use expects ordinary one-shot run options" };
  if (run.options.session !== undefined || run.options.resume !== undefined || run.options.resumeLast === true || run.options.subagent === true
    || run.options.provider === "fixture-subagent" || run.options.permissionPromptTool !== undefined) return { kind: "error", message: "experimental tool use requires an ephemeral one-shot run without subagent or stdio session control" };
  return { kind: "use", versionId: tokens[0], run: run.options };
}

function parseSearch(tokens: readonly string[]): ToolLabCommand {
  const capability = tokens[0]?.trim();
  if (capability === undefined || capability.length === 0 || capability.startsWith("-")) return { kind: "error", message: "search needs a quoted capability" };
  const platforms: Platform[] = [];
  for (let index = 1; index < tokens.length; index += 2) {
    const platform = tokens[index + 1];
    if (tokens[index] !== "--platform" || !isPlatform(platform)) return { kind: "error", message: "--platform must name github, npm, pypi, or mcp_registry" };
    if (!platforms.includes(platform)) platforms.push(platform);
  }
  return { kind: "search", capability, ...(platforms.length === 0 ? {} : { platforms }) };
}

function isPlatform(value: string | undefined): value is Platform {
  return value === "github" || value === "npm" || value === "pypi" || value === "mcp_registry";
}
