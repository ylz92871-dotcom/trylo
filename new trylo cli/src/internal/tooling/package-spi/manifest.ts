import { err, ok, type Result } from "../contract/result.js";
import type { ToolPackageManifest, ToolPackageVersion } from "../contract/types.js";
import { safePackagePath } from "../contract/npm-source.js";

export type ManifestFailure =
  | "missing_cancel"
  | "missing_timeout"
  | "missing_health"
  | "missing_idempotency"
  | "missing_output_bounds"
  | "postinstall_not_forbidden"
  | "not_isolated"
  | "unsupported_runtime_profile"
  | "json_profile_not_pure"
  | "invalid_entrypoint"
  | "overwrite_forbidden"
  | "third_party_type_leak";

export function validateManifest(
  manifest: ToolPackageManifest,
): Result<ToolPackageManifest, ManifestFailure> {
  if (manifest.healthProbe !== true) {
    return err("missing_health", "package SPI requires a health probe");
  }
  if (manifest.cancelSupported !== true) {
    return err("missing_cancel", "package SPI requires cancel support");
  }
  if (manifest.timeoutMs <= 0) {
    return err("missing_timeout", "package SPI requires a positive timeout");
  }
  if (manifest.idempotencyKeyRequired !== true || manifest.sideEffectCommitPoint.length === 0) {
    return err("missing_idempotency", "package SPI requires idempotency and a side-effect commit point");
  }
  if (manifest.stdoutBytes <= 0 || manifest.stderrBytes <= 0 || manifest.resultChars <= 0) {
    return err("missing_output_bounds", "package SPI requires output bounds");
  }
  if (manifest.postinstall !== "forbidden") {
    return err("postinstall_not_forbidden", "postinstall is forbidden by default");
  }
  if (manifest.processIsolation !== true) {
    return err("not_isolated", "learned tools require a confined process");
  }
  const profile = validateRuntimeProfile(manifest);
  if (!profile.ok) {
    return profile;
  }
  if (manifest.thirdPartyTypes !== "isolated") {
    return err("third_party_type_leak", "third-party types must not leak into Trylo core");
  }
  return ok(manifest);
}

function validateRuntimeProfile(manifest: ToolPackageManifest): Result<ToolPackageManifest, ManifestFailure> {
  if (manifest.runtimeProfile === "confined_npm_cli_v1" || manifest.runtimeProfile === "confined_npm_mcp_v1") {
    if (manifest.moduleFormat !== "node_package" || manifest.inputTransport !== (manifest.runtimeProfile === "confined_npm_cli_v1" ? "argv_stdin" : "mcp_stdio")
      || "mcpTransport" in manifest || "mcpSchemaVersion" in manifest) return err("unsupported_runtime_profile", "managed Node packages require their explicit CLI or MCP broker ABI");
    if (!safePackagePath(manifest.entrypoint)) return err("invalid_entrypoint", "managed Node entrypoint must be a relative package file");
    return validateNoIoBounds(manifest);
  }
  if (manifest.runtimeProfile === "confined_json_function_v1") {
    if (manifest.moduleFormat !== "commonjs" || manifest.inputTransport !== "json"
      || "mcpTransport" in manifest || "mcpSchemaVersion" in manifest) {
      return err("unsupported_runtime_profile", "a JSON script cannot claim the MCP transport contract");
    }
    if (manifest.entrypoint !== "candidate.cjs") return err("invalid_entrypoint", "the confined JSON profile has one fixed script entrypoint");
    return validateNoIoBounds(manifest);
  }
  if (manifest.runtimeProfile !== undefined && manifest.runtimeProfile !== "mcp_stdio") {
    return err("unsupported_runtime_profile", "unknown tool runtime profile");
  }
  return manifest.mcpTransport === "stdio" ? ok(manifest) : err("not_isolated", "MCP tools require stdio process isolation");
}
function validateNoIoBounds(manifest: ToolPackageManifest): Result<ToolPackageManifest, ManifestFailure> {
  if (manifest.permissions.length !== 0 || manifest.envWhitelist.length !== 0 || manifest.secretsWhitelist.length !== 0
    || manifest.cwdWhitelist.length !== 0 || manifest.sideEffectCommitPoint !== "none") return err("json_profile_not_pure", "confined pure profiles grant no workspace filesystem, environment, network or secret access");
  if (![manifest.timeoutMs, manifest.stdoutBytes, manifest.stderrBytes, manifest.resultChars].every(Number.isSafeInteger)
    || manifest.timeoutMs > 60_000 || manifest.stdoutBytes > 65_536 || manifest.stderrBytes > 65_536 || manifest.resultChars > 32_768) return err("missing_output_bounds", "confined runtime bounds exceeded");
  return ok(manifest);
}

export function assertNewVersion(
  previous: ToolPackageVersion | undefined,
  next: ToolPackageVersion,
): Result<ToolPackageVersion, ManifestFailure> {
  if (previous !== undefined && previous.packageVersionId === next.packageVersionId) {
    return err("overwrite_forbidden", "package updates must create a new version id");
  }
  if (previous !== undefined && previous.contentHash === next.contentHash && previous.version === next.version) {
    return err("overwrite_forbidden", "package updates must not overwrite the active version in place");
  }
  return ok(next);
}

export type ToolOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly result: string;
};

export type OutputBoundFailure = "stdout_truncated" | "stderr_truncated" | "result_truncated" | "secret_leak";

const SECRET_MARKERS = ["AKIA", "BEGIN PRIVATE KEY", "xoxb-", "ghp_"];

export function enforceOutputBounds(
  manifest: ToolPackageManifest,
  output: ToolOutput,
): Result<ToolOutput, OutputBoundFailure> {
  for (const marker of SECRET_MARKERS) {
    if (output.stdout.includes(marker) || output.stderr.includes(marker) || output.result.includes(marker)) {
      return err("secret_leak", "tool output contained a secret marker");
    }
  }
  if (Buffer.byteLength(output.stdout, "utf8") > manifest.stdoutBytes) {
    return err("stdout_truncated", "stdout exceeded package bound");
  }
  if (Buffer.byteLength(output.stderr, "utf8") > manifest.stderrBytes) {
    return err("stderr_truncated", "stderr exceeded package bound");
  }
  if (output.result.length > manifest.resultChars) {
    return err("result_truncated", "result exceeded package bound");
  }
  return ok(output);
}
