import { createHash } from "node:crypto";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { WORKSPACE_WRITE_TOOL_NAMES } from "../../adapters/tools/mutating/bindings.js";
import { createProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { EMPTY_PROFILE, type ProfilePort } from "../../contract/profile.js";
import type { ToolPort } from "../../ports/tools.js";
import type { ToolBinding } from "../../ports/tools.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { selectToolPort } from "./tool-selection.js";

/**
 * The catalog half of the composition root: what a tool table *hashes to*, and
 * the one profile the shipping CLI always pins.
 *
 * Extracted from `wiring.ts` under its file-size gate (§10 #25: split something
 * out, never widen the ceiling) — these are the functions the session
 * fingerprint reads before any turn runs, so they were never really part of
 * `wirePorts`; they are the identity vocabulary of a tool catalog.
 */

/** Explicit, packaged, learning-free profile. Never a live activation read. */
export const NO_LEARNING_PROFILE: ProfilePort = {
  async load() {
    return EMPTY_PROFILE;
  },
};

export function toolCatalogHash(tools: ToolPort, selection?: readonly string[]): string {
  return hashBindings(tools.snapshot(), selection);
}

function hashBindings(bindings: ReadonlyArray<ToolBinding>, selection?: readonly string[]): string {
  const catalog = bindings
    .map((binding) => ({
      name: binding.name,
      sideEffect: binding.sideEffect,
      needsApproval: binding.needsApproval,
      parameters: binding.parameters,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  // Runtime-only names (MCP, optional tools) may be absent during preparation.
  // Keep the declared ceiling in the identity so two such selections never
  // collapse into the same empty base catalog. Default hashes remain intact.
  const identity = selection === undefined ? catalog : { catalog, selection: [...new Set(selection)].sort() };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
}

/** B1 only: remove the optional fields we introduced, leaving every other binding unchanged. */
export function b1CompatibleCatalogHashes(tools: ToolPort, selection?: readonly string[]): ReadonlyArray<string> {
  const without = (range: boolean) => tools.snapshot().map(binding => {
    const removed = binding.name === "read_file" && range ? ["offset", "limit"]
      : binding.name === "search_text" || binding.name === "glob_files" ? ["include", "exclude"] : [];
    const properties = binding.parameters.properties;
    if (removed.length === 0 || properties === null || typeof properties !== "object" || Array.isArray(properties)) return binding;
    return { ...binding, parameters: { ...binding.parameters,
      properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !removed.includes(name))),
    } };
  });
  return [hashBindings(without(false), selection), hashBindings(without(true), selection)];
}

/**
 * Every catalog a hash is taken over must be built the way `wirePorts` builds
 * it. Passing a registry here matters for more than tidiness: the session tools
 * are mounted only when one is supplied, so a catalog built without one would
 * hash to a value the real run never produces — and a fingerprint that does not
 * describe the run is worse than no fingerprint, because it looks authoritative.
 */
function catalogForHashing(workspaceRoot: string, selection?: readonly string[]): ToolPort {
  return selectToolPort(createWorkspaceTools({
    workspaceRoot,
    sandbox: createWorkspaceSandbox({ workspaceRoot }),
    sessions: createProcessSessionRegistry(),
  }), selection);
}

function isParameterObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compatibleCatalogHashes(workspaceRoot: string, selection?: readonly string[]): ReadonlyArray<string> {
  const tools = catalogForHashing(workspaceRoot, selection);
  // Only documentation changed: retain the exact previous parameter shape,
  // bounds and permission contract. No old executable schema is admitted here.
  const previous: ToolPort = { ...tools, snapshot: () => tools.snapshot().map(binding => {
    const properties = binding.parameters.properties;
    if (binding.name !== "run_shell" || !isParameterObject(properties)) return binding;
    const command = properties.command, timeout = properties.timeoutMs;
    if (!isParameterObject(command) || !isParameterObject(timeout)) return binding;
    return { ...binding, parameters: { ...binding.parameters, properties: { ...properties,
      command: { ...command, description: "Command to run, without redirections. `a | b | c` pipelines are allowed." },
      timeoutMs: { ...timeout, description: "Optional foreground timeout in milliseconds." },
    } } };
  }) };
  return [hashBindings(previous.snapshot(), selection), ...b1CompatibleCatalogHashes(tools, selection), ...b1CompatibleCatalogHashes(previous, selection)];
}

/** Tools a non-interactive run may perform when writes are explicitly allowed. */
export function workspaceWriteToolNames(): ReadonlySet<string> {
  return new Set(WORKSPACE_WRITE_TOOL_NAMES);
}

/**
 * Catalog hash without running a turn. The session fingerprint needs it before
 * the first provider request, so it cannot wait for `wirePorts`.
 */
export function catalogHash(workspaceRoot: string, selection?: readonly string[]): string {
  return toolCatalogHash(catalogForHashing(workspaceRoot, selection), selection);
}

/** Stable identity for a workspace path, used in the session fingerprint. */
export function workspaceIdentity(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}
