/**
 * Server results to Trylo answers.
 *
 * A language server's reply is `unknown` at the type level — it is JSON that
 * arrived from another program. So every field is checked before it is believed,
 * and a reply that does not match becomes a typed `lsp_invalid_result` rather
 * than a half-populated location pointing at `undefined`.
 *
 * The other job here is separating **empty** from **answered**: a server that
 * reports no definition at this position produced a real answer, and the model is
 * entitled to see that difference. Collapsing it into an error would teach the
 * model to retry a position that genuinely has nothing.
 */

import type { LspAnswer, LspLocation, LspSymbol, LspCallHierarchyItem } from "../../ports/language-server.js";
import { uriToPath } from "./lsp-uri.js";

export class InvalidLspResult extends Error {
  constructor(detail: string) {
    super(`invalid lsp result: ${detail}`);
    this.name = "InvalidLspResult";
  }
}

type Raw = Record<string, unknown>;

export function decodeAnswer(result: unknown, operation: string): LspAnswer {
  if (result === null || result === undefined) {
    return { status: "empty" };
  }
  switch (operation) {
    case "hover":
      return decodeHover(result);
    case "document_symbols":
      return decodeSymbols(result);
    case "call_hierarchy":
      return decodeCalls(result);
    default:
      return { status: "answered", locations: decodeLocations(result, operation) };
  }
}

function decodeHover(result: unknown): LspAnswer {
  const record = asRecord(result);
  if (record === undefined) {
    return { status: "hover", markdown: plainText(result) };
  }

  const contents = record["contents"];
  if (contents === undefined || contents === null) {
    return { status: "empty" };
  }

  return { status: "hover", markdown: hoverText(contents) };
}

/**
 * Hover content is `string | MarkedString | MarkedString[]`; we keep the text
 * and drop the markup, because a stored answer is plain text everywhere else in
 * Trylo and a second markdown dialect here would need its own renderer.
 */
function hoverText(contents: unknown): string {
  if (typeof contents === "string") {
    return contents;
  }

  if (Array.isArray(contents)) {
    return contents.map((entry) => hoverText(entry)).filter((part) => part.length > 0).join("\n\n");
  }

  const record = asRecord(contents);
  if (record !== undefined) {
    const value = record["value"];
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

function plainText(result: unknown): string {
  return typeof result === "string" ? result : "";
}

function decodeSymbols(result: unknown): LspAnswer {
  if (!Array.isArray(result)) {
    throw new InvalidLspResult("documentSymbol did not return an array");
  }

  const symbols: LspSymbol[] = [];
  // Nested children are flattened with their container named, because a flat list
  // is what a model can act on and what a journal entry can store.
  const walk = (entries: ReadonlyArray<unknown>, container: string | undefined): void => {
    for (const entry of entries) {
      const record = asRecord(entry);
      if (record === undefined) {
        continue;
      }

      const name = record["name"];
      if (typeof name !== "string") {
        continue;
      }

      const range = locationFromRange(record["range"]);
      const location = range === undefined ? undefined : { path: "", ...range };
      const resolved = location === undefined || location.path === "" ? undefined : { ...location, path: resolvePath(record, location) };

      symbols.push({
        name,
        kind: kindName(record["kind"]),
        ...(container === undefined ? {} : { container }),
        ...(resolved === undefined ? {} : { location: resolved }),
      });
      const children = record["children"];
      if (Array.isArray(children)) {
        walk(children, name);
      }
    }
  };

  walk(result, undefined);

  return symbols.length === 0 ? { status: "empty" } : { status: "symbols", symbols };
}

function decodeCalls(result: unknown): LspAnswer {
  if (!Array.isArray(result)) {
    throw new InvalidLspResult("incomingCalls did not return an array");
  }

  const items: LspCallHierarchyItem[] = [];

  for (const entry of result) {
    const record = asRecord(entry);
    if (record === undefined) {
      continue;
    }

    const from = asRecord(record["from"]);
    if (from === undefined) {
      continue;
    }

    const location = locationFromUri(asRecord(from["location"])?.["uri"], from["selectionRange"] ?? from["range"]);
    if (location === undefined) {
      continue;
    }

    items.push({
      name: stringOr(from["name"], "unknown"),
      kind: kindName(from["kind"]),
      location,
    });
  }

  return items.length === 0 ? { status: "empty" } : { status: "calls", items };
}

function decodeLocations(result: unknown, operation: string): ReadonlyArray<LspLocation> {
  // definition/implementation answer a single Location or an array of them;
  // references always answers an array. Both are accepted, and one is not
  // silently promoted to a list of one with a different meaning.
  const entries = Array.isArray(result) ? result : [result];
  const locations: LspLocation[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === undefined) {
      throw new InvalidLspResult(`${operation} returned a non-location entry`);
    }

    const location = locationFromUri(record["uri"], record["range"] ?? record["targetRange"] ?? record["selectionRange"]);
    if (location !== undefined) {
      locations.push(location);
    }
  }

  return locations;
}

function resolvePath(record: Raw, fallback: LspLocation): string {
  const fromUri = uriToPath(stringOr(record["uri"], ""));
  return fromUri ?? fallback.path;
}

function locationFromUri(uri: unknown, range: unknown): LspLocation | undefined {
  if (typeof uri !== "string") {
    return undefined;
  }

  const path = uriToPath(uri);
  if (path === undefined) {
    // A `jdt://` or `untitled:` document has no path on this disk. Dropping it
    // keeps the answer honest about what the user can actually open.
    return undefined;
  }

  const span = locationFromRange(range);
  if (span === undefined) {
    return { path, line: 0, character: 0 };
  }

  return { path, ...span };
}

function locationFromRange(range: unknown): { line: number; character: number; endLine?: number; endCharacter?: number } | undefined {
  const record = asRecord(range);
  if (record === undefined) {
    return undefined;
  }

  const start = asRecord(record["start"]);
  if (start === undefined) {
    return undefined;
  }

  const end = asRecord(record["end"]);
  const span = {
    line: numberOr(start["line"], 0),
    character: numberOr(start["character"], 0),
    ...(end === undefined ? {} : { endLine: numberOr(end["line"], 0), endCharacter: numberOr(end["character"], 0) }),
  };

  return span;
}

function asRecord(value: unknown): Raw | undefined {
  // The explicit return type is load-bearing: `hoverText` calls itself through
  // this helper, and without an annotation TypeScript reports a circular
  // inference rather than a function.
  const candidate: Raw | undefined = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : undefined;
  return candidate;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Symbol kinds are integers in the protocol (26 of them). Names beat numbers in
 * anything a person or a model reads, and an unknown number is preserved as
 * `kind:<n>` so a new server kind is visible rather than collapsed to "unknown".
 */
const SYMBOL_KINDS: Readonly<Record<number, string>> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null", 22: "enum_member",
  23: "struct", 24: "event", 25: "operator", 26: "type_parameter",
};

export function kindName(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value !== "number") {
    return "unknown";
  }

  return SYMBOL_KINDS[value] ?? `kind:${value}`;
}
