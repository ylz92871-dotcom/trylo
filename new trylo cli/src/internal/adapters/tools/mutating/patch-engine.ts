/**
 * A bounded unified diff: one file, no renames, no creation, no guessing.
 *
 * Everything a general-purpose patch tool has to worry about — multiple files,
 * mode changes, binary hunks, fuzz — is a hole here, so every one of those is a
 * parse failure instead of a behaviour. What is left either applies completely
 * or leaves the file byte-identical, because a partially applied patch is worse
 * than a refused one: it looks like success.
 */

export const MAX_PATCH_LINES = 2_000;
export const MAX_PATCH_HUNKS = 64;

export type PatchLineKind = "context" | "removed" | "added";

export type PatchLine = {
  readonly kind: PatchLineKind;
  readonly text: string;
};

export type PatchHunk = {
  readonly index: number;
  readonly oldStart: number;
  /**
   * Declared line counts, absent for a rangeless header (`@@`).
   *
   * A rangeless hunk is located by its *content*, exactly like every other
   * hunk; what the missing counts remove is the consistency check between the
   * header and the body, because there is no header to check against. Nothing
   * about "applies completely or not at all" weakens — the content still has to
   * match, or the whole patch is refused.
   */
  readonly oldCount?: number;
  readonly newStart: number;
  readonly newCount?: number;
  readonly lines: readonly PatchLine[];
};

export type PatchFailure = { readonly ok: false; readonly code: string; readonly message: string };

export type ParsedPatch = { readonly ok: true; readonly hunks: readonly PatchHunk[] } | PatchFailure;

export type PreparedSource = {
  readonly bom?: "\uFEFF";
  readonly lines: readonly string[];
  readonly trailingNewline: boolean;
  /**
   * The terminator that followed each line (`"\r\n"`, `"\n"`, or `""` for a
   * final unterminated line). Matching runs on the stripped text so an LF
   * patch meets a CRLF file; reassembly puts every byte back, so untouched
   * lines — and the file's style — never change (hard-eval #12).
   */
  readonly endings: ReadonlyArray<"\r\n" | "\n" | "">;
};

export type PatchedContent = { readonly ok: true; readonly content: string; readonly hunksApplied: number } | PatchFailure;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * `@@` on its own — the header with its ranges left out.
 *
 * Models write this constantly (three separate turns of the acceptance task
 * produced it) and the content still decides everything. Refusing it taught the
 * model nothing: the error named the line, not the missing line numbers, so the
 * next attempt repeated it verbatim until the iteration budget ran out.
 *
 * Deliberately *not* "any line starting with `@@`": a header with text after it
 * is either a real ranged header or a malformed one, and both of those have
 * their own answer.
 */
const RANGELESS_HUNK_HEADER = /^@@\s*$/;

function fail(code: string, message: string): PatchFailure {
  return { ok: false, code, message };
}

export function prepareSource(raw: string): PreparedSource {
  const bom = raw.startsWith("\uFEFF");
  const lines = (bom ? raw.slice(1) : raw).split("\n");
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) {
    lines.pop();
  }

  const endings: Array<"\r\n" | "\n" | ""> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (index === lines.length - 1 && !trailingNewline) {
      endings.push("");
      continue;
    }

    if (line.endsWith("\r")) {
      lines[index] = line.slice(0, -1);
      endings.push("\r\n");
      continue;
    }

    endings.push("\n");
  }

  return { lines, trailingNewline, endings, ...(bom ? { bom: "\uFEFF" as const } : {}) };
}

type ParserState = {
  headers: number;
  readonly hunks: PatchHunk[];
  current: PatchHunk | undefined;
  body: PatchLine[];
};

type Step = { readonly ok: true } | { readonly ok: false; readonly failure: PatchFailure };

type BodyStep =
  | { readonly ok: true; readonly line: PatchLine }
  | { readonly ok: false; readonly failure: PatchFailure };

/**
 * Accepts the header preamble a real diff carries (`diff --git`, `index`) but
 * insists on exactly one file pair: anything that looks like it might describe
 * a second file is refused rather than applied to the wrong one.
 *
 * The scan is a loop over three pure helpers. Every prefix judgement lives in
 * the helper it belongs to, so the loop reads as the order of decisions rather
 * than a wall of string prefixes.
 */
export function parseUnifiedPatch(patch: string): ParsedPatch {
  // The trailing newline that ends every diff would otherwise become one more
  // (empty) context line and break every hunk's declared counts.
  const lines = patch.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length > MAX_PATCH_LINES) {
    return fail("patch_too_large", `patch_too_large: ${lines.length} lines above ${MAX_PATCH_LINES}`);
  }

  const parser: ParserState = { headers: 0, hunks: [], current: undefined, body: [] };

  for (const line of lines) {
    const opened = openHunk(parser, line);
    if (opened !== undefined) {
      if (!opened.ok) {
        return opened.failure;
      }
      continue;
    }

    if (parser.current === undefined) {
      const preamble = readPreamble(parser, line);
      if (preamble !== undefined) {
        return preamble;
      }
      continue;
    }

    if (line.startsWith("@@")) {
      return fail("patch_parse_failed", "patch_parse_failed: malformed hunk header");
    }

    const body = readBodyLine(line);
    if (body === undefined) {
      continue;
    }

    if (!body.ok) {
      return body.failure;
    }

    parser.body.push(body.line);
  }

  return finishParsing(parser);
}

/** Opens a new hunk when the line is one, and refuses an oversized patch. */
function openHunk(parser: ParserState, line: string): Step | undefined {
  const header = HUNK_HEADER.exec(line);
  const rangeless = header === null && RANGELESS_HUNK_HEADER.test(line);
  if (header === null && !rangeless) {
    return undefined;
  }

  const closed = closeHunk(parser);
  if (closed !== undefined) {
    return { ok: false, failure: closed };
  }

  if (parser.hunks.length >= MAX_PATCH_HUNKS) {
    return {
      ok: false,
      failure: fail("patch_too_large", `patch_too_large: more than ${MAX_PATCH_HUNKS} hunks`),
    };
  }

  parser.current =
    header === null
      ? // No declared position and no declared counts: the body alone decides
        // what this hunk covers, and `locate` finds it by content.
        { index: parser.hunks.length, oldStart: 0, newStart: 0, lines: [] }
      : {
          index: parser.hunks.length,
          oldStart: Number(header[1]),
          oldCount: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newCount: header[4] === undefined ? 1 : Number(header[4]),
          lines: [],
        };

  return { ok: true };
}

/**
 * Lines before the first hunk: exactly one `---`/`+++` pair is tolerated, the
 * usual diff chatter is skipped, anything else is refused.
 */
function readPreamble(parser: ParserState, line: string): PatchFailure | undefined {
  if (line.startsWith("---") || line.startsWith("+++")) {
    parser.headers += 1;
    return undefined;
  }

  if (isPreambleChatter(line)) {
    return undefined;
  }

  return fail(
    "patch_parse_failed",
    `patch_parse_failed: unexpected line before any hunk: ${JSON.stringify(line.slice(0, 60))}`,
  );
}

function isPreambleChatter(line: string): boolean {
  return (
    line.trim().length === 0 ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file")
  );
}

/** Body lines inside a hunk: the prefix decides the kind, nothing is guessed. */
function readBodyLine(line: string): BodyStep | undefined {
  if (line.startsWith("\\")) {
    // "\ No newline at end of file" describes the previous line; skip it.
    return undefined;
  }

  if (line.startsWith("---") || line.startsWith("+++")) {
    return {
      ok: false,
      failure: fail("patch_parse_failed", "patch_parse_failed: a second file header was found"),
    };
  }

  if (line.startsWith(" ")) {
    return { ok: true, line: { kind: "context", text: line.slice(1) } };
  }

  if (line.startsWith("-")) {
    return { ok: true, line: { kind: "removed", text: line.slice(1) } };
  }

  if (line.startsWith("+")) {
    return { ok: true, line: { kind: "added", text: line.slice(1) } };
  }

  if (line.length === 0) {
    // A blank line inside a hunk is context with no trailing space, which
    // every real diff emitter produces sometimes.
    return { ok: true, line: { kind: "context", text: "" } };
  }

  return {
    ok: false,
    failure: fail(
      "patch_parse_failed",
      `patch_parse_failed: unrecognised hunk line: ${JSON.stringify(line.slice(0, 60))}. Each context line needs one diff-space PLUS original indentation; removed/added lines need -/+ followed by the full original line. Send raw diff without Markdown fences.`,
    ),
  };
}

/** Closes the open hunk after checking its declared counts against its body. */
function closeHunk(parser: ParserState): PatchFailure | undefined {
  const current = parser.current;
  if (current === undefined) {
    return undefined;
  }

  const oldCount = parser.body.filter((line) => line.kind !== "added").length;
  const newCount = parser.body.filter((line) => line.kind !== "removed").length;
  if (current.oldCount !== undefined && (oldCount !== current.oldCount || newCount !== current.newCount)) {
    return fail(
      "patch_parse_failed",
      `patch_parse_failed: hunk ${current.index} declares -${current.oldCount}/+${current.newCount} but carries ${oldCount}/${newCount}; either resend with a rangeless header (\`@@\`) which locates by content alone, or correct the header to -${oldCount}/+${newCount}`,
    );
  }

  parser.hunks.push({ ...current, lines: [...parser.body] });
  parser.current = undefined;
  parser.body = [];

  return undefined;
}

function finishParsing(parser: ParserState): ParsedPatch {
  const closed = closeHunk(parser);
  if (closed !== undefined) {
    return closed;
  }

  if (parser.hunks.length === 0) {
    return fail("patch_parse_failed", "patch_parse_failed: no hunks found");
  }

  if (parser.headers !== 0 && parser.headers !== 2) {
    return fail(
      "patch_parse_failed",
      `patch_parse_failed: expected one file header pair, found ${parser.headers} header lines`,
    );
  }

  return { ok: true, hunks: parser.hunks };
}

function oldBlockOf(hunk: PatchHunk): readonly string[] {
  return hunk.lines.filter((line) => line.kind !== "added").map((line) => line.text);
}

/**
 * Location search, then nothing else: the hunk either fits the file exactly or
 * it is refused. The nearest match to the declared line wins when context is
 * ambiguous, which keeps the result deterministic instead of "whichever one the
 * search happened to see first". Rangeless hunks search only the unconsumed
 * suffix: otherwise a repeated line earlier in the file wins every time and
 * produces a false overlap despite a valid match after the previous hunk.
 */
function locate(lines: readonly string[], hunk: PatchHunk, searchStart = 0): number | undefined {
  const block = oldBlockOf(hunk);
  if (block.length === 0) {
    return Math.min(Math.max(hunk.oldStart, searchStart), lines.length);
  }

  const declared = Math.max(0, hunk.oldStart - 1);
  let best: number | undefined;

  for (let start = searchStart; start + block.length <= lines.length; start += 1) {
    let matches = true;

    for (let offset = 0; offset < block.length; offset += 1) {
      if (lines[start + offset] !== block[offset]) {
        matches = false;
        break;
      }
    }

    if (!matches) {
      continue;
    }

    if (best === undefined || Math.abs(start - declared) < Math.abs(best - declared)) {
      best = start;
    }
  }

  return best;
}

export function applyPatch(source: PreparedSource, hunks: readonly PatchHunk[]): PatchedContent {
  // Added lines take the file's own style (CRLF majority wins, ties go LF);
  // every other line keeps the terminator it arrived with, byte for byte.
  const crlf = source.endings.filter((ending) => ending === "\r\n").length;
  const lf = source.endings.filter((ending) => ending === "\n").length;
  const style: "\r\n" | "\n" = crlf > lf ? "\r\n" : "\n";
  const out: Array<{ readonly text: string; readonly ending: string }> = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const searchStart = hunk.oldCount === undefined ? cursor : 0;
    // A backward-only match is retained solely to report the ordering error;
    // it must never be applied over a previously consumed source region.
    const at = locate(source.lines, hunk, searchStart) ?? locate(source.lines, hunk);
    if (at === undefined) {
      const wanted = oldBlockOf(hunk)[0] ?? "";
      return fail(
        "patch_hunk_mismatch",
        `patch_hunk_mismatch: hunk ${hunk.index} expected ${JSON.stringify(wanted.slice(0, 100))}${hunk.oldStart === 0 ? " but found no exact context" : ` near line ${hunk.oldStart}`}. Context lines need one diff-space PLUS original indentation (source " * x" becomes patch "  * x"); -/+ lines also retain original indentation. Copy exact text from read_file and send raw diff without Markdown fences.`,
      );
    }

    if (at < cursor) {
      return fail("patch_hunk_mismatch", `patch_hunk_mismatch: hunk ${hunk.index} overlaps the previous hunk (starts at original line ${at + 1}, before line ${cursor + 1}). Send hunks in file order and merge shared context into one hunk, or use a unique old_string/new_string edit. No file was changed.`);
    }

    for (let index = cursor; index < at; index += 1) {
      out.push({ text: source.lines[index] ?? "", ending: source.endings[index] ?? "\n" });
    }

    // Context lines *are* source lines: they keep the terminator they arrived
    // with. A line that replaces removed lines takes the first removed line's
    // slot — and its terminator. Only a pure insertion (no removed line to
    // stand in for) takes the file style, which exists nowhere yet either.
    let position = at;
    const freed: string[] = [];

    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        freed.push(source.endings[position] ?? style);
        position += 1;
        continue;
      }

      if (line.kind === "added") {
        out.push({ text: line.text, ending: freed.shift() ?? style });
        continue;
      }

      out.push({ text: source.lines[position] ?? line.text, ending: source.endings[position] ?? style });
      position += 1;
    }

    cursor = at + oldBlockOf(hunk).length;
  }

  for (let index = cursor; index < source.lines.length; index += 1) {
    out.push({ text: source.lines[index] ?? "", ending: source.endings[index] ?? "\n" });
  }

  return { ok: true, content: (source.bom ?? "") + out.map((line) => `${line.text}${line.ending}`).join(""), hunksApplied: hunks.length };
}
