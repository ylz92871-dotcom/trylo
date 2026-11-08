import type { McpToolAnnotations } from "../ports/mcp-client.js";
import type { JsonObject } from "../protocol/envelope.js";

/**
 * MCP tool annotations, kept as hints and nothing else.
 *
 * D3 §7 is explicit: `readOnlyHint`, `destructiveHint`, `idempotentHint` and
 * `openWorldHint` come from the server, and a server Trylo does not control is
 * not a source of policy. codex forwards them to its guardian as *evidence*;
 * goose feeds them to a heuristic. Neither lets a hint unset an approval.
 *
 * This module therefore has exactly one job, and it is a job about *not*
 * changing things:
 *
 *   - read the four hints off an arbitrary JSON value, keeping only booleans;
 *   - report them for display;
 *   - and, on the approval question, always answer "required".
 *
 * `destructiveHint: false` is the interesting attack. A server that declares
 * its tool harmless is asking to be believed. The rule that makes the request
 * uninteresting is that the local policy bit is not derived from the hint at
 * all: {@link approvalRequirementFor} ignores its argument's hints and returns
 * a constant. A test asserts precisely that, so a future "optimisation" that
 * lets a read-only hint skip a prompt has to delete a test to land.
 */

/** The four hint key names, in the order the spec lists them. */
export const MCP_ANNOTATION_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

export type McpAnnotationKey = (typeof MCP_ANNOTATION_KEYS)[number];

export function isAnnotationKey(value: string): value is McpAnnotationKey {
  return (MCP_ANNOTATION_KEYS as readonly string[]).includes(value);
}

/**
 * Extracts the hints from a raw `annotations` value.
 *
 * Non-boolean values are dropped rather than coerced. `"false"` is not `false`,
 * and a server that sends a string is either broken or probing, so the honest
 * record is "the hint was absent" — which is also what an absent key means, and
 * the two must not be distinguishable in the stored spec.
 */
export function readAnnotations(raw: unknown): McpToolAnnotations {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }

  const record = raw as Readonly<Record<string, unknown>>;
  const out: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};

  for (const key of MCP_ANNOTATION_KEYS) {
    const value = record[key];
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }

  return out;
}

/** The hints as a plain JSON object, for metadata and journals. */
export function annotationsToJson(annotations: McpToolAnnotations): JsonObject {
  const out: Record<string, boolean> = {};

  for (const key of MCP_ANNOTATION_KEYS) {
    const value = annotations[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }

  return out;
}

export type McpApprovalRequirement = {
  readonly required: true;
  /**
   * Why the answer is what it is. Recorded so an approval screen can say
   * "required by local policy, the server claimed otherwise" instead of
   * implying the server was trusted.
   */
  readonly reason: "mcp_tools_always_require_approval";
  /** Hints that are *contradicted* by the local policy, for the human's benefit. */
  readonly overriddenHints: ReadonlyArray<McpAnnotationKey>;
};

/**
 * The approval question. The parameter is deliberately named `_annotations`:
 * it is accepted so the call site reads honestly ("we looked at the hints") and
 * ignored so the answer cannot depend on them.
 */
export function approvalRequirementFor(_annotations: McpToolAnnotations): McpApprovalRequirement {
  const overridden = MCP_ANNOTATION_KEYS.filter((key) => {
    const value = _annotations[key];

    // `readOnlyHint: true` / `destructiveHint: false` / `idempotentHint: true`
    // are the three shapes a server uses to argue for a lighter touch.
    if (key === "readOnlyHint" || key === "idempotentHint") {
      return value === true;
    }

    if (key === "destructiveHint") {
      return value === false;
    }

    return false;
  });
  return {
    required: true,
    reason: "mcp_tools_always_require_approval",
    overriddenHints: overridden,
  };
}

/**
 * A one-line summary for logs and approval prompts. Never a decision input.
 * Wording avoids "safe"/"unsafe" so nobody mistakes it for a verdict.
 */
export function describeAnnotations(annotations: McpToolAnnotations): string {
  const parts: string[] = [];

  for (const key of MCP_ANNOTATION_KEYS) {
    const value = annotations[key];
    if (value !== undefined) {
      parts.push(`${key}=${value ? "true" : "false"}`);
    }
  }

  return parts.length === 0 ? "no annotations published" : parts.join(", ");
}
