/**
 * SKILL.md parsing and validation (WP14.1 / C51).
 *
 * Mechanical extraction of the old CLI's frontmatter handling (`utils/frontmatterParser.ts`)
 * and Codex's `skills/src/parser.rs`, reduced to the flat scalar/list grammar
 * skill frontmatter actually uses. Deliberately not a YAML engine: every field
 * this package consumes is a scalar or a string list, and a parser that admits
 * that much can also *reject* anything else loudly — a broken file must be an
 * explainable `invalid`, not a half-understood skill.
 */

export type ParsedSkill = {
  /** Frontmatter `name`, whitespace-collapsed; `undefined` means "use the directory name". */
  readonly name: string | undefined;
  readonly description: string;
  readonly whenToUse: string | undefined;
  readonly argumentHint: string | undefined;
  readonly argumentNames: ReadonlyArray<string> | undefined;
  readonly allowedTools: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string> | undefined;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly forkExecution: boolean;
  readonly body: string;
};

export type SkillParse =
  | { readonly kind: "ok"; readonly skill: ParsedSkill }
  | { readonly kind: "invalid"; readonly reason: string };

/** Codex's cap: a name that long is not a name, it is a sentence. */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_FALLBACK_LENGTH = 200;
const FRONTMATTER_LIMIT = 8 * 1024;
/** Boolean fields; any other spelling is an invalid file, not a default. */
const BOOLEAN_FIELDS = ["user-invocable", "disable-model-invocation"] as const;

export function parseSkillDocument(raw: string): SkillParse {
  const { frontmatter, body } = splitFrontmatter(raw);

  if (frontmatter === null) {
    return { kind: "ok", skill: fields({}, body) };
  }

  const data = parseFrontmatterLines(frontmatter);
  if (typeof data === "string") {
    return { kind: "invalid", reason: `parse: invalid frontmatter (${data})` };
  }

  const name = scalar(data["name"]);
  if (name !== undefined && name.length > MAX_NAME_LENGTH) {
    return { kind: "invalid", reason: `parse: name exceeds ${MAX_NAME_LENGTH} characters` };
  }

  for (const field of BOOLEAN_FIELDS) {
    const value = scalar(data[field]);
    if (value !== undefined && value !== "true" && value !== "false") {
      // Fail closed: an unrecognised spelling of a permission-relevant flag
      // must not silently become its permissive default (复核 F7).
      return { kind: "invalid", reason: `parse: unrecognized boolean '${field}: ${value}' (use true or false)` };
    }
  }

  return { kind: "ok", skill: fields(data, body) };
}

function fields(data: Record<string, string | string[]>, body: string): ParsedSkill {
  const description = scalar(data["description"]) ?? fallbackDescription(body);
  const paths = parsePaths(data["paths"]);
  const named = scalar(data["name"]);

  return {
    name: named === undefined ? undefined : collapseWhitespace(named),
    description,
    whenToUse: scalar(data["when_to_use"]),
    argumentHint: scalar(data["argument-hint"]),
    argumentNames: parseArgumentNames(data["arguments"]),
    allowedTools: parseList(data["allowed-tools"]) ?? [],
    paths: paths !== undefined && paths.length > 0 ? paths : undefined,
    userInvocable: booleanField(data["user-invocable"], true),
    disableModelInvocation: booleanField(data["disable-model-invocation"], false),
    forkExecution: scalar(data["context"]) === "fork",
    body,
  };
}

/**
 * Whole-file split, Codex style: the first line must be `---`, and the closing
 * `---` ends the frontmatter. A file without that shape is a skill with no
 * frontmatter at all, which is legal — its description falls back to the body.
 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { frontmatter: null, body: raw };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1 || closing === 1) {
    return { frontmatter: null, body: raw };
  }

  const frontmatter = lines.slice(1, closing).join("\n");
  if (frontmatter.length > FRONTMATTER_LIMIT) {
    return { frontmatter: null, body: raw };
  }

  return { frontmatter, body: lines.slice(closing + 1).join("\n").replace(/^\n/, "") };
}

/**
 * The one-pass frontmatter grammar: `key: scalar` and `key:` followed by
 * `- item` lines. Quotes are stripped; a trailing comment is dropped; anything
 * else (flow syntax, nested maps, unterminated brackets) is a named failure.
 */
export function parseFrontmatterLines(frontmatter: string): Record<string, string | string[]> | string {
  const data: Record<string, string | string[]> = {};
  let currentKey: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (currentKey === undefined) {
        return "list item outside a key";
      }

      const existing = data[currentKey];
      const list = Array.isArray(existing) ? existing : [];

      if (existing !== undefined && !Array.isArray(existing)) {
        return `mixed scalar and list for '${currentKey}'`;
      }

      list.push(stripQuotesAndComment(trimmed.slice(2)));
      data[currentKey] = list;
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      return `unparseable line '${trimmed}'`;
    }

    currentKey = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (value.length === 0) {
      data[currentKey] = [];
      continue;
    }

    data[currentKey] = stripQuotesAndComment(value);
  }

  return data;
}

/** Quotes are field delimiters, not content; ` #` starts a comment. */
function stripQuotesAndComment(value: string): string {
  let text = value;
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }

  const comment = text.indexOf(" #");
  if (comment !== -1) {
    text = text.slice(0, comment);
  }

  return text.trim();
}

function scalar(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseList(value: string | string[] | undefined): ReadonlyArray<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = typeof value === "string" ? splitCommaRespectingBraces(value) : value;
  const filtered = items.filter((item) => item.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Named arguments map to positional tokens, so a numeric name (`$0`) would
 * collide with the indexed shorthand; the old CLI's rule is kept: numeric-only
 * names are dropped, not rejected.
 */
function parseArgumentNames(value: string | string[] | undefined): ReadonlyArray<string> | undefined {
  const listed = parseList(value);
  const named = listed?.filter((name) => !/^\d+$/.test(name));
  return named !== undefined && named.length > 0 ? named : undefined;
}

/**
 * A comma inside `{...}` is part of one glob (`src/*.{ts,tsx}`), not a
 * separator — the same rule the old CLI's `splitPathInFrontmatter` applied.
 */
function splitCommaRespectingBraces(value: string): ReadonlyArray<string> {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const character of value) {
    if (character === "{") braceDepth += 1;

    if (character === "}") braceDepth -= 1;

    if (character === "," && braceDepth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current.trim());

  return parts;
}

/** The old CLI's `paths` grammar: comma split, brace expansion, trailing `/**` folds into the directory. */
function parsePaths(value: string | string[] | undefined): ReadonlyArray<string> | undefined {
  const listed = parseList(value);
  if (listed === undefined) {
    return undefined;
  }

  const expanded = listed.flatMap((pattern) => expandBraces(pattern)).map((pattern) => {
    const withoutTrailingAll = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    return withoutTrailingAll.replace(/\/+$/, "");
  });
  const kept = expanded.filter((pattern) => pattern.length > 0 && pattern !== "**");

  return kept;
}

function expandBraces(pattern: string): ReadonlyArray<string> {
  const match = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (match === null) {
    return [pattern];
  }

  const [, prefix, alternatives, suffix] = match;

  return (alternatives ?? "")
    .split(",")
    .map((alternative) => expandBraces(`${prefix ?? ""}${alternative.trim()}${suffix ?? ""}`))
    .flat();
}

/**
 * Only the validated spellings reach here (`parseSkillDocument` refuses
 * anything else), so an absent field takes its documented default and a
 * present one is exactly `"true"`/`"false"`.
 */
function booleanField(value: string | string[] | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value === "true";
}

function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter((part) => part.length > 0).join(" ");
}

function fallbackDescription(body: string): string {
  const line = body
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  const text = line ?? "";
  return text.length > MAX_DESCRIPTION_FALLBACK_LENGTH ? `${text.slice(0, MAX_DESCRIPTION_FALLBACK_LENGTH)}…` : text;
}
