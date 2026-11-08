import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolBinding } from "../../ports/tools.js";
import { err, ok, type Result } from "../contract/result.js";
import { sanitizeToolDescription } from "../catalog/description-guard.js";

/**
 * WP16 C83 client-provided dynamic tools — DTO boundary + ToolBinding mapping.
 *
 * Reused mechanics:
 * - Codex `protocol/dynamic_tools.rs normalize_dynamic_tool_specs`: accepts
 *   the canonical `{function[], namespace[]}` shape and the legacy flattened
 *   `{namespace, exposeToContext}` shape; unknown shapes fail closed.
 * - Codex `core/tools/handlers/dynamic.rs DynamicToolHandler::from_parts`:
 *   `dynamic_tool_to_responses_api_tool` conversion, `defer_loading`
 *   decides `Deferred` vs `Direct` exposure, and `search_info()` makes the
 *   tool discoverable by `tool_search`.
 * - Codex `app-server-protocol/common.rs DynamicToolCall => item/tool/call`:
 *   the call/response correlation key is `call_id`; remote image/audio must
 *   be `data:` URLs or the boundary falls back.
 *
 * Trylo boundary: this module never leaks the wire DTO into the core. It
 * validates once at the boundary and emits canonical `ToolBinding` values
 * the existing `ToolPort` can execute. Description injection is filtered by
 * the shared `sanitizeToolDescription` guard.
 */

export type DynamicFunctionSpec = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly deferLoading?: boolean;
};

export type DynamicNamespaceSpec = {
  readonly namespace: string;
  readonly tools: ReadonlyArray<DynamicFunctionSpec>;
};

export type NormalizedDynamicTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly deferLoading: boolean;
  readonly namespace?: string;
};

export type DynamicSpecFailure =
  | "empty_tool_name"
  | "empty_description"
  | "prompt_injection"
  | "invalid_schema"
  | "duplicate_tool";

function isRecord(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

function normalizeFunction(
  spec: DynamicFunctionSpec,
  namespace: string | undefined,
): Result<NormalizedDynamicTool, DynamicSpecFailure> {
  const name = namespace === undefined ? spec.name.trim() : `${namespace}__${spec.name.trim()}`;
  if (name.length === 0 || name.includes("__") === false && spec.name.trim().length === 0) {
    return err("empty_tool_name", "dynamic tool refuses an empty name");
  }

  if (spec.name.trim().length === 0) {
    return err("empty_tool_name", "dynamic tool refuses an empty name");
  }

  const guarded = sanitizeToolDescription(spec.description);
  if (!guarded.ok) {
    return err(guarded.code === "prompt_injection" ? "prompt_injection" : "empty_description", guarded.text);
  }

  if (!isRecord(spec.inputSchema)) {
    return err("invalid_schema", `dynamic tool ${name} carries no JSON Schema object`);
  }

  return ok({
    name,
    description: guarded.text,
    parameters: spec.inputSchema,
    deferLoading: spec.deferLoading ?? false,
    ...(namespace === undefined ? {} : { namespace }),
  });
}

/**
 * Accepts canonical `{functions, namespaces}` and the legacy flattened
 * `{namespace, tools}` shapes. Anything else is a terminal refusal.
 */
export function normalizeDynamicSpecs(input: {
  readonly functions?: ReadonlyArray<DynamicFunctionSpec>;
  readonly namespaces?: ReadonlyArray<DynamicNamespaceSpec>;
  readonly legacyNamespace?: string;
  readonly legacyTools?: ReadonlyArray<DynamicFunctionSpec>;
}): Result<ReadonlyArray<NormalizedDynamicTool>, DynamicSpecFailure> {
  const out: NormalizedDynamicTool[] = [];
  const seen = new Set<string>();
  const push = (tool: NormalizedDynamicTool): Result<undefined, DynamicSpecFailure> => {
    if (seen.has(tool.name)) {
      return err("duplicate_tool", `dynamic tool ${tool.name} is declared twice`);
    }
    seen.add(tool.name);
    out.push(tool);
    return ok(undefined);
  };

  for (const spec of input.functions ?? []) {
    const normalized = normalizeFunction(spec, undefined);
    if (!normalized.ok) {
      return normalized;
    }

    const added = push(normalized.value);
    if (!added.ok) {
      return added;
    }
  }

  for (const group of input.namespaces ?? []) {
    if (group.namespace.trim().length === 0) {
      return err("empty_tool_name", "dynamic namespace refuses an empty name");
    }
    for (const spec of group.tools) {
      const normalized = normalizeFunction(spec, group.namespace.trim());
      if (!normalized.ok) {
        return normalized;
      }

      const added = push(normalized.value);
      if (!added.ok) {
        return added;
      }
    }
  }

  if (input.legacyNamespace !== undefined || input.legacyTools !== undefined) {
    const namespace = (input.legacyNamespace ?? "").trim();
    if (namespace.length === 0) {
      return err("empty_tool_name", "legacy dynamic namespace refuses an empty name");
    }

    for (const spec of input.legacyTools ?? []) {
      const normalized = normalizeFunction(spec, namespace);
      if (!normalized.ok) {
        return normalized;
      }

      const added = push(normalized.value);
      if (!added.ok) {
        return added;
      }
    }
  }

  return ok(out);
}

export function dynamicToolToBinding(tool: NormalizedDynamicTool): ToolBinding {
  return {
    name: tool.name,
    description: tool.description,
    sideEffect: "external",
    parameters: tool.parameters,
    needsApproval: true,
    timeoutMs: 30_000,
    outputLimits: { maxBytes: 16_384, maxLines: 200 },
  };
}
