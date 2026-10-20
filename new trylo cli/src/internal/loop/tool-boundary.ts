import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import type { PermissionPort } from "../ports/permission.js";
import type {
  ToolCallRequest,
  ToolOutcome,
  ToolPort,
  ToolSandbox,
} from "../ports/tools.js";

export type ToolApprovalRequirement = {
  readonly required: boolean;
  readonly degradedReason?: string;
};

export type ToolCancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function readToolApprovalRequirement(
  tools: ToolPort,
  name: string,
  call?: ToolCallRequest,
  sandbox?: ToolSandbox,
  permission?: PermissionPort,
): ToolApprovalRequirement {
  try {
    const binding = tools.snapshot().find((item) => item.name === name);
    return { required: binding === undefined || binding.needsApproval || permission?.isDenied?.(name) === true || (call !== undefined && sandbox?.requiresApproval?.(call) === true) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "tool_snapshot_error";
    return { required: true, degradedReason: `tool_snapshot_unavailable:${detail}` };
  }
}

/**
 * Reading a provider's tool arguments the way the tool declared them.
 *
 * Every shape below was observed from a real OpenAI-compatible endpoint
 * (`DeepSeek-V4-Flash-Vision-Exp` on the AMD gateway), on the *same* tools that
 * otherwise worked:
 *
 * ```
 * read_file   {"path": "taskboard.js"}                          // correct
 * read_file   {"arguments": {"path": "taskboard.js"}}           // wrapped
 * write_file  {"args": {"path": "...", "content": "..."}}       // wrapped, other name
 * run_shell   {"command": {"path": "...", "command": "cat x"}}  // named after the first parameter
 * ```
 *
 * The last one is what makes this a *shape* rule rather than a dictionary of
 * magic keys: the gateway hands back one key — sometimes `arguments`, sometimes
 * the name of the tool's own first parameter — whose value is the whole
 * argument object. A model that slips into that mode cannot recover from the
 * error, because the refusal ("write_file requires a non-empty path") tells it
 * what is missing, not that it wrapped; the observed run burned fifteen of
 * twenty-four iterations repeating it.
 *
 * It also arrives *partially* wrapped — `{"arguments": {"path": "a.js"},
 * "patch": "..."}` — so the rule is a merge, not a single unwrap.
 *
 * Reading declared parameters wherever they appear at the top level or one
 * level in is safe because it can only ever accept a call that is *already*
 * unreadable as written: a property becomes a wrapper only when its value is a
 * plain object that names a parameter the tool declares, *and* the property
 * itself is not one the tool declared as an object. A tool that genuinely takes
 * an object under that key is left alone. An honest call never matches at all —
 * its values are strings — and a genuinely malformed call still fails with
 * exactly the message it failed with before, because nothing here invents a
 * value the model did not send.
 */
export type ToolArgumentNormalizer = (name: string, args: JsonObject) => JsonObject;

const DECLARED_PROPERTY = "properties";
const TYPE_KEY = "type";

/** Declared parameter name -> its declared JSON type, when it states one. */
type DeclaredParameters = ReadonlyMap<string, string | undefined>;

function declaredParameters(tools: ToolPort, name: string): DeclaredParameters {
  const declared = new Map<string, string | undefined>();
  try {
    const binding = tools.snapshot().find((item) => item.name === name);
    const properties = binding?.parameters[DECLARED_PROPERTY];
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
      return declared;
    }
    for (const [key, schema] of Object.entries(properties)) {
      const type =
        typeof schema === "object" && schema !== null && !Array.isArray(schema)
          ? (schema as JsonObject)[TYPE_KEY]
          : undefined;
      declared.set(key, typeof type === "string" ? type : undefined);
    }
  } catch {
    // An unreadable catalog is already reported by `readToolApprovalRequirement`;
    // here it simply means "no shape is known", so nothing is rewritten.
    return new Map<string, string | undefined>();
  }
  return declared;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapWrappedArguments(
  declared: DeclaredParameters,
  args: JsonObject,
): JsonObject {
  if (declared.size === 0) {
    return args;
  }
  let merged: Record<string, JsonValue> | undefined;
  for (const [key, value] of Object.entries(args)) {
    const wrapped =
      declared.get(key) !== "object" &&
      isPlainObject(value) &&
      Object.keys(value).some((inner) => declared.has(inner));
    if (!wrapped) {
      continue;
    }
    merged = merged ?? { ...args };
    delete merged[key];
    for (const [inner, innerValue] of Object.entries(value as JsonObject)) {
      // A parameter the model also placed at the top level stays as it wrote
      // it; the wrapper only fills in what is missing.
      if (declared.has(inner) && merged[inner] === undefined) {
        merged[inner] = innerValue;
      }
    }
  }
  return merged === undefined ? args : (merged as JsonObject);
}

export function createToolArgumentNormalizer(tools: ToolPort): ToolArgumentNormalizer {
  return (name, args) => unwrapWrappedArguments(declaredParameters(tools, name), args);
}

export async function executeToolSafely(
  tools: ToolPort,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  try {
    return await tools.execute(call, signal);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "tool_adapter_error";
    return {
      outcome: "unknown",
      code: "tool_adapter_exception",
      message: `tool_adapter_exception:${detail}`,
    };
  }
}

export async function cancelToolSafely(
  tools: ToolPort,
  toolCallId: string,
): Promise<ToolCancelResult> {
  try {
    await tools.cancel(toolCallId);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "tool_cancel_error",
    };
  }
}
