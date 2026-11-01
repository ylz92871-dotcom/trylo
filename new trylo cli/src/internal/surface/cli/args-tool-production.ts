import { isToolProductionLicense, type ToolProductionLicense } from "../../learning/domains/tool/evolution/production-plan.js";
import type { RunCommandOptions } from "./args-primitives.js";

export type ToolProductionCommand =
  | { readonly kind: "production-list" }
  | { readonly kind: "production-plan"; readonly originVersionId: string; readonly checksFile: string; readonly license: ToolProductionLicense }
  | { readonly kind: "production-show"; readonly versionId: string }
  | { readonly kind: "production-expire"; readonly versionId: string; readonly jobId: string }
  | { readonly kind: "production-verify"; readonly versionId: string; readonly run: RunCommandOptions }
  | { readonly kind: "production-activate"; readonly versionId: string; readonly reviewId: string }
  | { readonly kind: "production-suspend" | "production-withdraw" | "production-rollback"; readonly versionId: string };

export function isToolProductionCommand(value: { readonly kind: string }): value is ToolProductionCommand {
  return ["production-list", "production-plan", "production-show", "production-verify", "production-expire", "production-activate", "production-suspend", "production-withdraw", "production-rollback"].includes(value.kind);
}

export function parseToolProduction(argv: readonly string[]): ToolProductionCommand | { readonly kind: "error"; readonly message: string } | undefined {
  const kind = argv[0];
  if (kind === undefined || !kind.startsWith("production-")) return undefined;
  const tokens = argv.slice(1).filter(item => item !== "--json");
  if (kind === "production-list" && tokens.length === 0) return { kind };
  const position = (value: string | undefined): value is string => value !== undefined && value.trim().length > 0 && !value.startsWith("-") && value.length <= 512;
  if (kind === "production-plan" && tokens.length === 4 && position(tokens[0]) && position(tokens[1]) && tokens[2] === "--license" && isToolProductionLicense(tokens[3])) {
    return { kind, originVersionId: tokens[0], checksFile: tokens[1], license: tokens[3] };
  }
  if (["production-show", "production-suspend", "production-withdraw", "production-rollback"].includes(kind) && tokens.length === 1 && position(tokens[0])) {
    return { kind: kind as "production-show" | "production-suspend" | "production-withdraw" | "production-rollback", versionId: tokens[0] };
  }
  if (kind === "production-activate" && tokens.length === 3 && position(tokens[0]) && tokens[1] === "--approve" && position(tokens[2])) return { kind, versionId: tokens[0], reviewId: tokens[2] };
  if (kind === "production-expire" && tokens.length === 2 && position(tokens[0]) && position(tokens[1])) return { kind, versionId: tokens[0], jobId: tokens[1] };
  if (kind === "production-verify" && position(tokens[0]) && (tokens.length === 1 || (tokens.length === 3 && tokens[1] === "--allow-tools" && tokens[2] === "run_shell"))) {
    return { kind, versionId: tokens[0], run: { message: [], readStdin: false, ...(tokens.length === 1 ? {} : { allowTools: ["run_shell"] }) } };
  }
  return { kind: "error", message: "invalid production command; plan needs originVersion checks.json --license SPDX; activate needs version --approve reviewId" };
}
