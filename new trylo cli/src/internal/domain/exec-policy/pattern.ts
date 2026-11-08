/**
 * Prefix patterns over a command's argument vector.
 *
 * Source of the semantics: Codex `execpolicy/src/rule.rs` (`PatternToken`,
 * `PrefixPattern`) at commit `73a1148c9c775c2a4616ce5096291740a00ed68a`. A rule
 * is written down once and then compared against an argv that is already split,
 * so there is no shell and no re-parsing here — the words are what they are.
 *
 * The important property, and the reason this file is not a security boundary:
 *
 *   a pattern is a **prefix**, so a command may carry arguments past the end of
 *   the pattern and still match. A rule that allows `git status` also allows
 *   `git status --anything`. That is inherited deliberately — it is upstream's
 *   contract — and it is why this layer cannot stand in for a sandbox. Given
 *   alternatives it is exactly as wide as the words written down, no wider.
 */

export type PatternToken =
  | { readonly kind: "single"; readonly text: string }
  | { readonly kind: "alts"; readonly texts: ReadonlyArray<string> };

/**
 * The first token is a single word: rules are keyed by program name, and a key
 * of alternatives is expanded into one rule per alternative when the policy is
 * built (see `rule.ts`), so nothing downstream has to guess which key a rule
 * lives under.
 */
export type PrefixPattern = {
  readonly first: string;
  readonly rest: ReadonlyArray<PatternToken>;
};

export type PatternTokenInput = string | ReadonlyArray<string>;

export type PatternParseResult =
  | { readonly ok: true; readonly tokens: ReadonlyArray<PatternToken> }
  | { readonly ok: false; readonly message: string };

const EMPTY_ALTS = "pattern alternatives cannot be empty";

function parseToken(input: PatternTokenInput): PatternToken | string {
  if (typeof input === "string") {
    if (input.length === 0) {
      return "pattern token cannot be an empty string";
    }
    return { kind: "single", text: input };
  }

  if (input.length === 0) {
    return EMPTY_ALTS;
  }

  for (const candidate of input) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      return "pattern alternative must be a non-empty string";
    }
  }

  return input.length === 1 && typeof input[0] === "string"
    ? { kind: "single", text: input[0] }
    : { kind: "alts", texts: input };
}

/**
 * `[["add","commit"],"--verbose"]`-shaped input becomes tokens. This is published
 * because the policy loader (`parse.ts`) is the only place that turns author
 * input into patterns; everything else receives an already-built policy.
 */
export function parsePatternTokens(input: ReadonlyArray<PatternTokenInput>): PatternParseResult {
  if (input.length === 0) {
    return { ok: false, message: "pattern cannot be empty" };
  }

  const tokens: PatternToken[] = [];

  for (const item of input) {
    const parsed = parseToken(item);
    if (typeof parsed === "string") {
      return { ok: false, message: parsed };
    }
    tokens.push(parsed);
  }

  return { ok: true, tokens };
}

export function tokenMatches(token: PatternToken, word: string): boolean {
  return token.kind === "single"
    ? token.text === word
    : token.texts.some((candidate) => candidate === word);
}

/**
 * The matched prefix, or `undefined` when this pattern does not apply.
 *
 * A command shorter than the pattern cannot match it: `git` alone is not covered
 * by a rule written for `git status`, because the rule author described a
 * longer invocation than this one is.
 */
export function matchPrefix(
  pattern: PrefixPattern,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  const length = pattern.rest.length + 1;
  if (argv.length < length) {
    return undefined;
  }

  const head = argv[0];
  if (head === undefined || head !== pattern.first) {
    return undefined;
  }

  for (let index = 0; index < pattern.rest.length; index += 1) {
    const token = pattern.rest[index];
    const word = argv[index + 1];
    if (token === undefined || word === undefined || !tokenMatches(token, word)) {
      return undefined;
    }
  }

  return argv.slice(0, length);
}

/** One written-down rendering, used for messages and for the reported prefix. */
export function renderPatternToken(token: PatternToken): string {
  return token.kind === "single" ? token.text : `[${token.texts.join("|")}]`;
}
