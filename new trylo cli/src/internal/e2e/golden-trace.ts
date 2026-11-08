/**
 * Normalization and verification utilities for golden event traces.
 *
 * Runs on the groundwork path must produce deterministic, reproducible event
 * and journal sequences. This module normalizes volatile runtime facts
 * (timestamps, random IDs, workspace paths) into stable canonical
 * representations for golden comparison.
 */

export type NormalizationContext = {
  readonly workspaceRoot: string;
  readonly homeRoot: string;
};

/**
 * Strips host-specific and time-varying facts from arbitrary text, leaving only
 * the structural and behavioral invariants of the execution.
 */
export function normalizeText(text: string, ctx: NormalizationContext): string {
  let result = text;
  const normWorkspace = ctx.workspaceRoot.replaceAll("\\", "/");
  const normHome = ctx.homeRoot.replaceAll("\\", "/");

  result = result.replaceAll("\\", "/");
  result = result.replaceAll(normWorkspace, "<WORKSPACE>");
  result = result.replaceAll(normHome, "<HOME>");

  // Normalize ISO8601 timestamps
  result = result.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");

  // Normalize dynamic ids: eph-..., turn-..., cor-..., tkt-..., chk-..., fx-..., ses-...
  result = result.replace(/\b(?:eph|turn|cor|tkt|chk|fx|ses)-[a-zA-Z0-9_-]+\b/g, "<ID>");

  // Normalize ephemeral port / duration milliseconds numbers
  result = result.replace(/"durationMs":\s*\d+/g, '"durationMs": 0');

  return result;
}

/**
 * Recursively normalizes a JSON-serializable structure using canonical text transformation.
 */
export function normalizeJson<T>(value: T, ctx: NormalizationContext): T {
  // Normalize string values, never JSON escape syntax: tool output can itself
  // contain quotes and newlines, and replacing its serialized backslashes
  // destroys the outer JSON before it can be read.
  return JSON.parse(JSON.stringify(value), (key: string, part: unknown) => {
    if (typeof part === "string") {
      return normalizeText(part, ctx);
    }
    return key === "durationMs" && typeof part === "number" ? 0 : part;
  }) as T;
}

/**
 * Compares actual normalized trace with the expected golden trace.
 */
export function compareTraces(
  actual: ReadonlyArray<unknown>,
  expected: ReadonlyArray<unknown>,
): { readonly matches: boolean; readonly diff?: string } {
  const actualJson = JSON.stringify(actual, null, 2);
  const expectedJson = JSON.stringify(expected, null, 2);
  if (actualJson === expectedJson) {
    return { matches: true };
  }

  return {
    matches: false,
    diff: `Trace mismatch:\n--- EXPECTED ---\n${expectedJson}\n--- ACTUAL ---\n${actualJson}`,
  };
}
