import type { FileSystemReader } from "./limits.js";

export type WalkedFile = { readonly relative: string; readonly absolute: string };

export type WalkStats = {
  readonly filesScanned: number;
  readonly entriesVisited: number;
  readonly truncatedByBudget: boolean;
  readonly truncationReasons: ReadonlyArray<string>;
};

export type WalkParams = {
  readonly reader: FileSystemReader;
  readonly rootAbsolute: string;
  readonly excludeDirectories: ReadonlySet<string>;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly signal: AbortSignal;
  readonly visible?: (absolute: string, directory: boolean) => Promise<boolean>;
  readonly accepts?: (absolute: string) => boolean;
  readonly onFile: (file: WalkedFile) => Promise<boolean> | boolean;
};

/** Enumeration has its own ceiling. Only eligible files consume the content scan budget. */
export async function walkWorkspaceFiles(params: WalkParams): Promise<WalkStats> {
  let filesScanned = 0;
  let entriesVisited = 0;
  let stopped = false;
  const reasons = new Set<string>();

  async function visitFile(absolute: string, relative: string): Promise<void> {
    if (params.accepts !== undefined && !params.accepts(absolute)) return;

    if (filesScanned >= params.maxFiles) {
      reasons.add("file_limit");
      stopped = true;
      return;
    }

    filesScanned += 1;
    stopped = await params.onFile({ absolute, relative }) === false;
  }

  async function visit(dir: string, relative: string, depth: number): Promise<void> {
    if (stopped || params.signal.aborted) return;

    let entries;

    try {
      entries = await params.reader.readDir(dir);
    } catch (error) {
      // A named file is a search target too. Only ENOTDIR establishes that
      // case; missing/inaccessible directories keep their incomplete result.
      if (depth === 0 && error instanceof Error && "code" in error && error.code === "ENOTDIR") {
        try {
          await params.reader.statBytes(dir);
        } catch {
          // ENOTDIR can also mean a nonexistent child below a file. Never
          // advertise that lexical path as an existing glob result.
          reasons.add("unreadable_file");
          return;
        }

        entriesVisited += 1;

        if (params.visible === undefined || await params.visible(dir, false)) {
          await visitFile(dir, dir.split(/[/\\]/).at(-1) ?? dir);
        }

        return;
      }

      // Keep partial results, but do not claim the unreadable subtree was searched.
      reasons.add("unreadable_directory");

      return;
    }

    for (const entry of entries) {
      if (stopped || params.signal.aborted) return;

      entriesVisited += 1;

      if (entriesVisited > 50_000) {
        reasons.add("enumeration_limit");
        stopped = true;
        return;
      }

      if (params.excludeDirectories.has(entry.name)) continue;

      const absolute = `${dir}/${entry.name}`;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (params.visible !== undefined && !await params.visible(absolute, entry.isDirectory)) continue;

      if (entry.isDirectory) {
        if (depth >= params.maxDepth) reasons.add("depth_limit");
        else await visit(absolute, child, depth + 1);
        continue;
      }

      await visitFile(absolute, child);
    }
  }

  await visit(params.rootAbsolute, "", 0);

  return { filesScanned, entriesVisited, truncatedByBudget: reasons.size > 0, truncationReasons: [...reasons] };
}
