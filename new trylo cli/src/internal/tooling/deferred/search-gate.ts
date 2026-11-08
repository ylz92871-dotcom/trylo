import { err, ok, type Result } from "../contract/result.js";
import { nextToolUsePhase, type ToolUsePhase } from "../catalog/phases.js";

/**
 * WP16.2 deferred search gate — search-then-call with schema version and
 * registration generation.
 *
 * Reused mechanics:
 * - legacy `utils/toolSearch.ts`: `tst-auto` enables search only past a
 *   threshold (default 10% of context); `isDeferredTool` defers every tool
 *   except `alwaysLoad`, the search tool itself, fork/subagent helpers and
 *   brief senders; `select:<name>` is the explicit load verb.
 * - Codex `spec_plan finalize_tool_router`: `tool_search` registers only when
 *   search is enabled AND a deferred tool exists AND search info exists;
 *   collisions (exec/wait, duplicate names, namespaces) are hard errors.
 * - catalog `phases.nextToolUsePhase`: `search -> discovery`,
 *   `load_schema` requires discovery, `execute` requires `schema_load`;
 *   anything else is `execution_before_schema` / `not_discovered`.
 * - catalog `assembleDeferredContext`: `alwaysLoad || !shouldDefer` ships the
 *   schema; the rest ships names only.
 *
 * The gate is the enforcement point the catalog pure functions lack: it
 * remembers which schemas were loaded at which version and generation, and
 * rejects unexposed, uninstalled, conflicting, late, or stale-generation
 * calls before they reach `ToolPort.execute`.
 */

export type DeferredToolEntry = {
  readonly name: string;
  readonly shouldDefer: boolean;
  readonly alwaysLoad: boolean;
  readonly schemaVersion: string;
  readonly packageVersionId: string;
};

export type SearchGateState = {
  readonly generation: number;
  readonly phase: ToolUsePhase;
  readonly searched: ReadonlyArray<string>;
  readonly loadedSchemas: Readonly<Record<string, string>>;
};

export type SearchGateFailure =
  | "not_discovered"
  | "schema_not_loaded"
  | "schema_conflict"
  | "execution_before_schema"
  | "stale_generation"
  | "unknown_tool";

export const INITIAL_SEARCH_GATE: SearchGateState = {
  generation: 0,
  phase: "discovery",
  searched: [],
  loadedSchemas: {},
};

export function shouldDeferTool(entry: Pick<DeferredToolEntry, "shouldDefer" | "alwaysLoad">): boolean {
  if (entry.alwaysLoad) {
    return false;
  }
  return entry.shouldDefer;
}

export function applySearch(
  state: SearchGateState,
  query: string,
  matched: ReadonlyArray<string>,
): SearchGateState {
  const searched = [...state.searched];

  for (const name of matched) {
    if (!searched.includes(name)) {
      searched.push(name);
    }
  }

  void query;

  return { ...state, phase: "discovery", searched };
}

export function applySchemaLoad(
  state: SearchGateState,
  toolName: string,
  schemaVersion: string,
): Result<SearchGateState, SearchGateFailure> {
  if (!state.searched.includes(toolName)) {
    return err("not_discovered", `schema for ${toolName} needs a search first`);
  }

  const next = nextToolUsePhase(state.phase, "load_schema");
  if (next !== "discovery" && next !== "schema_load" && next !== "execution") {
    return err("not_discovered", `schema load for ${toolName} has no discovery behind it`);
  }

  return ok({
    ...state,
    phase: next,
    loadedSchemas: { ...state.loadedSchemas, [toolName]: schemaVersion },
  });
}

export function evaluateToolCall(input: {
  readonly state: SearchGateState;
  readonly toolName: string;
  readonly entry: DeferredToolEntry | undefined;
  readonly expectedGeneration: number;
}): Result<{ readonly phase: ToolUsePhase }, SearchGateFailure> {
  if (input.state.generation !== input.expectedGeneration) {
    return err(
      "stale_generation",
      `call for ${input.toolName} froze generation ${input.expectedGeneration} but gate is at ${input.state.generation}`,
    );
  }

  const entry = input.entry;
  if (entry === undefined) {
    return err("unknown_tool", `tool ${input.toolName} is not installed or was uninstalled`);
  }

  if (!shouldDeferTool(entry)) {
    const direct = nextToolUsePhase("schema_load", "execute");
    if (direct !== "execution") {
      return err("execution_before_schema", `direct tool ${input.toolName} has no executable phase`);
    }
    return ok({ phase: "execution" });
  }

  const loaded = input.state.loadedSchemas[input.toolName];
  if (loaded === undefined) {
    return err("schema_not_loaded", `schema for ${input.toolName} was not sent; ToolSearch select:${input.toolName} first`);
  }

  if (loaded !== entry.schemaVersion) {
    return err("schema_conflict", `schema for ${input.toolName} changed ${loaded} -> ${entry.schemaVersion}; re-select first`);
  }

  const next = nextToolUsePhase(input.state.phase, "execute");
  if (next !== "execution") {
    return err("execution_before_schema", `tool ${input.toolName} needs schema_load before execute`);
  }

  return ok({ phase: next });
}

/** Legacy 10% default: search pays off once deferred schemas cross it. */
export function searchThresholdMet(input: {
  readonly deferredChars: number;
  readonly contextChars: number;
  readonly thresholdRatio?: number;
}): boolean {
  const ratio = input.thresholdRatio ?? 0.1;
  if (input.contextChars <= 0) {
    return false;
  }
  return input.deferredChars / input.contextChars >= ratio;
}
