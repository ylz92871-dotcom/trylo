/**
 * Finding a file when you only half-remember its name.
 *
 * The gap this fills: `glob_files` needs an exact pattern and `search_text` needs
 * exact content, so both fail the ordinary human move of typing three letters of
 * a filename. That is not a rare case — it is how people actually address files.
 *
 * Two things this deliberately is not:
 *
 *   - **Not a content search.** A filename match says nothing about what is
 *     inside the file. Reporting it as though it did is how a model ends up
 *     citing a file it never read, so the two live in separate tools with
 *     separate contracts and separate answers.
 *   - **Not a second walker.** Enumeration, `.gitignore`, default exclusions and
 *     the depth/file ceilings all come from `read-only/walk.ts`, the same code
 *     `search_text` uses. A file that `search_text` cannot see is a file this
 *     cannot suggest; two traversals with two notions of "in the project" is how
 *     those notions drift apart.
 *
 * The index is built once per workspace and reused. Rebuilding per keystroke is
 * what makes a fuzzy finder feel slow, and the whole point of the feature is that
 * it feels immediate.
 */

import type { FileSystemReader } from "../read-only/limits.js";
import { createNavigationView, DEFAULT_EXCLUDED_DIRECTORIES } from "../read-only/navigation-view.js";
import { walkWorkspaceFiles } from "../read-only/walk.js";
import { FileIndex } from "./fuzzy-index.js";

export type FileCandidate = {
  /** Workspace-relative, `/` separators — the same spelling read_file takes. */
  readonly path: string;
};

export type FileFinderConfig = {
  readonly workspaceRoot: string;
  readonly reader: FileSystemReader;
  readonly excludeDirectories?: ReadonlyArray<string>;
  /** Enumeration ceilings. Same defaults the text search uses. */
  readonly maxIndexedFiles?: number;
  readonly maxDepth?: number;
  /**
   * Workspace-relative roots to index **before** the rest, so a project's own
   * source outranks vendored or archived trees when the ceiling bites.
   *
   * This exists because of a measured failure, not a hypothetical one: with a
   * flat walk over this repository the depth-first descent reaches `open/`
   * (thousands of reference checkouts) before `src/`, and the index filled up
   * without ever seeing `mention.ts`. Sorting whole subtrees is enough to fix the
   * ranking without changing any other tool's behaviour.
   */
  readonly priorityRoots?: ReadonlyArray<string>;
};

export type FileSearchOutcome = {
  readonly matches: ReadonlyArray<FileCandidate>;
  /** True when the index itself is incomplete, so an empty answer is not "no such file". */
  readonly indexTruncated: boolean;
  readonly filesIndexed: number;
  readonly reasons: ReadonlyArray<string>;
};

/**
 * Matches the read-only tools' defaults so one project yields one file set.
 *
 * Sized for a real tree rather than a tidy demo: the first end-to-end probe on
 * this repository hit the previous 20 000 ceiling and, because the walk is
 * depth-first and `open/` (several thousand vendored reference trees) sorts
 * early, the index filled up before reaching `src/`. A fuzzy finder that cannot
 * find `mention.ts` is worse than none, so the ceiling is high enough for this
 * repo and the caller is told when it is still not enough.
 */
const DEFAULT_MAX_INDEXED_FILES = 200_000;
const DEFAULT_MAX_DEPTH = 16;

export class FileFinder {
  private index: FileIndex | undefined;
  private building: Promise<void> | undefined;
  private indexedCount = 0;
  private indexReasons: ReadonlyArray<string> = [];

  constructor(private readonly config: FileFinderConfig) {}

  /**
   * Names matching `query`, best first. Ranking only; the fuzzy index's score is
   * a rank, not a similarity, so it is deliberately not returned here — a caller
   * that thresholded on it would be reading a number that does not mean what it
   * looks like.
   */
  async find(query: string, limit: number, signal: AbortSignal): Promise<FileSearchOutcome> {
    const trimmed = query.trim();

    // An empty query is not "everything": a picker with no query yet should offer
    // nothing rather than an arbitrary 200 paths the person then has to scroll.
    if (trimmed.length === 0 || limit <= 0) {
      return { matches: [], indexTruncated: this.indexReasons.length > 0, filesIndexed: this.indexedCount, reasons: this.indexReasons };
    }

    await this.ensureIndexed(signal);

    if (signal.aborted) {
      return { matches: [], indexTruncated: true, filesIndexed: this.indexedCount, reasons: [...this.indexReasons, "cancelled"] };
    }

    const index = this.index;
    if (index === undefined) {
      return { matches: [], indexTruncated: true, filesIndexed: 0, reasons: [...this.indexReasons, "index_unavailable"] };
    }

    return {
      matches: index.search(trimmed, limit).map((hit) => ({ path: hit.path })),
      indexTruncated: this.indexReasons.length > 0,
      filesIndexed: this.indexedCount,
      reasons: this.indexReasons,
    };
  }

  /** Forget the index. Called when the project changes underneath a long session. */
  invalidate(): void {
    this.index = undefined;
    this.building = undefined;
    this.indexedCount = 0;
    this.indexReasons = [];
  }

  /**
   * Built at most once concurrently: a picker that fires on every keystroke would
   * otherwise start a full enumeration per key.
   */
  private async ensureIndexed(signal: AbortSignal): Promise<void> {
    if (this.index !== undefined) {
      return;
    }

    if (this.building !== undefined) {
      return this.building;
    }

    this.building = this.build(signal).finally(() => {
      this.building = undefined;
    });

    return this.building;
  }

  private async build(signal: AbortSignal): Promise<void> {
    const paths: string[] = [];
    // The same visibility rules `search_text` applies, including nested
    // .gitignore and the default exclusions. Reusing the view rather than
    // re-deriving the rules is what keeps "a file search_text cannot see" and
    // "a file find_files will not suggest" the same statement.
    const view = createNavigationView({
      workspaceRoot: this.config.workspaceRoot,
      reader: this.config.reader,
      ...(this.config.excludeDirectories === undefined ? {} : { excludeDirectories: this.config.excludeDirectories }),
      filters: { include: [], exclude: [] },
    });
    const stats = await collectPaths(this.config, view.visible, signal, paths);

    if (signal.aborted) {
      return;
    }

    const index = new FileIndex();

    index.loadFromFileList(paths);
    this.index = index;
    this.indexedCount = paths.length;
    // Carried forward so an empty answer can say "the index is incomplete"
    // instead of implying the project has no such file.
    this.indexReasons = [...stats];
  }
}

/**
 * Walk the priority roots first, then everything else.
 *
 * The second pass skips what the first already took, so the union is the same set
 * of files a flat walk would produce — only the order in which they are indexed
 * changes, and order is exactly what decides who survives the ceiling.
 */
async function collectPaths(
  config: FileFinderConfig,
  visible: (absolute: string, directory: boolean) => Promise<boolean>,
  signal: AbortSignal,
  sink: string[],
): Promise<ReadonlyArray<string>> {
  const seen = new Set<string>();
  const reasons = new Set<string>();
  /**
   * `prefix` is the part of the workspace path that `walkWorkspaceFiles` cannot
   * know about, because it reports names relative to the root *it* was given.
   * Walking `src/` first therefore yields `surface/cli/mention.ts`, and handing
   * that to `read_file` would not open the file. Re-attaching the prefix here is
   * what keeps one canonical spelling across both passes.
   */
  const walkRoot = async (rootAbsolute: string, prefix: string): Promise<void> => {
    const stats = await walkWorkspaceFiles({
      reader: config.reader,
      rootAbsolute,
      excludeDirectories: new Set(config.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES),
      maxFiles: config.maxIndexedFiles ?? DEFAULT_MAX_INDEXED_FILES,
      maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
      signal,
      visible,
      onFile(file) {
        const relative = prefix === "" ? file.relative : file.absolute === rootAbsolute ? prefix : `${prefix}/${file.relative}`;
        if (seen.has(relative)) {
          return true;
        }

        seen.add(relative);
        sink.push(relative);

        return true;
      },
    });
    for (const reason of stats.truncationReasons) {
      reasons.add(reason);
    }
  };

  for (const priority of config.priorityRoots ?? []) {
    if (signal.aborted) break;
    await walkRoot(`${config.workspaceRoot}/${priority}`, priority);
  }

  if (!signal.aborted && seen.size < (config.maxIndexedFiles ?? DEFAULT_MAX_INDEXED_FILES)) {
    await walkRoot(config.workspaceRoot, "");
  }

  return [...reasons];
}
