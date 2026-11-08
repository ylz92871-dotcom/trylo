/**
 * Argument substitution for skill invocation (WP14.1).
 *
 * The old CLI's `utils/argumentSubstitution.ts` contract, ported without the
 * shell-quote dependency: a quote-aware whitespace split replaces the shell
 * grammar, and malformed quoting falls back to the same whitespace split the
 * old code fell back to. The placeholder grammar is unchanged, so skill bodies
 * written for the old CLI substitute identically.
 */

/**
 * Splits an argument string into tokens: whitespace-separated, with single- and
 * double-quoted spans kept whole. A `"` or `'` that never closes is not an
 * error — it falls back to splitting the whole string on whitespace, exactly as
 * the shell-quote failure path did.
 */
export function parseArgumentTokens(args: string): ReadonlyArray<string> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const tokens = splitQuoted(trimmed);
  return tokens ?? trimmed.split(/\s+/).filter((token) => token.length > 0);
}

function splitQuoted(args: string): ReadonlyArray<string> | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;

  for (const character of args) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (quote !== undefined) {
    return undefined;
  }

  if (started || current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Substitutes `$ARGUMENTS` placeholders in a skill body.
 *
 * - `$ARGUMENTS` — the full argument string
 * - `$ARGUMENTS[n]` and `$n` — one token each, empty when absent
 * - named placeholders from the frontmatter `arguments` field — positionally
 *   mapped, empty when the invocation did not supply that many tokens
 *
 * When the body has no placeholder and arguments were supplied, the arguments
 * are appended as an `ARGUMENTS:` line rather than silently dropped. An absent
 * (`undefined`) argument string leaves the body untouched; an empty one is a
 * real invocation with no arguments and clears the placeholders.
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  argumentNames: ReadonlyArray<string>,
  appendIfNoPlaceholder: boolean,
): string {
  if (args === undefined) {
    return content;
  }

  const parsed = parseArgumentTokens(args);
  const original = content;
  let result = content;

  argumentNames.forEach((name, index) => {
    result = result.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, "g"), parsed[index] ?? "");
  });
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, index: string) => parsed[Number(index)] ?? "");
  result = result.replace(/\$(\d+)(?!\w)/g, (_, index: string) => parsed[Number(index)] ?? "");
  result = result.replaceAll("$ARGUMENTS", args);

  if (result === original && appendIfNoPlaceholder && args.length > 0) {
    return `${result}\n\nARGUMENTS: ${args}`;
  }

  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
