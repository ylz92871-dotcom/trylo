/**
 * `find_files`: approximate file name, workspace-relative paths out.
 *
 * Split from `index.ts` for the same reason `read-file.ts` was: the dispatcher
 * decides *what happens*, this file decides *what the answer says*. The two
 * answers this tool can give are the whole design:
 *
 *   - `matches: [...]` — the index was complete and here is what it found;
 *   - `indexIncomplete: true` — the index hit a ceiling, so **an empty list means
 *     "not found in what we could see"**, not "this project has no such file".
 *
 * Collapsing those two into one empty array is the specific dishonesty this
 * contract exists to prevent: a model told "no such file" will tell the user the
 * file does not exist, and it will be wrong because the walk stopped early.
 */

import type { JsonObject } from "../../../protocol/envelope.js";
import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import { readStringArg } from "./args.js";
import type { ReadOnlyToolLimits } from "./limits.js";
import type { FileFinder } from "../file-finder/file-finder.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

type Config = {
  readonly finder: FileFinder;
  readonly limits: ReadOnlyToolLimits;
};

export async function executeFindFiles(config: Config, call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }

  const query = readStringArg(call.arguments, "query");
  if (query === undefined || query.trim().length === 0) {
    // An empty query is refused rather than answered with an arbitrary listing:
    // "find a file I haven't named" has no correct answer, and a confident-looking
    // list of 200 paths invites the model to pick one at random.
    return { outcome: "error", code: "invalid_arguments", message: "find_files requires a non-empty query" };
  }

  const rawLimit = call.arguments["limit"];
  if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1)) {
    return { outcome: "error", code: "invalid_arguments", message: "limit must be a positive integer" };
  }

  const requested = typeof rawLimit === "number" ? rawLimit : DEFAULT_LIMIT;
  const limit = Math.min(requested, MAX_LIMIT);

  try {
    const found = await config.finder.find(query, limit, signal);

    if (signal.aborted) {
      return { outcome: "cancelled" };
    }

    const paths = found.matches.map((match) => match.path);
    const value: JsonObject = {
      query,
      paths,
      matchCount: paths.length,
      filesIndexed: found.filesIndexed,
      indexIncomplete: found.indexTruncated,
      ...(found.indexTruncated
        ? {
            truncationReasons: [...found.reasons],
            hint: "The file index hit a ceiling, so an empty result means not found within what could be scanned. Narrow the query or use glob_files with an exact pattern.",
          }
        : {}),
      // Said out loud because the difference matters to the reader: this matched
      // paths, never contents.
      matchedBy: "file_name_only",
    };

    return {
      outcome: "result",
      value,
      output: paths.join("\n"),
      truncated: found.indexTruncated,
    };
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    return {
      outcome: "error",
      code: "find_files_failed",
      message: `find_files_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
