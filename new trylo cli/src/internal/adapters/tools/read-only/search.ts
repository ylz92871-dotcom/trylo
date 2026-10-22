import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { FileAccessMode, ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import { directoryArgument, readStringArg } from "./args.js";
import { compileGlob } from "./glob-match.js";
import type { FileSystemReader, ReadOnlyToolLimits } from "./limits.js";
import { DEFAULT_MAX_SEARCH_FILE_BYTES } from "./limits.js";
import { readSearchContent, searchSnippet } from "./search-content.js";
import { createNavigationView, navigationFilters, navigationRoot, DEFAULT_EXCLUDED_DIRECTORIES } from "./navigation-view.js";
import { walkWorkspaceFiles } from "./walk.js";
import { isInside, resolveInsideWorkspace } from "./workspace.js";
import { RegexSearch, RegexSearchError } from "./regex-search.js";

type Config = { readonly workspaceRoot: string;
  readonly fileAccess?: FileAccessMode;
  readonly workspaceAlias?: string; readonly reader: FileSystemReader; readonly excludeDirectories?: ReadonlyArray<string> };
type Hit = { readonly path: string; readonly line: number; readonly text: string; readonly absolute: string; readonly textStartColumn?: number; readonly lineTruncated?: true };

function* literalMatches(lines: ReadonlyArray<string>, firstMatch: (line: string) => number, limit: number) {
  let found = 0;
  for (let line = 0; line < lines.length; line += 1) {
    const index = firstMatch(lines[line] ?? "");
    if (index < 0) continue;
    yield { line, index };
    found += 1;
    if (found >= limit) return;
  }
}

function lineMatcher(args: JsonObject): { readonly mode: string; readonly ignoreCase: boolean; firstMatch(line: string): number } | { readonly error: string } {
  const pattern = readStringArg(args, "pattern");
  if (!pattern) return { error: "search_text requires pattern" };
  const mode = args.mode ?? "literal";
  if (mode !== "literal" && mode !== "regex") return { error: 'search_text mode must be "literal" or "regex"' };
  const ignoreCase = args.ignoreCase ?? false;
  if (typeof ignoreCase !== "boolean") return { error: "ignoreCase must be a boolean" };
  if (mode === "literal") {
    if (!ignoreCase) return { mode, ignoreCase, firstMatch: line => line.indexOf(pattern) };
    const expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return { mode, ignoreCase, firstMatch: line => expression.exec(line)?.index ?? -1 };
  }
  return { mode, ignoreCase, firstMatch: () => -1 };
}

/** One canonical workspace path; old matches are derived compatibility views. */
export async function executeNavigationSearch(config: Config, limits: ReadOnlyToolLimits, call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
  const rootArg = directoryArgument(call.arguments, "path");
  const root = resolveInsideWorkspace(config.workspaceRoot, rootArg, config.fileAccess, config.workspaceAlias);
  if (!root.ok) return { outcome: "error", code: root.code, message: root.code };
  const filters = navigationFilters(call.arguments);
  if ("error" in filters) return { outcome: "error", code: "invalid_arguments", message: filters.error };
  const pattern = readStringArg(call.arguments, "pattern");
  if (!pattern) return { outcome: "error", code: "invalid_arguments", message: `${call.name} requires pattern` };
  const glob = call.name === "glob_files" ? compileGlob(pattern) : undefined;
  if (glob !== undefined && !glob.ok) return { outcome: "error", code: glob.code, message: glob.message };
  const matcher = call.name === "search_text" ? lineMatcher(call.arguments) : undefined;
  if (matcher !== undefined && "error" in matcher) {
    return { outcome: "error", code: matcher.error.startsWith("invalid_pattern:") ? "invalid_pattern" : "invalid_arguments", message: matcher.error };
  }
  const view = createNavigationView({ ...config, workspaceRoot: navigationRoot(config.workspaceRoot, root.absolutePath, config.fileAccess),
    ...(!isInside(config.workspaceRoot, root.absolutePath) ? { rulesRoot: root.absolutePath } : {}), filters });
  const hits: Hit[] = [];
  const found: { path: string; relative: string }[] = [];
  let matchLimit = false;
  let unreadableFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  const maxFileBytes = limits.maxSearchFileBytes ?? DEFAULT_MAX_SEARCH_FILE_BYTES;
  let regex: RegexSearch | undefined;
  try {
    if (matcher !== undefined && "mode" in matcher && matcher.mode === "regex") {
      regex = new RegexSearch(pattern, matcher.ignoreCase, signal);
      await regex.ready();
    }
    const stats = await walkWorkspaceFiles({
      reader: config.reader, rootAbsolute: root.absolutePath,
      excludeDirectories: new Set(config.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES),
      maxFiles: limits.maxSearchFiles, maxDepth: limits.maxSearchDepth, signal,
      visible: view.visible,
      accepts: absolute => view.accepts(absolute) && (glob === undefined || !glob.ok || glob.matcher.matches(absolute === root.absolutePath
        ? absolute.split(/[/\\]/).at(-1) ?? absolute
        : absolute.slice(root.absolutePath.length + 1).replaceAll("\\", "/"))),
      async onFile(file) {
        // A directory approval never silently follows a child link elsewhere.
        const scope = config.fileAccess === undefined || config.fileAccess === "workspace" ? config.workspaceRoot : root.absolutePath;
        if (!resolveInsideWorkspace(scope, file.absolute).ok) { unreadableFiles += 1; return true; }
        if (glob !== undefined) { found.push({ path: view.relative(file.absolute), relative: file.relative }); return true; }
        let text: string;
        try {
          const content = await readSearchContent(config.reader, file.absolute, maxFileBytes, signal);
          if (content.kind === "large") { skippedLargeFiles += 1; return true; }
          if (content.kind === "binary") { skippedBinaryFiles += 1; return true; }
          text = content.text;
        } catch {
          unreadableFiles += 1;
          return true;
        }
        const lines = text.split("\n");
        const regexHits = regex === undefined ? undefined : await regex.scan(text, limits.maxSearchMatches - hits.length + 1);
        const matches = regexHits ?? literalMatches(lines,
          matcher !== undefined && "firstMatch" in matcher ? matcher.firstMatch : () => -1, limits.maxSearchMatches - hits.length + 1);
        for (const match of matches) {
          const i = match.line;
          const line = lines[i] ?? "";
          const matchIndex = match.index;
          if (matchIndex >= 0) {
            if (hits.length >= limits.maxSearchMatches) { matchLimit = true; return false; }
            hits.push({ path: view.relative(file.absolute), absolute: file.absolute, line: i + 1, ...searchSnippet(line, matchIndex) });
          }
        }
        return true;
      },
    });
    if (signal.aborted) return { outcome: "cancelled" };
    found.sort((a, b) => a.path.localeCompare(b.path));
    const kept = found.slice(0, limits.maxListEntries ?? 200);
    const reasons = [...stats.truncationReasons, ...(matchLimit || kept.length < found.length ? ["match_limit"] : []), ...(unreadableFiles > 0 ? ["unreadable_file"] : []),
      ...(skippedLargeFiles > 0 ? ["file_size_limit"] : []), ...(skippedBinaryFiles > 0 ? ["binary_file"] : []), ...(hits.some(hit => hit.lineTruncated) ? ["line_truncated"] : [])];
    const searchMode = matcher !== undefined && "mode" in matcher ? { mode: matcher.mode, ignoreCase: matcher.ignoreCase } : undefined;
    const hints = [
      ...(reasons.length > 0 ? ["Narrow path to a module and include to relevant file types; this result does not cover the whole project."] : []),
      ...(skippedLargeFiles > 0 ? [`Files above ${maxFileBytes} bytes were skipped; inspect a named file with read_file or a bounded run_shell command.`] : []),
      ...(hits.some(hit => hit.lineTruncated) ? ["Long lines show a snippet around the match; textStartColumn is 1-based in UTF-16 units. Use read_file at the reported line for source context."] : []),
      ...(hits.length === 0 && searchMode?.mode === "literal" ? ["No literal matches. Regex syntax is treated as text unless mode is explicitly set to regex; use mode: \"regex\" for a regular expression."] : []),
    ];
    const metadata: JsonObject = { path: rootArg, filesScanned: stats.filesScanned, entriesVisited: stats.entriesVisited, truncated: reasons.length > 0, truncationReasons: reasons,
      ...(glob === undefined ? { skippedLargeFiles, skippedBinaryFiles } : {}),
      ...searchMode, ...(hints.length > 0 ? { hint: hints.join(" ") } : {}) };
    const content = glob !== undefined ? kept.map(f => f.path).join("\n") : hits.map(h => `${h.path}:${h.line}:${h.text}`).join("\n");
    const value: JsonObject = glob !== undefined
      ? { ...metadata, pattern, paths: kept.map(f => f.path), matches: kept.map(f => f.relative), matchCount: kept.length }
      : { ...metadata, pattern, mode: matcher !== undefined && "mode" in matcher ? matcher.mode : "literal", ignoreCase: matcher !== undefined && "ignoreCase" in matcher ? matcher.ignoreCase : false,
          hits: hits.map(({ absolute: _absolute, ...hit }): JsonValue => hit), matches: hits.map(h => `${h.absolute}:${h.line}:${h.text}`), matchCount: hits.length };
    return { outcome: "result", value, output: `${JSON.stringify(metadata)}\n${content}`, truncated: reasons.length > 0 };
  } catch (error) {
    if (signal.aborted) return { outcome: "cancelled" };
    if (error instanceof RegexSearchError) return { outcome: "error", code: error.code, message: `${error.code}:${error.message}` };
    return { outcome: "error", code: "search_failed", message: `search_failed:${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (regex !== undefined) await regex.close();
  }
}
