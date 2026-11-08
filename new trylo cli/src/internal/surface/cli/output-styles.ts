/**
 * Output-style discovery (WP24.2 / L48).
 *
 * Mechanical reuse of the old CLI's `outputStyles` idea
 * (`trylo cli/src/outputStyles/loadOutputStylesDir.ts`,
 * `src/utils/frontmatterParser.ts::coerceDescriptionToString`,
 * `src/utils/markdownConfigLoader.ts::extractDescriptionFromMarkdown`):
 * a style is one markdown file, its filename is the default name, an
 * optional `---` frontmatter block carries `name` / `description` /
 * `keep-coding-instructions`, and the body is the prompt.
 *
 * Two deliberate narrowings, both documented rather than silent:
 *
 * - The old parser is full YAML; this one reads the three scalar keys it
 *   needs and ignores the rest. A style file never executes, so a key this
 *   loader does not understand is inert, not a risk.
 * - Discovery is `.trylo/output-styles/*.md` under the workspace (project,
 *   wins) plus the same directory under the Trylo home (user). The old
 *   `.claude/` layout and the plugin/managed layers are not read: this CLI
 *   owns neither that directory nor a plugin registry that could vouch for
 *   the files.
 *
 * Pure: bytes in, styles out. The caller supplies directory listings and
 * file reads so tests and the command layer share the exact code path.
 */

export type OutputStyleSource = "project" | "user";

export type OutputStyle = {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly source: OutputStyleSource;
  /** Mirrors the old `keep-coding-instructions` flag; recorded, see below. */
  readonly keepCodingInstructions?: boolean;
  readonly filePath: string;
};

export type StyleIo = {
  readonly readDir: (absolutePath: string) => ReadonlyArray<{ readonly name: string }>;
  readonly readFile: (absolutePath: string) => string | undefined;
};

const FRONTMATTER_DELIMITER = "---";

/** A style/workflow name is also a filename stem, so it cannot be a path. */
export function isStyleName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function parseScalarMap(lines: ReadonlyArray<string>): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    if (key.length === 0 || entries.has(key)) {
      continue;
    }

    entries.set(key, stripQuotes(line.slice(separator + 1)));
  }

  return entries;
}

function splitFrontmatter(text: string): { readonly fields: Map<string, string>; readonly body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return { fields: new Map(), body: text };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER);
  if (closing < 0) {
    return { fields: new Map(), body: text };
  }

  return { fields: parseScalarMap(lines.slice(1, closing)), body: lines.slice(closing + 1).join("\n") };
}

/**
 * Old `coerceDescriptionToString` trimmed scalars and dropped anything else;
 * this loader only ever produces strings, so the equivalent rule is trim and
 * fall back. Empty stays empty here and the caller applies the markdown
 * fallback, which keeps the two decisions visible instead of merged.
 */
function coerceDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Old `extractDescriptionFromMarkdown`: first non-empty line, `#` stripped. */
export function descriptionFromMarkdown(body: string, fallback: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const header = /^#+\s+(.+)$/.exec(trimmed);
    const text = (header?.[1] ?? trimmed).trim();
    if (text.length === 0) {
      continue;
    }

    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  }
  return fallback;
}

function parseKeepCodingInstructions(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
}

export function parseStyleFile(filePath: string, text: string, source: OutputStyleSource): OutputStyle | undefined {
  const stem = filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
  if (!isStyleName(stem)) {
    return undefined;
  }

  const { fields, body } = splitFrontmatter(text);
  const prompt = body.trim();
  if (prompt.length === 0) {
    return undefined;
  }

  const rawName = fields.get("name")?.trim() ?? "";
  const name = rawName.length > 0 && isStyleName(rawName) ? rawName : stem;
  const description =
    coerceDescription(fields.get("description")) ?? descriptionFromMarkdown(body, `Custom ${name} output style`);
  const keepCodingInstructions = parseKeepCodingInstructions(fields.get("keep-coding-instructions"));

  return {
    name,
    description,
    prompt,
    source,
    ...(keepCodingInstructions === undefined ? {} : { keepCodingInstructions }),
    filePath,
  };
}

function stylesInDir(io: StyleIo, dir: string, source: OutputStyleSource): OutputStyle[] {
  let entries: ReadonlyArray<{ readonly name: string }>;

  try {
    entries = io.readDir(dir);
  } catch {
    return [];
  }

  const styles: OutputStyle[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = `${dir}/${entry.name}`;
    let text: string | undefined;

    try {
      text = io.readFile(filePath);
    } catch {
      continue;
    }

    if (text === undefined) {
      continue;
    }

    const parsed = parseStyleFile(filePath, text, source);
    if (parsed !== undefined) {
      styles.push(parsed);
    }
  }

  return styles;
}

export type StyleDirs = {
  readonly projectDir: string;
  readonly userDir: string;
};

/**
 * Project styles override user styles by name; within one directory the
 * first file read wins and a duplicate name is dropped rather than merged.
 * A style named `default` is the absence of a style (the built-in), so a
 * file claiming it is ignored — `default` must stay byte-identical to never
 * having passed the flag.
 */
export function loadOutputStyles(io: StyleIo, dirs: StyleDirs): ReadonlyArray<OutputStyle> {
  const seen = new Set<string>();
  const collected: OutputStyle[] = [];

  for (const style of [...stylesInDir(io, dirs.projectDir, "project"), ...stylesInDir(io, dirs.userDir, "user")]) {
    if (style.name === "default" || seen.has(style.name)) {
      continue;
    }
    seen.add(style.name);
    collected.push(style);
  }

  return collected.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export function findOutputStyle(styles: ReadonlyArray<OutputStyle>, name: string): OutputStyle | undefined {
  return styles.find((style) => style.name === name);
}
