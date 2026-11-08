/** Match only line-ending differences; whitespace and content stay exact. */
export function lineEndingMatch(source: string, oldString: string, newString: string):
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "matched"; readonly content: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  const needle = oldString.replace(/\r\n/g, "\n");
  const at = normalized.indexOf(needle);
  if (at < 0) return { kind: "missing" };

  if (normalized.indexOf(needle, at + 1) >= 0) return { kind: "ambiguous" };

  const start = sourceOffset(source, at), end = sourceOffset(source, at + needle.length);
  const ending = source.slice(start, end).includes("\r\n") ? "\r\n" : "\n";
  const replacement = newString.replace(/\r\n/g, "\n").replace(/\n/g, ending);

  return { kind: "matched", content: source.slice(0, start) + replacement + source.slice(end) };
}

/** Translate normalized offsets back into the unchanged original bytes. */
function sourceOffset(source: string, normalizedOffset: number): number {
  let original = 0;
  for (let normalized = 0; normalized < normalizedOffset; normalized += 1) {
    original += source[original] === "\r" && source[original + 1] === "\n" ? 2 : 1;
  }
  return original;
}
