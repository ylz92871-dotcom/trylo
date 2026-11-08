import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const realFailure = code => Object.assign(new Error(code), { safeCode: code });
export const loadRealModule = (build, suffix) => import(pathToFileURL(path.join(build, "internal", `${suffix}.js`)).href);

/** Read-only normal configuration and CredentialPort route. Never serialize the returned secret. */
export async function resolveRealConnection({ build, workspaceRoot, modelOverride }) {
  const [{ resolveConnectionSettings }, { runCredentialFor }] = await Promise.all([
    loadRealModule(build, "surface/cli/connection-settings"), loadRealModule(build, "surface/cli/provider-selection"),
  ]);
  const ctx = {
    cwd: workspaceRoot, homeDir: homedir(), env: { ...process.env }, platform: process.platform,
    nodeVersion: process.version, stdinIsTty: false, stdout: () => {}, stderr: () => {}, now: () => Date.now(), newId: prefix => `${prefix}-${randomUUID()}`,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    readDir: directory => { try { return readdirSync(directory, { withFileTypes: true }).map(item => ({ name: item.name, isDirectory: item.isDirectory() })); } catch { return []; } },
    isDirectory: directory => { try { return statSync(directory).isDirectory(); } catch { return false; } },
  };
  const configured = resolveConnectionSettings(ctx, {});
  if ("exitCode" in configured) throw realFailure(`configuration_unavailable_exit_${configured.exitCode}`);

  const connection = modelOverride === undefined ? configured : resolveConnectionSettings(ctx, { model: modelOverride });
  if ("exitCode" in connection) throw realFailure(`configuration_unavailable_exit_${connection.exitCode}`);

  const selected = connection.provider;
  if (selected.kind !== "openai-compatible" && selected.kind !== "openai-responses") throw realFailure("selected_provider_is_not_real_keyed_transport");

  const endpoint = new URL(selected.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw realFailure("endpoint_not_safe_for_public_isolated_configuration");

  const credential = runCredentialFor(ctx, selected.kind, selected.accountId);
  if ("exitCode" in credential || typeof credential.apiKey !== "string" || !credential.apiKey) throw realFailure("bound_api_key_unavailable_without_mutating_credentials");

  if (credential.tokenManager !== undefined) throw realFailure("oauth_refresh_not_part_of_read_only_preflight");

  return { ctx, selected, endpoint, configuredModel: configured.provider.model, apiKey: credential.apiKey };
}
