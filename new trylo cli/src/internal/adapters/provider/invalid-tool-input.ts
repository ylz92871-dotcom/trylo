import type { JsonObject } from "../../protocol/envelope.js";

/** One non-executing recovery message across the three wire translators.
 * Never echo malformed arguments, which may contain file contents or secrets.
 */
export const INVALID_TOOL_INPUT_MESSAGE = "invalid_arguments: tool input must be a valid JSON object matching that tool's parameter schema; pass properties directly, without an arguments wrapper. No tool was run.";

/** Shared wire parsing, not repair. Empty input retains the existing {} contract.
 * A failed parse never exposes V8's error text, which can include source contents.
 */
export function parseToolInput(text: string):
  | { readonly ok: true; readonly arguments: JsonObject }
  | { readonly ok: false; readonly message: string } {
  const raw = text.trim().length === 0 ? "{}" : text;

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, arguments: value as JsonObject };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (hasOpenJsonBoundary(raw)) {
      return { ok: false, message: `${INVALID_TOOL_INPUT_MESSAGE} Input ended with an open JSON string or container. Retry with a smaller complete call; split large changes into focused calls instead of repeating the same full-file payload.` };
    }
  }

  return { ok: false, message: INVALID_TOOL_INPUT_MESSAGE };
}

/** Only describe unclosed syntax, never infer why the provider stopped. */
function hasOpenJsonBoundary(raw: string): boolean {
  const closers: string[] = [];
  let quoted = false;
  let escaped = false;

  for (const character of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") closers.push("}");
    else if (character === "[") closers.push("]");
    else if ((character === "}" || character === "]") && closers.pop() !== character) return false;
  }

  return quoted || closers.length > 0;
}
