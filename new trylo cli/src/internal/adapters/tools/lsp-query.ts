/**
 * Answering a navigation question, and saying which kind of answer it is.
 *
 * The whole file exists for one distinction. `definition` on a symbol that does
 * not exist, and `definition` when the server crashed, both produce "no
 * locations" if the failures are flattened — and a model told "no definition"
 * will confidently tell the user the symbol is undefined. So every path here
 * either produces a typed failure with a name, or an answer that explicitly says
 * the server looked and found nothing.
 */

import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolCallRequest, ToolOutcome } from "../../ports/tools.js";
import {
  LSP_OPERATIONS,
  type LspAnswer,
  type LspLimits,
  type LspLocation,
  type LspOperation,
} from "../../ports/language-server.js";
import type { LanguageServerPool } from "../language-server/registry.js";
import { languageIdOf } from "../language-server/lsp-extension.js";
import { resolveWorkspacePath } from "../language-server/lsp-uri.js";

/**
 * What the tool needs from its host. Separate from the pool so the pool stays a
 * process owner and this stays an argument reader.
 */
export type LspToolDeps = {
  readonly workspaceRoot: string;
  readonly limits?: LspLimits;
  /**
   * Read a file so the server can be told about it. A language server cannot
   * resolve a position in a document it was never shown, and the symptom is an
   * "answered, but empty" hover that looks like a fact about the code.
   */
  readDocument(absolutePath: string, signal: AbortSignal): Promise<string | undefined>;
};

export async function runLspQuery(
  pool: LanguageServerPool,
  deps: LspToolDeps,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }

  const operation = readOperation(call.arguments["operation"]);
  if (operation === undefined) {
    return {
      outcome: "error",
      code: "invalid_arguments",
      message: `operation must be one of ${LSP_OPERATIONS.join(", ")}`,
    };
  }

  const path = call.arguments["path"];
  if (typeof path !== "string" || path.trim().length === 0) {
    return { outcome: "error", code: "invalid_arguments", message: "lsp_navigate requires a path" };
  }

  const relative = path.trim();
  const line = readIndex(call.arguments["line"]);
  if (line === undefined) {
    return { outcome: "error", code: "invalid_arguments", message: "line must be a non-negative integer" };
  }

  const character = readIndex(call.arguments["character"]);
  if (character === undefined) {
    return { outcome: "error", code: "invalid_arguments", message: "character must be a non-negative integer" };
  }

  const absolute = absoluteOf(deps.workspaceRoot, relative);
  const resolved = await pool.connectionFor(deps.workspaceRoot, relative, undefined);
  if (!resolved.ok) {
    return failure(resolved.code, resolved.message);
  }

  const port = resolved.port;

  // Documents are pushed on first use and refreshed when their text moved, so
  // the server answers about the file as it is now rather than as it was when
  // the index was built. A failure here is not fatal: the server may simply not
  // handle that language, and the query will then fail on its own terms.
  const text = await deps.readDocument(absolute, signal);
  const languageId = languageIdOf(relative);
  if (text !== undefined && languageId !== undefined) {
    await port.ensureStarted();
    await port.openDocument({ path: relative, languageId, text });
  }

  if (signal.aborted) {
    return { outcome: "cancelled" };
  }

  const result = await port.query({ operation, path: relative, line, character }, signal);
  if (!result.ok) {
    return failure(result.code, result.message);
  }

  if (result.answer.status === "empty") {
    // Said plainly, because "the server looked and there is nothing" is a real
    // answer and a model that cannot tell it from a failure will guess.
    return {
      outcome: "result",
      value: {
        operation,
        path: relative,
        line,
        found: false,
        summary: "The language server found nothing at this position.",
      },
      output: `no ${operation} at ${relative}:${line + 1}`,
      truncated: false,
    };
  }

  return {
    outcome: "result",
    value: answerValue(operation, relative, line, result.answer),
    output: renderAnswer(result.answer),
    truncated: result.truncated,
  };
}

function answerValue(
  operation: LspOperation,
  path: string,
  line: number,
  answer: Exclude<LspAnswer, { status: "empty" }>,
): JsonObject {
  const base: JsonObject = { operation, path, line, found: true, status: answer.status };

  if (answer.status === "answered") {
    return { ...base, locations: answer.locations.map((location) => locationValue(location)) };
  }

  if (answer.status === "symbols") {
    return {
      ...base,
      symbols: answer.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        ...(symbol.container === undefined ? {} : { container: symbol.container }),
        ...(symbol.location === undefined ? {} : { location: locationValue(symbol.location) }),
      })),
    };
  }

  if (answer.status === "calls") {
    return {
      ...base,
      callers: answer.items.map((item) => ({ name: item.name, kind: item.kind, location: locationValue(item.location) })),
    };
  }

  return { ...base, markdown: answer.markdown };
}

/** Locations stay workspace-relative and `/`-separated, so a stored result stays readable. */
function locationValue(location: LspLocation): JsonObject {
  return {
    path: location.path,
    line: location.line,
    character: location.character,
    ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
    ...(location.endCharacter === undefined ? {} : { endCharacter: location.endCharacter }),
    // Pre-rendered so the model can act without composing a path itself.
    readable: `${location.path}:${location.line + 1}`,
  };
}

function renderAnswer(answer: Exclude<LspAnswer, { status: "empty" }>): string {
  switch (answer.status) {
    case "answered":
      return answer.locations.map((location) => `${location.path}:${location.line + 1}`).join("\n");
    case "symbols":
      return answer.symbols
        .map((symbol) => `${symbol.kind} ${symbol.name}${symbol.container === undefined ? "" : ` in ${symbol.container}`}`)
        .join("\n");
    case "calls":
      return answer.items.map((item) => `${item.name} at ${item.location.path}:${item.location.line + 1}`).join("\n");
    case "hover":
      return answer.markdown;
  }
}

function failure(code: string, message: string): ToolOutcome {
  // `error` with a named code, never a result with an empty list. The model has
  // to be able to tell "I could not ask" from "there is nothing there".
  return { outcome: "error", code, message: `${code}:${message}` };
}

function readOperation(value: unknown): LspOperation | undefined {
  return typeof value === "string" && (LSP_OPERATIONS as ReadonlyArray<string>).includes(value)
    ? (value as LspOperation)
    : undefined;
}

/**
 * Positions default to 0, so a model that omits them gets the start of the file
 * rather than an error. A negative or fractional value is refused instead of
 * clamped: quietly turning line -3 into line 0 would answer a different question
 * than the one asked.
 */
function readIndex(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function absoluteOf(workspaceRoot: string, relative: string): string {
  // One spelling rule, owned by lsp-uri: this used to reimplement the join,
  // and two joins are how one file gets two spellings.
  return resolveWorkspacePath(workspaceRoot, relative);
}
