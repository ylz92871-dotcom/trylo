import path from "node:path";
import type { InstructionReader } from "./instruction-reader.js";
import { MAX_INSTRUCTION_BYTES } from "./instruction-reader.js";

/**
 * `@path` imports in project instruction files (WP14 / L50, 复核 F3/F4).
 *
 * The old CLI's CLAUDE.md import grammar, narrowed to what can be bounded:
 *
 *  - a reference is honoured only when it sits **alone on a line** —
 *    `@./rules.md` — never inline, so a code sample can never pull a file into
 *    every request;
 *  - **every resolved import must stay inside the workspace.** The files being
 *    expanded come from the workspace's own rule chain, so an import that
 *    reaches outside it (`@~/…`, `@/etc/…`) is a project document asking the
 *    host to paste private bytes into the model request — that is refused and
 *    reported, not performed (复核 F3: the earlier draft allowed home imports
 *    and carried a dead `workspaceRoot` parameter; both are gone);
 *  - expansion is depth-limited, cycle-guarded and budget-capped in **bytes**,
 *    with the budget shared across the whole expansion (one tree, one budget —
 *    a nested chain cannot spend a fresh copy of it per branch). Every limit
 *    it hits is reported as a problem, never trimmed silently.
 */

export type ImportExpansion = {
  readonly text: string;
  readonly problems: ReadonlyArray<string>;
};

/** An import chain deeper than this is a document, not an instruction file. */
const MAX_IMPORT_DEPTH = 5;
/** Total bytes imports may add to one instruction file, across the whole tree. */
const DEFAULT_TOTAL_IMPORT_BYTES = 256 * 1024;

export type ImportExpansionInput = {
  readonly text: string;
  /** Directory of the file whose text is being expanded; bare refs resolve here. */
  readonly baseDirectory: string;
  readonly workspaceRoot: string;
  readonly reader: InstructionReader;
  /** Injection seam for tests; production uses {@link DEFAULT_TOTAL_IMPORT_BYTES}. */
  readonly maxTotalImportBytes?: number | undefined;
};

export function expandInstructionImports(input: ImportExpansionInput): ImportExpansion {
  const state: ExpansionState = {
    depth: 0,
    visiting: new Set<string>(),
    problems: [],
    budget: input.maxTotalImportBytes ?? DEFAULT_TOTAL_IMPORT_BYTES,
  };
  const text = expandText(input, state);

  return { text, problems: state.problems };
}

/**
 * One shared expansion state. `depth` is mutated on the way down and restored
 * on the way up (DFS path depth, not a per-branch copy), so sibling imports see
 * the budget their earlier siblings spent — one tree, one budget (复核 F4).
 */
type ExpansionState = {
  depth: number;
  /** Resolved paths of the files on the current expansion path. */
  readonly visiting: Set<string>;
  readonly problems: string[];
  /** Bytes imports may still add; every accepted import spends its own byte size. */
  budget: number;
};

function expandText(input: ImportExpansionInput, state: ExpansionState): string {
  return input.text
    .split("\n")
    .map((line) => {
      const reference = wholeLineReference(line);
      if (reference === undefined) {
        return line;
      }
      return expandReference(line, reference, input, state);
    })
    .join("\n");
}

/** A reference is `@` + one token, and nothing else may share the line; otherwise `undefined`. */
function wholeLineReference(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("@") || trimmed.length < 2) {
    return undefined;
  }

  const reference = trimmed.slice(1);
  if (/\s/.test(reference)) {
    return undefined;
  }

  return reference;
}

function expandReference(
  line: string,
  reference: string,
  input: ImportExpansionInput,
  state: ExpansionState,
): string {
  // A tilde reference names a file outside the workspace by definition; it is
  // refused here rather than resolved, so it can never become a relative path
  // that coincidentally lands inside the workspace (复核 F3).
  if (reference.startsWith("~")) {
    const homeish = `~/${reference.slice(1).replace(/^\/+/, "")}`;
    state.problems.push(`project_instructions_import_outside_root:${homeish}`);
    return `(@import refused: ${homeish} is outside the workspace)`;
  }

  const resolved = resolveReference(reference, input);
  if (resolved === undefined) {
    // Not a path we can name (e.g. a bare `@`); leave the line as written.
    return line;
  }

  if (!isPathWithinRoot(input.workspaceRoot, resolved)) {
    state.problems.push(`project_instructions_import_outside_root:${toForwardSlashes(resolved)}`);
    return `(@import refused: ${toForwardSlashes(resolved)} is outside the workspace)`;
  }

  if (state.depth >= MAX_IMPORT_DEPTH) {
    state.problems.push(`project_instructions_import_depth:${toForwardSlashes(resolved)}`);
    // The reference stays visible: its content was not included, and the model
    // (or the user) can still go and read it.
    return line;
  }

  const canonical = canonicalOf(resolved);
  if (state.visiting.has(canonical)) {
    // The content is already part of this expansion; the line has nothing to add.
    state.problems.push(`project_instructions_import_cycle:${toForwardSlashes(resolved)}`);
    return "";
  }

  const size = input.reader.fileSize(resolved);
  if (size === undefined) {
    state.problems.push(`project_instructions_import_missing:${toForwardSlashes(resolved)}`);
    return `(@import not readable: ${toForwardSlashes(resolved)})`;
  }

  if (size > MAX_INSTRUCTION_BYTES) {
    state.problems.push(`project_instructions_import_oversized:${toForwardSlashes(resolved)}`);
    return `(@import too large to include: ${toForwardSlashes(resolved)})`;
  }

  const text = input.reader.readText(resolved);
  if (text === undefined) {
    state.problems.push(`project_instructions_import_missing:${toForwardSlashes(resolved)}`);
    return `(@import not readable: ${toForwardSlashes(resolved)})`;
  }

  const byteSize = Buffer.byteLength(text, "utf8");
  if (byteSize > state.budget) {
    state.problems.push(`project_instructions_import_budget:${toForwardSlashes(resolved)}`);
    return `(@import not included: instruction import budget exhausted at ${toForwardSlashes(resolved)})`;
  }

  state.budget -= byteSize;
  state.visiting.add(canonical);
  const parentDepth = state.depth;

  state.depth = parentDepth + 1;

  try {
    const expanded = expandText(
      { ...input, text, baseDirectory: path.dirname(resolved) },
      state,
    );
    return expanded.replace(/\n+$/, "");
  } finally {
    state.visiting.delete(canonical);
    state.depth = parentDepth;
  }
}

/**
 * `@./name` and bare `@name` are relative to the importing file;
 * `@/absolute` is taken as written. `@~/…` is deliberately **not** supported:
 * a workspace rule file may only pull workspace files (see the module header —
 * 复核 F3), so a tilde reference resolves like any relative one and the
 * containment check, not the prefix, decides.
 */
function resolveReference(reference: string, input: ImportExpansionInput): string | undefined {
  if (path.isAbsolute(reference)) {
    return path.resolve(reference);
  }
  const bare = reference.startsWith("./") || reference.startsWith("..") ? reference : `./${reference}`;
  return path.resolve(input.baseDirectory, bare);
}

/**
 * Containment predicate, workspace-relative: `candidate` must resolve strictly
 * inside `root`. The import budget bounds how much any admitted import can
 * contribute; this bounds *which* files may contribute at all.
 */
function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function canonicalOf(absolutePath: string): string {
  return absolutePath.replaceAll("\\", "/");
}

function toForwardSlashes(absolutePath: string): string {
  return absolutePath.replaceAll("\\", "/");
}
