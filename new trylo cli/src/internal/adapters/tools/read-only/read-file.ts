import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { FileAccessMode, ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import {
  localRuleAppendix,
  MAX_LOCAL_RULE_BYTES,
  type LocalRuleLookup,
  type LocalRuleSource,
} from "../../project-instructions/appendix.js";
import { readStringArg } from "./args.js";
import { cutToBytes } from "../../text-cut.js";
import type { FileSystemReader, ReadOnlyToolLimits } from "./limits.js";
import { isRangeProblem, readRangeRequest, selectRange, type RangeSelection } from "./range.js";
import { resolveInsideWorkspace } from "./workspace.js";

export function applyLimits(text: string, limits: ReadOnlyToolLimits): {
  text: string;
  truncated: boolean;
  truncatedBytes: boolean;
  truncatedLines: boolean;
} {
  let out = text;
  let truncatedBytes = false;
  let truncatedLines = false;
  if (Buffer.byteLength(out, "utf8") > limits.maxBytes) {
    out = cutToBytes(out, limits.maxBytes);
    truncatedBytes = true;
  }
  const lines = out.split("\n");
  if (lines.length > limits.maxLines) {
    out = lines.slice(0, limits.maxLines).join("\n");
    truncatedLines = true;
  }
  return {
    text: out,
    truncated: truncatedBytes || truncatedLines,
    truncatedBytes,
    truncatedLines,
  };
}

/**
 * What a range read reports about itself, as plain JSON values.
 *
 * Written field by field rather than spread-and-cast so the compiler has to
 * agree every one of them is a `JsonValue`. `content` carries no positions of its
 * own — `edit_file` matches against it, and a `L120:` prefix inside it would be a
 * corruption the model cannot see — so the positions live here, beside it.
 */
function rangeFields(selection: RangeSelection): JsonObject {
  return {
    startLine: selection.startLine,
    endLine: selection.endLine,
    totalLines: selection.totalLines,
    // Absent rather than null: a model reading this is looking for "is there a
    // next step", and a missing field answers that as plainly as a null does.
    ...(selection.nextOffset === undefined ? {} : { nextOffset: selection.nextOffset }),
    ...(selection.lineTooLong === undefined
      ? {}
      : { lineTooLong: { line: selection.lineTooLong.line, bytes: selection.lineTooLong.bytes } }),
  };
}

export async function executeReadFile(
  config: {
    readonly workspaceRoot: string;
  readonly fileAccess?: FileAccessMode;
  readonly workspaceAlias?: string;
    readonly reader: FileSystemReader;
    readonly localRules?: LocalRuleLookup | undefined;
  },
  limits: ReadOnlyToolLimits,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const requested = readStringArg(call.arguments, "path");
  if (requested === undefined) {
    return { outcome: "error", code: "invalid_arguments", message: "read_file requires path" };
  }
  // Parsed before the file is touched: a bad `offset` should not cost a read, and
  // the model gets told which of the two arguments was wrong rather than being
  // handed a generic failure and left guessing.
  const request = readRangeRequest(call.arguments);
  if (isRangeProblem(request)) {
    return { outcome: "error", code: "invalid_arguments", message: `read_file: ${request.message}` };
  }
  const verdict = resolveInsideWorkspace(config.workspaceRoot, requested, config.fileAccess, config.workspaceAlias);
  if (!verdict.ok) {
    return { outcome: "error", code: verdict.code, message: verdict.code };
  }
  try {
    const raw = await config.reader.readFileUtf8(verdict.absolutePath, signal);
    const rules = config.localRules?.(verdict.absolutePath) ?? [];
    const ruleBudget = Math.min(MAX_LOCAL_RULE_BYTES, Math.floor(limits.maxBytes / 2));
    const appendix = localRuleAppendix(rules, ruleBudget);
    const appendixBytes =
      appendix.text.length === 0 ? 0 : Buffer.byteLength(appendix.text, "utf8") + 2;
    // The rule appendix shares the byte ceiling with the source, so the source gets
    // what is left. A rule that was cut is a loss the model is told about; a source
    // line that was cut is a position it can come back to.
    const sourceLimits = { ...limits, maxBytes: limits.maxBytes - appendixBytes };
    const selection = call.arguments.offset === undefined && call.arguments.limit === undefined
      ? legacySelection(raw, sourceLimits)
      : selectRange(raw, request, sourceLimits);
    const value: JsonObject = {
      path: requested,
      content: selection.text,
      truncated: selection.truncated || appendix.omittedFiles > 0 || appendix.bodyTruncated,
      truncatedBytes: selection.truncatedBytes,
      truncatedLines: selection.truncatedLines,
      ...rangeFields(selection),
      ...(appendix.sources.length === 0 ? {} : { localRules: sourceArray(appendix.sources) }),
    };
    return {
      outcome: "result",
      value,
      output: `${call.arguments.offset !== undefined || call.arguments.limit !== undefined || selection.truncated || selection.text.length === 0
        ? JSON.stringify({ ...rangeFields(selection), truncated: selection.truncated, truncatedBytes: selection.truncatedBytes, truncatedLines: selection.truncatedLines }) + "\n" : ""}${selection.text}${appendix.text.length === 0 ? "" : `\n\n${appendix.text}`}`,
      // The outcome's own flag covers the *output* text. The value's flag is
      // wider, because a rule that was cut is a loss the model has to be told
      // about even though every byte of code came through whole.
      truncated: selection.truncated,
    };
  } catch (err) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = err instanceof Error ? err.message : "read_error";
    return { outcome: "error", code: "read_failed", message: `read_failed:${detail}` };
  }
}

/**
 * Provenance as plain JSON values, field by field.
 *
 * Written out rather than spread-and-cast so the compiler has to agree that
 * every field is a `JsonValue`: a rule source that grew a non-JSON field would
 * fail here instead of reaching a journal that cannot store it.
 */
function sourceArray(sources: ReadonlyArray<LocalRuleSource>): JsonValue {
  return sources.map((source) => ({
    relativePath: source.relativePath,
    scopePath: source.scopePath,
    scope: source.scope,
    contentHash: source.contentHash,
  }));
}

/** Preserve the old {path} prefix; an explicit range starts at a complete line. */
function legacySelection(raw: string, limits: ReadOnlyToolLimits): RangeSelection {
  const legacy = applyLimits(raw, limits);
  const lines = raw.length === 0 ? [] : raw.split("\n");
  if (raw.endsWith("\n")) lines.pop();
  const totalLines = lines.length;
  const returned = legacy.text.length === 0 ? 0 : legacy.text.split("\n").length - (legacy.text.endsWith("\n") ? 1 : 0);
  // Line-limit slicing drops the separator after the final complete line.
  const partial = legacy.truncatedBytes && !legacy.truncatedLines && !legacy.text.endsWith("\n");
  const next = partial ? Math.max(0, returned - 1) : returned;
  const stranded = lines[next];
  const bytes = stranded === undefined ? 0 : Buffer.byteLength(stranded + (next < totalLines - 1 || raw.endsWith("\n") ? "\n" : ""), "utf8");
  const tooLong = partial && bytes > limits.maxBytes;
  return {
    ...legacy, startLine: totalLines === 0 ? 0 : 1, endLine: returned, totalLines,
    nextOffset: legacy.truncated && !tooLong && next < totalLines ? next : undefined,
    ...(tooLong ? { lineTooLong: { line: next + 1, bytes } } : {}),
  };
}
