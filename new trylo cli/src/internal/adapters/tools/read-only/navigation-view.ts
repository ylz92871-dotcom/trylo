import ignore, { type Ignore } from "ignore";
import path from "node:path";
import type { FileAccessMode } from "../../../ports/tools.js";
import { isInside, resolveInsideWorkspace } from "./workspace.js";
import type { JsonObject } from "../../../protocol/envelope.js";
import { compileGlob } from "./glob-match.js";
import type { FileSystemReader } from "./limits.js";

export const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlyArray<string> = [".git", "node_modules", "dist"];
type GlobMatcher = { matches(value: string): boolean };
type RuleSet = { readonly directory: string; readonly matcher: Ignore };

/** External approved targets need their own relative namespace, never ../ in node-ignore. */
export function navigationRoot(workspaceRoot: string, target: string, access?: FileAccessMode): string {
  return access !== undefined && access !== "workspace" && !isInside(workspaceRoot, target) ? path.dirname(target) : workspaceRoot;
}

export function navigationFilters(args: JsonObject):
  | { readonly include: ReadonlyArray<GlobMatcher>; readonly exclude: ReadonlyArray<GlobMatcher> }
  | { readonly error: string } {
  const filters: { include: GlobMatcher[]; exclude: GlobMatcher[] } = { include: [], exclude: [] };
  for (const key of ["include", "exclude"] as const) {
    const patterns = args[key];
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || !patterns.every(p => typeof p === "string")) return { error: `${key} must be an array of glob strings` };
    for (const pattern of patterns) {
      const compiled = compileGlob(String(pattern));
      if (!compiled.ok) return { error: `${key}: ${compiled.message}` };
      filters[key].push(compiled.matcher);
    }
  }
  return filters;
}

/** Per-operation view. node-ignore owns pattern semantics; the walker only decides descent. */
export function createNavigationView(input: {
  readonly workspaceRoot: string;
  readonly rulesRoot?: string;
  readonly reader: FileSystemReader;
  readonly excludeDirectories?: ReadonlyArray<string>;
  readonly filters: { readonly include: ReadonlyArray<GlobMatcher>; readonly exclude: ReadonlyArray<GlobMatcher> };
}) {
  const excludedNames = new Set(input.excludeDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const memo = new Map<string, Promise<RuleSet | undefined>>();
  const relative = (absolute: string) => path.relative(input.workspaceRoot, absolute).replaceAll("\\", "/");
  function rules(directory: string): Promise<RuleSet | undefined> {
    let pending = memo.get(directory);
    if (pending === undefined) {
      pending = (async () => {
        // Auxiliary reads carry the same authority as the requested target.
        const target = resolveInsideWorkspace(input.rulesRoot ?? input.workspaceRoot, path.join(directory, ".gitignore"));
        const text = !target.ok ? undefined : await input.reader.readOptionalUtf8?.(target.absolutePath);
        return text === undefined ? undefined : { directory, matcher: ignore().add(text) };
      })();
      memo.set(directory, pending);
    }
    return pending;
  }
  async function visible(absolute: string, directory: boolean): Promise<boolean> {
    const segments = relative(absolute).split("/").filter(Boolean);
    // The nesting here is load-bearing and NOT an optimisation target.
    //
    // Each ancestor is tested on its own, and each `.gitignore` is consulted with
    // the path measured *from its own directory* (`slice(i, length)`). That is
    // what lets a nested `!keep.js` revive a file the root `.gitignore` ignored
    // with `src/*.js` — see `navigation.test.ts` "B1 local gitignore works
    // without Git". Collapsing this into one shallow-to-deep pass (measured as a
    // tempting ~2x speedup on a 35k-file repository) silently breaks the revival
    // case: the nested rule can no longer see the path the way its author wrote
    // it. Correctness wins; the enumeration cost is paid knowingly.
    for (let length = 1; length <= segments.length; length += 1) {
      if (excludedNames.has(segments[length - 1] ?? "")) return false;
      let parent = input.workspaceRoot;
      let ignored = false;
      for (let i = 0; i < length; i += 1) {
        const set = await rules(parent);
        if (set !== undefined) {
          const suffix = length < segments.length || directory ? "/" : "";
          const result = set.matcher.test(segments.slice(i, length).join("/") + suffix);
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        parent = path.join(parent, segments[i] ?? "");
      }
      if (ignored) return false;
    }
    return true;
  }
  return {
    relative, visible,
    accepts(absolute: string): boolean {
      const name = relative(absolute);
      return (input.filters.include.length === 0 || input.filters.include.some(m => m.matches(name)))
        && !input.filters.exclude.some(m => m.matches(name));
    },
  };
}
