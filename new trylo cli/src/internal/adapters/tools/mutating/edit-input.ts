import type { JsonObject } from "../../../protocol/envelope.js";
import { lineEndingMatch } from "./edit-text-match.js";

export type EditInput =
  | { readonly kind: "patch"; readonly patch: string }
  | { readonly kind: "replace"; readonly oldString: string; readonly newString: string }
  | { readonly kind: "invalid"; readonly code: "invalid_arguments"; readonly message: string };

/** The planner and executor share one argument contract; neither guesses a mode. */
export function readEditInput(args: JsonObject): EditInput {
  const patch = args["patch"];
  const oldString = args["old_string"];
  const newString = args["new_string"];
  const invalid = (message: string): EditInput => ({ kind: "invalid", code: "invalid_arguments", message });

  if (patch !== undefined) {
    if (oldString !== undefined || newString !== undefined) return invalid("edit_file accepts patch or old_string/new_string, never both. For patch mode omit old_string and new_string entirely, including empty placeholders; for replacement mode omit patch. No file was changed.");
    return typeof patch === "string" && patch.trim().length > 0
      ? { kind: "patch", patch }
      : invalid("edit_file requires a non-empty patch");
  }

  if (typeof oldString !== "string" || oldString.length === 0 || typeof newString !== "string") {
    return invalid("edit_file requires either patch or a non-empty old_string and a string new_string");
  }

  if (oldString === newString) return invalid("edit_file old_string and new_string are identical; no change was requested");

  return { kind: "replace", oldString, newString };
}

/** Exact, unique replacement. BOM, whitespace and endings outside the match survive. */
export function replaceExactText(source: string, oldString: string, newString: string):
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const at = source.indexOf(oldString);
  if (at < 0) {
    const match = lineEndingMatch(source, oldString, newString);
    if (match.kind === "matched") return { ok: true, content: match.content };
    if (match.kind === "ambiguous") return ambiguousMatch();
    return { ok: false, code: "edit_match_not_found", message: "edit_match_not_found: old_string does not match, even after CRLF/LF normalization. Use the actual text from read_file or patch mode with surrounding context. No file was changed." };
  }

  if (source.indexOf(oldString, at + 1) >= 0) return ambiguousMatch();

  return { ok: true, content: source.slice(0, at) + newString + source.slice(at + oldString.length) };
}

function ambiguousMatch(): { readonly ok: false; readonly code: string; readonly message: string } {
  return { ok: false, code: "edit_match_ambiguous", message: "edit_match_ambiguous: old_string matches more than once; include more surrounding context. No file was changed." };
}
