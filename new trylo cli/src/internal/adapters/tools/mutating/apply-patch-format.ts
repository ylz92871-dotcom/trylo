import { MAX_PATCH_HUNKS, MAX_PATCH_LINES } from "./patch-engine.js";

/**
 * The Codex `*** Begin Patch` grammar as this package's multi-file contract.
 *
 * Mechanical whole-text port of the line rules in
 * `open/01-agent-cli-runtimes/codex/codex-rs/apply-patch/src/parser.rs`
 * (markers, hunk shapes) and `streaming_parser.rs` (which raw line belongs
 * to which hunk). What is deliberately *not* ported, and why:
 *
 * - streaming (`push_delta`): the tool receives one complete `patch` argument,
 *   so incremental line assembly has nothing to feed;
 * - heredoc leniency (`<<'EOF'` stripping): that repairs a `local_shell` argv
 *   mistake, not patch grammar, and this tool takes no argv;
 * - size bounds are reused from `patch-engine.ts` (`MAX_PATCH_LINES`,
 *   `MAX_PATCH_HUNKS`) instead of inventing a second pair of ceilings.
 *
 * Patch text is normalised CRLF -> LF first, exactly like `edit_file`.
 */

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

export type ApplyPatchUpdateChunk = {
  readonly changeContext: string | undefined;
  readonly oldLines: ReadonlyArray<string>;
  readonly newLines: ReadonlyArray<string>;
  /** Pairs of (old index, new index) that were parsed as context lines. */
  readonly contextPairs: ReadonlyArray<readonly [number, number]>;
  readonly endOfFile: boolean;
};

export type ApplyPatchHunk =
  | { readonly kind: "add"; readonly path: string; readonly contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo: string | undefined;
      readonly chunks: ReadonlyArray<ApplyPatchUpdateChunk>;
    };

export type ApplyPatchParseFailure = {
  readonly ok: false;
  readonly code: "invalid_patch" | "invalid_hunk";
  readonly message: string;
  readonly line: number;
};

export type ApplyPatchParsed =
  | { readonly ok: true; readonly hunks: ReadonlyArray<ApplyPatchHunk> }
  | ApplyPatchParseFailure;

type MutableChunk = {
  changeContext: string | undefined;
  readonly oldLines: string[];
  readonly newLines: string[];
  readonly contextPairs: Array<[number, number]>;
  endOfFile: boolean;
};

type MutableHunk =
  | { readonly kind: "add"; readonly path: string; contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; moveTo: string | undefined; readonly chunks: MutableChunk[] };

type ParserState = {
  started: boolean;
  ended: boolean;
  readonly hunks: MutableHunk[];
  updateLine: number | undefined;
};

function blankChunk(): MutableChunk {
  return { changeContext: undefined, oldLines: [], newLines: [], contextPairs: [], endOfFile: false };
}

function pushContextLine(chunk: MutableChunk, text: string): void {
  chunk.contextPairs.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(text);
  chunk.newLines.push(text);
}

function invalidPatch(message: string, line: number): ApplyPatchParseFailure {
  return { ok: false, code: "invalid_patch", message: `invalid_patch: ${message}`, line };
}

function invalidHunk(message: string, line: number): ApplyPatchParseFailure {
  return { ok: false, code: "invalid_hunk", message: `invalid_hunk (line ${line}): ${message}`, line };
}

function headerHint(trimmed: string, line: number): ApplyPatchParseFailure {
  return invalidHunk(
    `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    line,
  );
}

/** An update hunk with no chunks cannot be applied, so it is refused at close. */
function closeUpdateHunk(state: ParserState, line: number): ApplyPatchParseFailure | undefined {
  const last = state.hunks[state.hunks.length - 1];
  if (last === undefined || last.kind !== "update") {
    return undefined;
  }

  if (last.chunks.length === 0) {
    return invalidHunk(`Update file hunk for path '${last.path}' is empty`, state.updateLine ?? line);
  }

  const tail = last.chunks[last.chunks.length - 1];
  if (tail !== undefined && tail.oldLines.length === 0 && tail.newLines.length === 0) {
    return invalidHunk("Update hunk does not contain any lines", line);
  }

  return undefined;
}

function openHunk(state: ParserState, trimmed: string, line: number): ApplyPatchParseFailure | boolean {
  const isHeader =
    trimmed.startsWith(ADD_FILE_MARKER) || trimmed.startsWith(DELETE_FILE_MARKER) || trimmed.startsWith(UPDATE_FILE_MARKER);
  if (!isHeader) {
    return false;
  }

  if (state.hunks.length >= MAX_PATCH_HUNKS) {
    return invalidPatch(`more than ${MAX_PATCH_HUNKS} hunks`, line);
  }

  const failed = closeUpdateHunk(state, line);
  if (failed !== undefined) {
    return failed;
  }

  const add = trimmed.startsWith(ADD_FILE_MARKER) ? trimmed.slice(ADD_FILE_MARKER.length) : undefined;
  if (add !== undefined) {
    state.hunks.push({ kind: "add", path: add, contents: "" });
    state.updateLine = undefined;
    return true;
  }

  const remove = trimmed.startsWith(DELETE_FILE_MARKER) ? trimmed.slice(DELETE_FILE_MARKER.length) : undefined;
  if (remove !== undefined) {
    state.hunks.push({ kind: "delete", path: remove });
    state.updateLine = undefined;
    return true;
  }

  const update = trimmed.startsWith(UPDATE_FILE_MARKER) ? trimmed.slice(UPDATE_FILE_MARKER.length) : undefined;
  if (update !== undefined) {
    state.hunks.push({ kind: "update", path: update, moveTo: undefined, chunks: [] });
    state.updateLine = line;
    return true;
  }

  return false;
}

function readHeader(state: ParserState, trimmed: string, line: number): ApplyPatchParseFailure | true | false {
  if (trimmed === END_PATCH_MARKER) {
    const failed = closeUpdateHunk(state, line);
    if (failed !== undefined) {
      return failed;
    }
    state.ended = true;
    return true;
  }
  return openHunk(state, trimmed, line);
}

function currentChunk(state: ParserState): MutableChunk {
  const last = state.hunks[state.hunks.length - 1];
  if (last === undefined || last.kind !== "update") {
    throw new Error("apply_patch parser reached update body without an update hunk");
  }

  const tail = last.chunks[last.chunks.length - 1];
  if (tail !== undefined) {
    return tail;
  }

  const chunk = blankChunk();

  last.chunks.push(chunk);

  return chunk;
}

function readUpdateBody(
  state: ParserState,
  raw: string,
  updateLine: string,
  line: number,
): ApplyPatchParseFailure | undefined {
  const handled = readHeader(state, updateLine, line);
  if (handled === true) {
    return undefined;
  }

  if (handled !== false) {
    return handled;
  }

  const last = state.hunks[state.hunks.length - 1];
  if (last === undefined || last.kind !== "update") {
    return headerHint(updateLine, line);
  }

  const tail = last.chunks[last.chunks.length - 1];
  if (tail !== undefined && tail.endOfFile) {
    if (updateLine.length === 0) {
      return undefined;
    }
    if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      return invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${raw}'`, line);
    }
  }

  if (last.chunks.length === 0 && last.moveTo === undefined) {
    const moveTo = updateLine.startsWith(MOVE_TO_MARKER) ? updateLine.slice(MOVE_TO_MARKER.length) : undefined;
    if (moveTo !== undefined) {
      last.moveTo = moveTo;
      return undefined;
    }
  }

  if (
    (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) &&
    tail !== undefined &&
    tail.oldLines.length === 0 &&
    tail.newLines.length === 0
  ) {
    return invalidHunk(
      `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      line,
    );
  }

  if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
    last.chunks.push(blankChunk());
    return undefined;
  }

  if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
    last.chunks.push({
      ...blankChunk(),
      changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length),
    });
    return undefined;
  }

  if (updateLine === EOF_MARKER) {
    if (tail === undefined || (tail.oldLines.length === 0 && tail.newLines.length === 0)) {
      return invalidHunk("Update hunk does not contain any lines", line);
    }
    tail.endOfFile = true;
    return undefined;
  }

  if (raw.length === 0) {
    pushContextLine(currentChunk(state), "");
    return undefined;
  }

  if (raw.startsWith(" ")) {
    pushContextLine(currentChunk(state), raw.slice(1));
    return undefined;
  }

  if (raw.startsWith("+")) {
    currentChunk(state).newLines.push(raw.slice(1));
    return undefined;
  }

  if (raw.startsWith("-")) {
    currentChunk(state).oldLines.push(raw.slice(1));
    return undefined;
  }

  return invalidHunk(
    `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    line,
  );
}

function freezeChunk(chunk: MutableChunk): ApplyPatchUpdateChunk {
  return {
    changeContext: chunk.changeContext,
    oldLines: [...chunk.oldLines],
    newLines: [...chunk.newLines],
    contextPairs: chunk.contextPairs.map((pair) => [pair[0], pair[1]] as const),
    endOfFile: chunk.endOfFile,
  };
}

function freezeHunk(hunk: MutableHunk): ApplyPatchHunk {
  if (hunk.kind === "add") {
    return { kind: "add", path: hunk.path, contents: hunk.contents };
  }

  if (hunk.kind === "delete") {
    return { kind: "delete", path: hunk.path };
  }

  return {
    kind: "update",
    path: hunk.path,
    moveTo: hunk.moveTo,
    chunks: hunk.chunks.map(freezeChunk),
  };
}

/**
 * Parses one complete patch. Whole-text only: the caller already holds the
 * full `patch` argument, so there is no incremental line assembly to port.
 */
export function parseApplyPatch(patch: string): ApplyPatchParsed {
  const lines = patch.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length > MAX_PATCH_LINES) {
    return { ok: false, code: "invalid_patch", message: `invalid_patch: ${lines.length} lines above ${MAX_PATCH_LINES}`, line: 0 };
  }

  const state: ParserState = { started: false, ended: false, hunks: [], updateLine: undefined };

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const raw = lines[index] ?? "";

    if (!state.started) {
      if (raw.trim() === BEGIN_PATCH_MARKER) {
        state.started = true;
        continue;
      }
      return invalidPatch("The first line of the patch must be '*** Begin Patch'", line);
    }

    if (state.ended) {
      if (raw.trim().length === 0) {
        continue;
      }
      return invalidPatch("The last line of the patch must be '*** End Patch'", line);
    }

    const last = state.hunks[state.hunks.length - 1];
    if (last !== undefined && last.kind === "update") {
      const failed = readUpdateBody(state, raw, raw.trimEnd(), line);
      if (failed !== undefined) {
        return failed;
      }
      continue;
    }

    if (last !== undefined && last.kind === "add") {
      const trimmed = raw.trim();
      const handled = readHeader(state, trimmed, line);
      if (handled === true) {
        continue;
      }

      if (handled !== false) {
        return handled;
      }

      if (raw.startsWith("+")) {
        last.contents += `${raw.slice(1)}\n`;
        continue;
      }

      return headerHint(trimmed, line);
    }

    const trimmed = raw.trim();
    const handled = readHeader(state, trimmed, line);
    if (handled === true) {
      continue;
    }

    if (handled !== false) {
      return handled;
    }

    return headerHint(trimmed, line);
  }

  if (!state.started) {
    return invalidPatch("The first line of the patch must be '*** Begin Patch'", 0);
  }

  if (!state.ended) {
    return invalidPatch("The last line of the patch must be '*** End Patch'", lines.length);
  }

  return { ok: true, hunks: state.hunks.map(freezeHunk) };
}
