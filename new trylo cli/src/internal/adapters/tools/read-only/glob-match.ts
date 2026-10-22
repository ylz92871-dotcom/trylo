import { globProgram, type GlobToken } from "./glob-program.js";

/**
 * Glob compilation for `glob_files`: one pure function from a pattern string to
 * a matcher over forward-slash relative paths. No I/O, no state, no dependency.
 *
 * Supported syntax, deliberately the subset models already know from gitignore
 * and shell globs:
 *
 *  - `*`        any run of characters inside one path segment
 *  - `**`       any run of segments; when followed by a slash it means
 *               zero or more leading directories
 *  - `?`        exactly one character inside one segment
 *  - `{a,b}`    alternation, nestable; an unbalanced brace is a compile error
 *  - `[a-z]`    character class, `[!abc]` negation; empty or unterminated is
 *               a compile error
 *  - `\x`       literal `x`; a trailing backslash is a compile error
 *
 * A pattern with no unescaped `/` matches the *basename* at any depth — the
 * gitignore convention — so `*.ts` finds `src/deep/b.ts` without the caller
 * having to know the tree shape. A pattern containing `/` is anchored to the
 * whole relative path instead.
 */

export type GlobMatcher = {
  /** True when the pattern has no slash and therefore matches basenames. */
  readonly basenameOnly: boolean;
  matches(relativePath: string): boolean;
};

export type GlobCompileResult =
  | { readonly ok: true; readonly matcher: GlobMatcher }
  | { readonly ok: false; readonly code: "invalid_pattern"; readonly message: string };

class GlobSyntaxError extends Error {}

/** Finds the `}` matching the `{` at `open`, honoring nesting. -1 when absent. */
function matchingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "[") {
      const close = matchingBracket(pattern, i);
      if (close === -1) throw new GlobSyntaxError("unterminated character class");
      i = close;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Splits `{a,b}` body on top-level commas only. */
function splitAlternatives(body: string): Array<string> {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "\\") {
      current += char + (body[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (char === "[") {
      const close = matchingBracket(body, i);
      if (close === -1) throw new GlobSyntaxError("unterminated character class");
      current += body.slice(i, close + 1);
      i = close;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Finds the `]` closing the class opened at `open`. -1 when unterminated. */
function matchingBracket(pattern: string, open: number): number {
  for (let i = open + 1; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "]") {
      return i;
    }
  }
  return -1;
}

function compileClassBody(body: string): string {
  // `[!...]` is the glob spelling of the regex negation `[^...]`.
  const negated = body.startsWith("!") || body.startsWith("^");
  const rest = negated ? body.slice(1) : body;
  if (rest.length === 0) {
    throw new GlobSyntaxError("empty character class");
  }
  // Inside a class only `\`, `]` and `[` need care; ranges pass through, and a
  // backslash escape keeps its regex meaning.
  const escaped = rest.replace(/[[\]]/g, "\\$&");
  // Like `?` and `*`, a class describes one character within a segment.
  // Negated classes would otherwise consume '/' and silently cross folders.
  return `(?!/)[${negated ? "^" : ""}${escaped}]`;
}

const withinSegment = (char: string): boolean => char !== "/";
const dot = (char: string): boolean => !/[\n\r\u2028\u2029]/.test(char);
const literal = (value: string): GlobToken => ({ kind: "character", accepts: char => char === value });

/** Parsing retains the existing syntax; the executor never backtracks. */
function parseGlob(pattern: string, depth = 0): ReadonlyArray<GlobToken> {
  if (depth > 32) throw new GlobSyntaxError("brace nesting exceeds 32 levels");
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) throw new GlobSyntaxError("pattern ends with a backslash");
      tokens.push(literal(next)); i += 1;
    } else if (char === "{") {
      const close = matchingBrace(pattern, i);
      if (close < 0) throw new GlobSyntaxError("unbalanced '{'");
      const alternatives = splitAlternatives(pattern.slice(i + 1, close));
      if (alternatives.length < 2) throw new GlobSyntaxError("'{...}' needs at least one comma");
      tokens.push({ kind: "alternatives", branches: alternatives.map(part => parseGlob(part, depth + 1)) });
      i = close;
    } else if (char === "}") {
      throw new GlobSyntaxError("unbalanced '}'");
    } else if (char === "[") {
      const close = matchingBracket(pattern, i);
      if (close < 0) throw new GlobSyntaxError("unterminated character class");
      // A class sees exactly one code unit; there is no user repetition here.
      const expression = new RegExp(`^${compileClassBody(pattern.slice(i + 1, close))}$`);
      tokens.push({ kind: "character", accepts: value => expression.test(value) });
      i = close;
    } else if (char === "*") {
      if (pattern[i + 1] !== "*") tokens.push({ kind: "star", accepts: withinSegment });
      else {
        while (pattern[i + 1] === "*") i += 1;
        const star: GlobToken = { kind: "star", accepts: dot };
        if (pattern[i + 1] === "/") {
          tokens.push({ kind: "alternatives", branches: [[], [star, literal("/")]] });
          i += 1;
        } else tokens.push(star);
      }
    } else tokens.push(char === "?" ? { kind: "character", accepts: withinSegment } : literal(char));
  }
  return tokens;
}

function hasUnescapedSlash(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === "\\") {
      i += 1;
      continue;
    }
    if (pattern[i] === "/") {
      return true;
    }
  }
  return false;
}

export function compileGlob(pattern: string): GlobCompileResult {
  let matches: (text: string) => boolean;
  try {
    if (pattern.length > 4096) throw new GlobSyntaxError("pattern exceeds 4096 code units");
    matches = globProgram(parseGlob(pattern));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid pattern";
    return { ok: false, code: "invalid_pattern", message: `invalid_pattern:${reason}` };
  }
  const basenameOnly = !hasUnescapedSlash(pattern);
  return {
    ok: true,
    matcher: {
      basenameOnly,
      matches(relativePath: string): boolean {
        const target = basenameOnly
          ? relativePath.slice(relativePath.lastIndexOf("/") + 1)
          : relativePath;
        return matches(target);
      },
    },
  };
}
