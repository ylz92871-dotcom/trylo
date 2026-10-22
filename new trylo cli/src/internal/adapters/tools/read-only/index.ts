import type { FileAccessMode, ToolCallRequest, ToolOutcome, ToolPort } from "../../../ports/tools.js";
import path from "node:path";
import type { ValidatedImageReferenceSink } from "../../../ports/image-reference-access.js";
import { directoryArgument } from "./args.js";
import { READ_ONLY_BINDINGS } from "./bindings.js";
import type { LocalRuleLookup } from "../../project-instructions/appendix.js";
import {
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_READ_ONLY_LIMITS,
  type DirectoryEntry,
  type FileSystemReader,
  type ReadOnlyToolLimits,
} from "./limits.js";
import { executeReadFile } from "./read-file.js";
import { executeReadPdf, READ_PDF_TOOL, type PdfRunner } from "./pdf-read.js";
import { executeReadNotebook, READ_NOTEBOOK_TOOL } from "./notebook-read.js";
import { executeViewImage } from "./view-image.js";
import { executeNavigationSearch } from "./search.js";
import { executeFindFiles } from "./find-files.js";
import { FileFinder } from "../file-finder/file-finder.js";
import { createNavigationView, navigationRoot, DEFAULT_EXCLUDED_DIRECTORIES } from "./navigation-view.js";
export { DEFAULT_EXCLUDED_DIRECTORIES };
import { isInside, resolveInsideWorkspace } from "./workspace.js";

/**
 * The built-in read-only tools: read, list, search, glob. Strictly read-only:
 * no writes, no shell, no network, no installers. Mutating tools live in
 * `../mutating` and only ship when a sandbox bounds them.
 *
 * This file is the dispatch — what happens when a tool is called. What a tool
 * *is* (name, description, schema) lives in `bindings.ts`, and the ceilings in
 * `limits.ts`; both are re-exported from here because this module was where
 * callers found them, and a move that breaks every import is a move nobody does
 * halfway. `read_file`'s own execution is in `read-file.ts` and the range
 * arithmetic in `range.ts`.
 */

export {
  DEFAULT_MAX_LIST_ENTRIES,
  DEFAULT_READ_ONLY_LIMITS,
  type DirectoryEntry,
  type FileSystemReader,
  type ReadOnlyToolLimits,
};

export type ReadOnlyToolsConfig = {
  readonly onImageValidated?: ValidatedImageReferenceSink;
  readonly workspaceRoot: string;
  readonly fileAccess?: FileAccessMode;
  readonly workspaceAlias?: string;
  readonly reader: FileSystemReader;
  readonly limits?: ReadOnlyToolLimits;
  /** Directory names never descended into during `search_text`. */
  readonly excludeDirectories?: ReadonlyArray<string>;
  /**
   * The project rules governing a file, discovered when the file is read
   * (WP-CLI-B1 §3.1). Absent — every caller that has no project rules — means
   * `read_file` attaches nothing and its result is byte for byte what it was
   * before this seam existed.
   */
  readonly localRules?: LocalRuleLookup;
  /**
   * Poppler-backed PDF operations (WP13.1). Absent — every caller without
   * poppler — means page counts read as unknown and page ranges refuse with
   * `unavailable` instead of inventing them.
   */
  readonly pdfRunner?: PdfRunner | undefined;
};

/**
 * Excluded by default so a repository-wide search spends its file budget on
 * source rather than on vendored trees. Callers may override, not append.
 */
export function createReadOnlyTools(input: ReadOnlyToolsConfig): ToolPort {
  // One physical namespace for traversal, ignore rules and relative results.
  // Keep the lexical alias so callers may still name an absolute path through it.
  const root = resolveInsideWorkspace(input.workspaceRoot, ".");
  const alias = input.workspaceAlias ?? (root.ok && path.relative(input.workspaceRoot, root.absolutePath) !== "" ? input.workspaceRoot : undefined);
  const config = root.ok ? { ...input, workspaceRoot: root.absolutePath, ...(alias === undefined ? {} : { workspaceAlias: alias }) } : input;
  const limits = config.limits ?? DEFAULT_READ_ONLY_LIMITS;
  // One finder per tool set, so the index is built once and reused across
  // queries. Built lazily inside `FileFinder` — an unused finder costs nothing,
  // which is what keeps a plain session from enumerating the project.
  const finder = new FileFinder({
    workspaceRoot: config.workspaceRoot,
    reader: config.reader,
    // `src` first: on a repository that also holds vendored reference trees, a
    // flat walk spends the whole index budget on them and never reaches the
    // project's own code. Measured on this repo — see the WP12 evidence note.
    priorityRoots: ["src"],
    ...(config.excludeDirectories === undefined ? {} : { excludeDirectories: config.excludeDirectories }),
  });
  return {
    snapshot() {
      return READ_ONLY_BINDINGS;
    },
    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (signal.aborted) {
        return { outcome: "cancelled" };
      }
      if (call.name === "read_file") {
        return executeReadFile(config, limits, call, signal);
      }
      if (call.name === "list_files") {
        return executeListFiles(config, limits, call, signal);
      }
      if (call.name === "search_text") {
        return executeNavigationSearch(config, limits, call, signal);
      }
      if (call.name === "glob_files") {
        return executeNavigationSearch(config, limits, call, signal);
      }
      if (call.name === "find_files") {
        return executeFindFiles({ finder, limits }, call, signal);
      }
      if (call.name === "view_image") {
        // WP19.1 (C25/L10): validated local images; see view-image.ts.
        return executeViewImage(config, call, signal);
      }
      if (call.name === READ_PDF_TOOL) {
        // WP13.1 (L11): validated PDF metadata and page ranges; see pdf-read.ts.
        return executeReadPdf(
          {
            ...config,
            ...(config.pdfRunner === undefined ? {} : { runner: config.pdfRunner }),
          },
          call,
          signal,
        );
      }
      if (call.name === READ_NOTEBOOK_TOOL) {
        // WP13.2 (L12): cell-aware notebook reads; see notebook-read.ts.
        return executeReadNotebook(
          config,
          limits,
          call,
          signal,
        );
      }
      return { outcome: "error", code: "unknown_tool", message: `unknown_tool:${call.name}` };
    },
    async cancel(_toolCallId: string): Promise<void> {
      // Reads are bounded and abortable through the injected signal; there is
      // nothing to unwind and nothing to compensate.
      return;
    },
  };
}

/**
 * One directory level, as workspace-relative paths.
 *
 * Sorted directories-first then by name, so two listings of one directory read
 * the same way. Excluded names are *counted*, never dropped: a listing that hid
 * `node_modules` without saying so would look like a project with no
 * dependencies — a wrong answer, not a shorter one.
 */
async function executeListFiles(
  config: ReadOnlyToolsConfig,
  limits: ReadOnlyToolLimits,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const requested = directoryArgument(call.arguments, "path");
  const verdict = resolveInsideWorkspace(config.workspaceRoot, requested, config.fileAccess, config.workspaceAlias);
  if (!verdict.ok) {
    return { outcome: "error", code: verdict.code, message: verdict.code };
  }
  let entries: ReadonlyArray<DirectoryEntry>;
  try {
    entries = await config.reader.readDir(verdict.absolutePath);
  } catch (err) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detail = err instanceof Error ? err.message : "list_error";
    return { outcome: "error", code: "list_failed", message: `list_failed:${detail}` };
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const excluded = new Set(config.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const view = createNavigationView({ ...config, workspaceRoot: navigationRoot(config.workspaceRoot, verdict.absolutePath, config.fileAccess),
    ...(!isInside(config.workspaceRoot, verdict.absolutePath) ? { rulesRoot: verdict.absolutePath } : {}), filters: { include: [], exclude: [] } });
  const visible: DirectoryEntry[] = [];
  try {
    for (const entry of entries) {
      if (!excluded.has(entry.name) && await view.visible(`${verdict.absolutePath}/${entry.name}`, entry.isDirectory)) visible.push(entry);
    }
  } catch (error) {
    return { outcome: "error", code: "list_failed", message: `list_failed:${error instanceof Error ? error.message : String(error)}` };
  }
  const hidden = entries.length - visible.length;
  visible.sort(compareDirectoryEntries);
  const cap = limits.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const kept = visible.slice(0, cap);
  const truncated = kept.length < visible.length;
  const paths = kept.map((entry) => `${view.relative(`${verdict.absolutePath}/${entry.name}`)}${entry.isDirectory ? "/" : ""}`);
  return {
    outcome: "result",
    value: {
      path: requested,
      entries: paths,
      entryCount: paths.length,
      hiddenByDefault: hidden,
      truncated,
    },
    output: paths.join("\n"),
    truncated,
  };
}

/** Directories first, then names, case-insensitively. */
function compareDirectoryEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

