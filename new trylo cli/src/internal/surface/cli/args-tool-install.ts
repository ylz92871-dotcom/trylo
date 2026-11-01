import type { RunCommandOptions } from "./args.js";
import { DEFAULT_MCP_PROTOCOL_VERSION, isSupportedProtocolVersion, type McpProtocolVersion } from "../../ports/mcp-client.js";

export type ToolInstallCommand =
  | { readonly kind: "install-plan"; readonly requestFile: string }
  | { readonly kind: "install"; readonly requestFile: string; readonly approvedPlanId: string }
  | { readonly kind: "install-show"; readonly planId: string }
  | { readonly kind: "install-inspect"; readonly planId: string; readonly bin: string; readonly protocolVersion: McpProtocolVersion; readonly run: RunCommandOptions }
  | { readonly kind: "install-production"; readonly planId: string; readonly interfaceFile: string; readonly checksFile: string };

export function parseToolInstall(argv: readonly string[]): ToolInstallCommand | { readonly kind: "error"; readonly message: string } | undefined {
  const kind = argv[0];
  if (!["install-plan", "install", "install-show", "install-inspect", "install-production"].includes(kind ?? "")) return undefined;
  const tokens = argv.slice(1).filter(token => token !== "--json"), first = tokens[0];
  if (kind === "install-inspect") return parseInspection(tokens);
  if (kind === "install-plan" && tokens.length === 1 && position(first)) return { kind, requestFile: first };
  if (kind === "install" && tokens.length === 3 && position(first) && tokens[1] === "--approve" && id(tokens[2])) return { kind, requestFile: first, approvedPlanId: tokens[2] };
  if (kind === "install-show" && tokens.length === 1 && id(first)) return { kind, planId: first };
  if (kind === "install-production" && tokens.length === 3 && id(first) && position(tokens[1]) && position(tokens[2])) return { kind, planId: first, interfaceFile: tokens[1], checksFile: tokens[2] };
  return { kind: "error", message: `${kind} requires an exact reviewed installation request or ID; install requires --approve npm-install_v1_<digest>` };
}
export function isToolInstallCommand(value: { readonly kind: string }): value is ToolInstallCommand {
  return ["install-plan", "install", "install-show", "install-inspect", "install-production"].includes(value.kind);
}
function parseInspection(tokens: readonly string[]): ToolInstallCommand | { readonly kind: "error"; readonly message: string } {
  const values: Record<string, string> = {};
  for (let index = 2; index < tokens.length; index += 2) {
    const flag = tokens[index]!, value = tokens[index + 1];
    if (!["--protocol", "--allow-tools"].includes(flag) || value === undefined || values[flag] !== undefined) return { kind: "error", message: "install-inspect accepts only --protocol and --allow-tools run_shell" };
    values[flag] = value;
  }
  const protocolVersion = values["--protocol"] ?? DEFAULT_MCP_PROTOCOL_VERSION, bin = tokens[1];
  if (!id(tokens[0]) || !position(bin) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(bin) || !isSupportedProtocolVersion(protocolVersion)
    || (values["--allow-tools"] !== undefined && values["--allow-tools"] !== "run_shell")) return { kind: "error", message: "install-inspect needs exact planId, npm bin, supported protocol and ordinary execution permission" };
  return { kind: "install-inspect", planId: tokens[0], bin, protocolVersion, run: { message: [], readStdin: false,
    ...(values["--allow-tools"] === undefined ? {} : { allowTools: ["run_shell"] }) } };
}
function position(value: string | undefined): value is string { return value !== undefined && value.trim().length > 0 && !value.startsWith("-"); }
function id(value: string | undefined): value is string { return value !== undefined && /^npm-install_v1_[a-f0-9]{64}$/.test(value); }
